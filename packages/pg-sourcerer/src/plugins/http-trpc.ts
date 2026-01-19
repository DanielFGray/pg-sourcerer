/**
 * HTTP tRPC Plugin - Generates tRPC routers from query symbols
 *
 * Consumes "queries" and "schema" capabilities (provider-agnostic).
 * Works with any queries provider (kysely, drizzle, effect-sql, etc.)
 * and any schema provider (zod, arktype, effect, etc.).
 *
 * Uses the SymbolRegistry to resolve query functions and optionally
 * schema symbols for request validation.
 *
 * Imports are resolved via the cross-reference system:
 * - Calls registry.import(queryCapability).ref() during render
 * - Emit phase generates imports from the recorded references
 */
import { Effect, Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";

import type { Plugin, SymbolDeclaration, RenderedSymbol } from "../runtime/types.js";
import { IR } from "../services/ir.js";
import { SymbolRegistry, type SymbolRegistryService } from "../runtime/registry.js";
import { isTableEntity } from "../ir/semantic-ir.js";
import { QueryMethodKind } from "../ir/extensions/queries.js";
import { conjure, cast } from "../conjure/index.js";
import type { QueryMethod, QueryMethodParam, EntityQueriesExtension } from "../ir/extensions/queries.js";
import type { ExternalImport } from "../runtime/emit.js";
import { type FileNaming, normalizeFileNaming } from "../runtime/file-assignment.js";

const b = conjure.b;
const stmt = conjure.stmt;

const PLUGIN_NAME = "trpc-http";

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_OUTPUT_DIR = "";
const DEFAULT_ROUTES_FILE = "trpc.ts";
const DEFAULT_APP_FILE = "trpc.ts";

/**
 * Schema-validated portion of the config (simple types only).
 */
const HttpTrpcConfigSchema = S.Struct({
  outputDir: S.optionalWith(S.String, { default: () => DEFAULT_OUTPUT_DIR }),
  /** Name of the base procedure to use. Default: "publicProcedure" */
  baseProcedure: S.optionalWith(S.String, { default: () => "publicProcedure" }),
  /** Name of the aggregated router export. Default: "appRouter" */
  aggregatorName: S.optionalWith(S.String, { default: () => "appRouter" }),
});

/**
 * Config type for user input.
 */
export interface HttpTrpcConfig {
  outputDir?: string;
  baseProcedure?: string;
  aggregatorName?: string;
  /**
   * Output file for router handlers.
   * Can be a static string or a function receiving FileNamingContext.
   * @example "trpc.ts" - all routers in one file
   * @example ({ entityName }) => `${entityName}/router.ts` - per-entity files
   */
  routesFile?: string | FileNaming;
  /**
   * Output file for the aggregator router.
   * @example "index.ts"
   */
  appFile?: string | FileNaming;
}

/** Resolved config type with normalized FileNaming functions */
interface ResolvedHttpTrpcConfig {
  outputDir: string;
  baseProcedure: string;
  aggregatorName: string;
  routesFile: FileNaming;
  appFile: FileNaming;
}

// ============================================================================
// String Helpers
// ============================================================================

function toCamelCase(str: string): string {
  return str.charAt(0).toLowerCase() + str.slice(1);
}

// ============================================================================
// Procedure Builders
// ============================================================================

/**
 * Map query method kind to tRPC procedure type.
 */
const kindToProcedureType = (kind: QueryMethodKind): "query" | "mutation" => {
  switch (kind) {
    case "read":
    case "list":
    case "lookup":
      return "query";
    case "create":
    case "update":
    case "delete":
    case "function":
      return "mutation";
  }
};

/**
 * Check if a param needs coercion (comes from URL string).
 */
function needsCoercion(param: QueryMethodParam): boolean {
  return (
    param.source === "pk" ||
    param.source === "fk" ||
    param.source === "lookup" ||
    param.source === "pagination"
  );
}

/**
 * Build the handler function body for a tRPC procedure.
 * tRPC handlers receive { input } and return data directly.
 */
function buildProcedureBody(method: QueryMethod): n.Statement[] {
  const callSig = method.callSignature ?? { style: "named" as const };
  const args: n.Expression[] = [];

  if (callSig.style === "positional") {
    // Positional: fn(a, b, c)
    for (const param of method.params) {
      args.push(b.memberExpression(b.identifier("input"), b.identifier(param.name)));
    }
  } else {
    // Named style
    const bodyParam = method.params.find((p) => p.source === "body");

    if (bodyParam && callSig.bodyStyle === "spread") {
      // Body fields spread directly: fn(input)
      args.push(b.identifier("input"));
    } else if (bodyParam && callSig.bodyStyle === "property") {
      // Body wrapped in property: fn({ id, data })
      const nonBodyParams = method.params.filter(
        (p) => p.source === "pk" || p.source === "fk" || p.source === "lookup" || p.source === "pagination",
      );

      if (nonBodyParams.length > 0) {
        // Build object with non-body params + body property
        let objBuilder = conjure.obj();
        for (const param of nonBodyParams) {
          objBuilder = objBuilder.prop(
            param.name,
            b.memberExpression(b.identifier("input"), b.identifier(param.name)),
          );
        }
        objBuilder = objBuilder.prop(
          bodyParam.name,
          b.memberExpression(b.identifier("input"), b.identifier(bodyParam.name)),
        );
        args.push(objBuilder.build());
      } else {
        // No non-body params, just pass input
        args.push(b.identifier("input"));
      }
    } else if (method.params.length > 0) {
      // Simple named params: fn(input) since input matches the shape
      args.push(b.identifier("input"));
    }
  }

  // Build: queryFn(args)
  const queryCall = b.callExpression(b.identifier(method.name), args.map(cast.toExpr));

  // Add the appropriate .execute*() method based on query kind
  const executeMethod =
    method.kind === "read" || (method.kind === "lookup" && method.isUniqueLookup)
      ? "executeTakeFirst"
      : method.kind === "create" || method.kind === "update"
        ? "executeTakeFirstOrThrow"
        : "execute";

  const queryWithExecute = b.callExpression(
    b.memberExpression(queryCall, b.identifier(executeMethod)),
    [],
  );
  const awaitExpr = b.awaitExpression(queryWithExecute);

  // For delete, return success object
  if (method.kind === "delete") {
    return [
      b.expressionStatement(awaitExpr),
      b.returnStatement(conjure.obj().prop("success", b.booleanLiteral(true)).build()),
    ];
  }

  return [b.returnStatement(awaitExpr)];
}

/**
 * Build Zod type expression for a param.
 */
function buildZodParamType(param: QueryMethodParam): n.Expression {
  const baseType = param.type.toLowerCase();

  let zodCall: n.Expression;
  switch (baseType) {
    case "number":
      zodCall = b.callExpression(
        b.memberExpression(
          b.memberExpression(b.identifier("z"), b.identifier("coerce")),
          b.identifier("number"),
        ),
        [],
      );
      break;
    case "boolean":
      zodCall = b.callExpression(
        b.memberExpression(b.identifier("z"), b.identifier("boolean")),
        [],
      );
      break;
    case "date":
      zodCall = b.callExpression(
        b.memberExpression(
          b.memberExpression(b.identifier("z"), b.identifier("coerce")),
          b.identifier("date"),
        ),
        [],
      );
      break;
    case "string":
    default:
      zodCall = b.callExpression(
        b.memberExpression(b.identifier("z"), b.identifier("string")),
        [],
      );
      break;
  }

  if (!param.required) {
    zodCall = b.callExpression(
      b.memberExpression(cast.toExpr(zodCall), b.identifier("optional")),
      [],
    );
  }

  return zodCall;
}

/**
 * Get the body schema name for a method if it needs validation.
 */
function getBodySchemaName(method: QueryMethod, entityName: string): string | null {
  if (method.kind === "create") {
    return `${entityName}Insert`;
  }
  if (method.kind === "update") {
    return `${entityName}Update`;
  }
  return null;
}

/**
 * Build input schema expression for a procedure.
 * Returns the schema expression and whether we need z import.
 */
function buildInputSchema(
  method: QueryMethod,
  entityName: string,
): {
  inputExpr: n.Expression | null;
  bodySchemaName: string | null;
  needsZodImport: boolean;
} {
  const bodySchemaName = getBodySchemaName(method, entityName);
  const nonBodyParams = method.params.filter((p) => p.source !== "body");
  const callSig = method.callSignature ?? { style: "named" as const };

  // For update with bodyStyle: "property", merge PK params with body schema
  if (bodySchemaName && nonBodyParams.length > 0 && callSig.bodyStyle === "property") {
    let objBuilder = conjure.obj();
    for (const p of nonBodyParams) {
      objBuilder = objBuilder.prop(p.name, buildZodParamType(p));
    }
    const zodObject = b.callExpression(
      b.memberExpression(b.identifier("z"), b.identifier("object")),
      [cast.toExpr(objBuilder.build())],
    );
    const mergedSchema = b.callExpression(
      b.memberExpression(zodObject, b.identifier("merge")),
      [b.identifier(bodySchemaName)],
    );
    return {
      inputExpr: mergedSchema,
      bodySchemaName,
      needsZodImport: true,
    };
  }

  // Body params only use imported entity schemas
  if (bodySchemaName) {
    return {
      inputExpr: b.identifier(bodySchemaName),
      bodySchemaName,
      needsZodImport: false,
    };
  }

  // Non-body params: build inline z.object
  if (nonBodyParams.length === 0) {
    return { inputExpr: null, bodySchemaName: null, needsZodImport: false };
  }

  let objBuilder = conjure.obj();
  for (const param of nonBodyParams) {
    const zodType = buildZodParamType(param);
    objBuilder = objBuilder.prop(param.name, zodType);
  }

  return {
    inputExpr: b.callExpression(
      b.memberExpression(b.identifier("z"), b.identifier("object")),
      [cast.toExpr(objBuilder.build())],
    ),
    bodySchemaName: null,
    needsZodImport: true,
  };
}

/**
 * Build a single tRPC procedure expression.
 */
function buildProcedure(
  method: QueryMethod,
  entityName: string,
  baseProcedure: string,
): {
  procedureExpr: n.Expression;
  bodySchemaName: string | null;
  needsZodImport: boolean;
} {
  const procedureType = kindToProcedureType(method.kind);

  // Start with base procedure
  let chainExpr: n.Expression = b.identifier(baseProcedure);

  // Build input schema
  const { inputExpr, bodySchemaName, needsZodImport } = buildInputSchema(method, entityName);

  // Add .input(schema) if there are params
  if (inputExpr) {
    chainExpr = b.callExpression(
      b.memberExpression(cast.toExpr(chainExpr), b.identifier("input")),
      [cast.toExpr(inputExpr)],
    );
  }

  // Build the handler: async ({ input }) => { ... }
  const handlerParams: n.ObjectProperty[] = [];
  if (method.params.length > 0) {
    const inputProp = b.objectProperty(b.identifier("input"), b.identifier("input"));
    inputProp.shorthand = true;
    handlerParams.push(inputProp);
  }

  const handlerBody = buildProcedureBody(method);
  const handler = b.arrowFunctionExpression(
    [b.objectPattern(handlerParams)],
    b.blockStatement(handlerBody.map(cast.toStmt)),
  );
  handler.async = true;

  // Add .query() or .mutation()
  chainExpr = b.callExpression(
    b.memberExpression(cast.toExpr(chainExpr), b.identifier(procedureType)),
    [handler],
  );

  return { procedureExpr: chainExpr, bodySchemaName, needsZodImport };
}

/**
 * Get the capability suffix for a query method.
 */
function getMethodCapabilitySuffix(method: QueryMethod): string {
  switch (method.kind) {
    case "read":
      return "findById";
    case "list":
      return "list";
    case "create":
      return "create";
    case "update":
      return "update";
    case "delete":
      return "delete";
    case "lookup":
      if (method.lookupField) {
        const pascalField = method.lookupField
          .split("_")
          .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
          .join("");
        return `findBy${pascalField}`;
      }
      return "lookup";
    case "function":
      return method.name;
  }
}

/**
 * Generate tRPC router for an entity.
 */
function generateTrpcRouter(
  entityName: string,
  queries: EntityQueriesExtension,
  config: ResolvedHttpTrpcConfig,
  registry: SymbolRegistryService,
): {
  statements: n.Statement[];
  externalImports: ExternalImport[];
} {
  const routerName = `${toCamelCase(entityName)}Router`;
  let needsZodImport = false;
  const bodySchemaNames: string[] = [];

  // Build router object
  let routerObjBuilder = conjure.obj();

  for (const method of queries.methods) {
    // Record cross-reference for this query method
    const methodCapability = `queries:${entityName}:${getMethodCapabilitySuffix(method)}`;
    if (registry.has(methodCapability)) {
      registry.import(methodCapability).ref();
    }

    const { procedureExpr, bodySchemaName, needsZodImport: methodNeedsZod } = buildProcedure(
      method,
      entityName,
      config.baseProcedure,
    );

    if (bodySchemaName && !bodySchemaNames.includes(bodySchemaName)) {
      bodySchemaNames.push(bodySchemaName);
      // Import schema via cross-reference system
      const schemaCapability = `schema:${bodySchemaName}`;
      if (registry.has(schemaCapability)) {
        registry.import(schemaCapability).ref();
      }
    }

    if (methodNeedsZod) needsZodImport = true;

    routerObjBuilder = routerObjBuilder.prop(method.name, procedureExpr);
  }

  // Build: export const userRouter = router({ ... })
  const routerCall = b.callExpression(b.identifier("router"), [cast.toExpr(routerObjBuilder.build())]);
  const variableDeclarator = b.variableDeclarator(b.identifier(routerName), cast.toExpr(routerCall));
  const variableDeclaration = b.variableDeclaration("const", [variableDeclarator]);

  const externalImports: ExternalImport[] = [];

  if (needsZodImport) {
    externalImports.push({ from: "zod", names: ["z"] });
  }

  return {
    statements: [variableDeclaration as n.Statement],
    externalImports,
  };
}

/**
 * Generate aggregator router that combines all entity routers.
 */
function generateAggregator(
  entities: Map<string, EntityQueriesExtension>,
  config: ResolvedHttpTrpcConfig,
  registry: SymbolRegistryService,
): {
  statements: n.Statement[];
  externalImports: ExternalImport[];
} {
  const entityEntries = Array.from(entities.entries());

  if (entityEntries.length === 0) {
    return { statements: [], externalImports: [] };
  }

  // Build: router({ user: userRouter, post: postRouter, ... })
  let routerObjBuilder = conjure.obj();

  for (const [entityName] of entityEntries) {
    const routerName = `${toCamelCase(entityName)}Router`;
    const key = toCamelCase(entityName);

    routerObjBuilder = routerObjBuilder.prop(key, b.identifier(routerName));

    // Record cross-reference to the entity's router capability
    const routeCapability = `http-routes:trpc:${entityName}`;
    if (registry.has(routeCapability)) {
      registry.import(routeCapability).ref();
    }
  }

  const routerCall = b.callExpression(b.identifier("router"), [cast.toExpr(routerObjBuilder.build())]);
  const variableDeclarator = b.variableDeclarator(
    b.identifier(config.aggregatorName),
    cast.toExpr(routerCall),
  );
  const variableDeclaration = b.variableDeclaration("const", [variableDeclarator]);

  // Also export the type: export type AppRouter = typeof appRouter
  const typeExport = b.exportNamedDeclaration(
    b.tsTypeAliasDeclaration(
      b.identifier("AppRouter"),
      b.tsTypeQuery(b.identifier(config.aggregatorName)),
    ),
  );

  return {
    statements: [variableDeclaration as n.Statement, typeExport as n.Statement],
    externalImports: [],
  };
}

// ============================================================================
// Plugin Definition
// ============================================================================

/**
 * Create an http-trpc plugin that generates tRPC routers.
 *
 * @example
 * ```typescript
 * import { trpc } from "pg-sourcerer"
 *
 * export default defineConfig({
 *   plugins: [
 *     zod(),
 *     kyselyQueries(),
 *     trpc({
 *       baseProcedure: "publicProcedure",
 *     }),
 *   ],
 * })
 * ```
 */
export function trpc(config?: HttpTrpcConfig): Plugin {
  const schemaConfig = S.decodeSync(HttpTrpcConfigSchema)(config ?? {});

  const resolvedConfig: ResolvedHttpTrpcConfig = {
    outputDir: schemaConfig.outputDir,
    baseProcedure: schemaConfig.baseProcedure,
    aggregatorName: schemaConfig.aggregatorName,
    routesFile: normalizeFileNaming(config?.routesFile, DEFAULT_ROUTES_FILE),
    appFile: normalizeFileNaming(config?.appFile, DEFAULT_APP_FILE),
  };

  return {
    name: PLUGIN_NAME,

    provides: [],

    fileDefaults: [
      // Entity routers use routesFile config
      {
        pattern: "http-routes:trpc:",
        outputDir: resolvedConfig.outputDir,
        fileNaming: resolvedConfig.routesFile,
      },
      // App aggregator uses appFile config (more specific pattern wins)
      {
        pattern: "http-routes:trpc:app",
        outputDir: resolvedConfig.outputDir,
        fileNaming: resolvedConfig.appFile,
      },
    ],

    declare: Effect.gen(function* () {
      const ir = yield* IR;

      const declarations: SymbolDeclaration[] = [];

      // Declare routers for all table entities that might have queries
      for (const entity of ir.entities.values()) {
        if (!isTableEntity(entity)) continue;
        if (entity.tags.omit === true) continue;

        const hasAnyPermissions =
          entity.permissions.canSelect ||
          entity.permissions.canInsert ||
          entity.permissions.canUpdate ||
          entity.permissions.canDelete;

        if (hasAnyPermissions) {
          declarations.push({
            name: `${toCamelCase(entity.name)}Router`,
            capability: `http-routes:trpc:${entity.name}`,
            baseEntityName: entity.name,
          });
        }
      }

      // Also declare the aggregator
      declarations.push({
        name: resolvedConfig.aggregatorName,
        capability: "http-routes:trpc:app",
      });

      return declarations;
    }),

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const registry = yield* SymbolRegistry;

      const rendered: RenderedSymbol[] = [];

      // Query the registry for all entity query capabilities
      const entityQueries = new Map<string, EntityQueriesExtension>();
      const queryCapabilities = registry.query("queries:");

      for (const decl of queryCapabilities) {
        // Only look at aggregate capabilities (queries:impl:EntityName, not queries:impl:EntityName:method)
        const parts = decl.capability.split(":");
        if (parts.length !== 3) continue;

        const entityName = parts[2]!;
        const metadata = registry.getMetadata(decl.capability);
        if (metadata && typeof metadata === "object" && "methods" in metadata) {
          entityQueries.set(entityName, metadata as EntityQueriesExtension);
        }
      }

      for (const [entityName, queries] of entityQueries) {
        const entity = ir.entities.get(entityName);
        if (!entity || !isTableEntity(entity)) continue;

        const capability = `http-routes:trpc:${entityName}`;

        // Scope cross-references to this specific capability
        const { statements, externalImports } = registry.forSymbol(capability, () =>
          generateTrpcRouter(entityName, queries, resolvedConfig, registry),
        );

        rendered.push({
          name: `${toCamelCase(entityName)}Router`,
          capability,
          node: statements[0],
          exports: "named",
          externalImports,
        });
      }

      if (entityQueries.size > 0) {
        const appCapability = "http-routes:trpc:app";

        // Scope cross-references to the app capability
        const { statements, externalImports } = registry.forSymbol(appCapability, () =>
          generateAggregator(entityQueries, resolvedConfig, registry),
        );

        // The aggregator has multiple statements (const + type export)
        // We need to handle this differently - wrap in a program or return multiple
        rendered.push({
          name: resolvedConfig.aggregatorName,
          capability: appCapability,
          node: statements[0], // The const declaration
          exports: "named",
          externalImports,
        });

        // Add the type export as a separate rendered symbol
        if (statements[1]) {
          rendered.push({
            name: "AppRouter",
            capability: "http-routes:trpc:app:type",
            node: statements[1],
            exports: false, // Already has export in the node
          });
        }
      }

      return rendered;
    }),
  };
}

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

import type { Plugin, SymbolDeclaration, SymbolHandle } from "../runtime/types.js";
import { IR } from "../services/ir.js";
import { Inflection, type CoreInflection } from "../services/inflection.js";
import { SymbolRegistry, type SymbolRegistryService } from "../runtime/registry.js";
import { isTableEntity } from "../ir/semantic-ir.js";
import { QueryMethodKind } from "../ir/extensions/queries.js";
import { conjure, cast } from "../conjure/index.js";
import type { QueryMethod, QueryMethodParam, EntityQueriesExtension } from "../ir/extensions/queries.js";
import type {
  SchemaBuilder,
  SchemaBuilderResult,
  SchemaImportSpec,
} from "../ir/extensions/schema-builder.js";
import type { ExternalImport, RenderedSymbolWithImports } from "../runtime/emit.js";
import { type FileNaming, normalizeFileNaming } from "../runtime/file-assignment.js";
import { type UserModuleRef } from "../user-module.js";

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
   * Import for tRPC router and procedure.
   * Use userModule() helper to specify the path relative to your config file.
   *
   * @example
   * ```typescript
   * import { userModule } from "pg-sourcerer";
   *
   * trpc({
   *   trpcImport: userModule("./trpc.ts", { named: ["router", "publicProcedure"] }),
   * })
   * ```
   */
  trpcImport?: UserModuleRef;
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
  trpcImport?: UserModuleRef;
}

// ============================================================================
// String Helpers - removed, now using inflection service:
// - inflection.variableName(entity, "Router") for router variable names
// - inflection.camelCase(entity) for merged router keys
// - inflection.pascalCase(field) for lookup field suffix
// ============================================================================

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

function toExternalImport(spec: SchemaImportSpec): ExternalImport {
  return {
    from: spec.from,
    names: spec.names,
    namespace: spec.namespace,
  };
}

function buildQueryInvocation(handle: SymbolHandle, args: n.Expression[]): n.Expression {
  if (handle.consume && args.length <= 1) {
    const input = args.length === 0 ? undefined : args[0];
    return handle.consume(input as unknown) as n.Expression;
  }
  return handle.call(...args) as n.Expression;
}

/**
 * Build the handler function body for a tRPC procedure.
 * tRPC handlers receive { input } and return data directly.
 */
type ConsumeFn = (input: n.Expression) => n.Expression;

interface ProcedureSchemas {
  readonly paramSchema?: SchemaBuilderResult;
  readonly bodyConsume?: ConsumeFn;
  readonly bodySource?: n.Expression;
  readonly queryHandle: SymbolHandle;
}

function buildProcedureBody(method: QueryMethod, schemas: ProcedureSchemas): n.Statement[] {
  const callSig = method.callSignature ?? { style: "named" as const };
  const args: n.Expression[] = [];
  const statements: n.Statement[] = [];
  const paramConsume = schemas.paramSchema?.consume;
  const bodyConsume = schemas.bodyConsume;
  const bodySource = schemas.bodySource ?? b.identifier("input");

  if (paramConsume) {
    statements.push(stmt.const("params", paramConsume(b.identifier("input"))));
  }

  if (bodyConsume) {
    statements.push(stmt.const("body", bodyConsume(bodySource)));
  }

  const paramExpr = (param: QueryMethodParam): n.Expression => {
    if (param.source === "body") {
      return bodyConsume ? b.identifier("body") : bodySource;
    }

    if (paramConsume) {
      return b.memberExpression(b.identifier("params"), b.identifier(param.name));
    }

    return b.memberExpression(b.identifier("input"), b.identifier(param.name));
  };

  if (callSig.style === "positional") {
    // Positional: fn(a, b, c)
    for (const param of method.params) {
      args.push(paramExpr(param));
    }
  } else {
    // Named style
    const bodyParam = method.params.find((p) => p.source === "body");
    const nonBodyParams = method.params.filter((p) => p.source && p.source !== "body");

    if (bodyParam && callSig.bodyStyle === "spread") {
      // Body fields spread directly: fn(input)
      if (nonBodyParams.length > 0) {
        let objBuilder = conjure.obj();
        for (const param of nonBodyParams) {
          objBuilder = objBuilder.prop(param.name, paramExpr(param));
        }
        objBuilder = objBuilder.spread(bodyConsume ? b.identifier("body") : bodySource);
        args.push(objBuilder.build());
      } else {
        args.push(bodyConsume ? b.identifier("body") : bodySource);
      }
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
            paramExpr(param),
          );
        }
        objBuilder = objBuilder.prop(
          bodyParam.name,
          bodyConsume ? b.identifier("body") : bodySource,
        );
        args.push(objBuilder.build());
      } else {
        // No non-body params, just pass input
        args.push(bodyConsume ? b.identifier("body") : bodySource);
      }
    } else if (method.params.length > 0) {
      // Simple named params: fn(input) since input matches the shape
      args.push(b.identifier("input"));
    }
  }

  const queryCall = buildQueryInvocation(schemas.queryHandle, args);
  const awaitExpr = b.awaitExpression(cast.toExpr(queryCall));

  // For delete, return success object
  if (method.kind === "delete") {
    return [
      ...statements,
      b.expressionStatement(awaitExpr),
      b.returnStatement(conjure.obj().prop("success", b.booleanLiteral(true)).build()),
    ];
  }

  return [...statements, b.returnStatement(awaitExpr)];
}

/**
 * Build Zod type expression for a param.
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

function getSchemaBuilder(registry: SymbolRegistryService): SchemaBuilder | undefined {
  const schemaBuilders = registry.query("schema:").filter(decl => decl.capability.endsWith(":builder"));
  if (schemaBuilders.length === 0) return undefined;

  const metadata = registry.getMetadata(schemaBuilders[0]!.capability);
  if (metadata && typeof metadata === "object" && "builder" in metadata) {
    return (metadata as { builder: SchemaBuilder }).builder;
  }
  return undefined;
}

function getBodySource(method: QueryMethod): n.Expression {
  const bodyParam = method.params.find((p) => p.source === "body");
  if (!bodyParam) return b.identifier("input");

  const callSig = method.callSignature ?? { style: "named" as const };
  if (callSig.bodyStyle === "property") {
    return b.memberExpression(b.identifier("input"), b.identifier(bodyParam.name));
  }

  return b.identifier("input");
}

/**
 * Build a single tRPC procedure expression.
 */
function buildProcedure(
  method: QueryMethod,
  entityName: string,
  baseProcedure: string,
  registry: SymbolRegistryService,
  schemaBuilder: SchemaBuilder | undefined,
  queryHandle: SymbolHandle,
): {
  procedureExpr: n.Expression;
  bodySchemaName: string | null;
  externalImports: ExternalImport[];
} {
  const procedureType = kindToProcedureType(method.kind);

  // Start with base procedure
  let chainExpr: n.Expression = b.identifier(baseProcedure);

  const externalImports: ExternalImport[] = [];
  const bodySchemaName = getBodySchemaName(method, entityName);
  const bodySchema =
    bodySchemaName && registry.has(`schema:${bodySchemaName}`)
      ? registry.import(`schema:${bodySchemaName}`)
      : undefined;
  const bodyConsume = bodySchema?.consume
    ? (input: n.Expression) => bodySchema.consume!(input) as n.Expression
    : undefined;

  const nonBodyParams = method.params.filter((p) => p.source !== "body");
  const paramSchema =
    schemaBuilder && nonBodyParams.length > 0
      ? schemaBuilder.build({ variant: "params", params: nonBodyParams })
      : undefined;

  if (paramSchema) {
    externalImports.push(toExternalImport(paramSchema.importSpec));
  }

  const hasBody = method.params.some((p) => p.source === "body");
  const shouldUseInputSchema = !hasBody && paramSchema;

  if (shouldUseInputSchema) {
    chainExpr = b.callExpression(
      b.memberExpression(cast.toExpr(chainExpr), b.identifier("input")),
      [cast.toExpr(paramSchema!.ast)],
    );
  }

  // Build the handler: async ({ input }) => { ... }
  const handlerParams: n.ObjectProperty[] = [];
  if (method.params.length > 0) {
    const inputProp = b.objectProperty(b.identifier("input"), b.identifier("input"));
    inputProp.shorthand = true;
    handlerParams.push(inputProp);
  }

  const handlerBody = buildProcedureBody(method, {
    paramSchema: hasBody ? paramSchema : undefined,
    bodyConsume,
    bodySource: getBodySource(method),
    queryHandle,
  });
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

  return { procedureExpr: chainExpr, bodySchemaName, externalImports };
}

/**
 * Get the capability suffix for a query method.
 */
function getMethodCapabilitySuffix(
  method: QueryMethod,
  entityName: string,
  inflection: CoreInflection,
): string {
  switch (method.kind) {
    case "read":
      return "findById";
    case "list":
      const prefix = inflection.variableName(entityName, "");
      if (method.name.startsWith(prefix)) {
        const remainder = method.name.slice(prefix.length);
        if (remainder.startsWith("ListBy")) {
          const suffix = remainder.slice("ListBy".length);
          if (suffix.length > 0) {
            return `listBy${suffix}`;
          }
        }
      }
      return "list";
    case "create":
      return "create";
    case "update":
      return "update";
    case "delete":
      return "delete";
    case "lookup":
      if (method.lookupField) {
        const pascalField = inflection.pascalCase(method.lookupField);
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
  inflection: CoreInflection,
): {
  statements: n.Statement[];
  externalImports: ExternalImport[];
} {
  const routerName = inflection.variableName(entityName, "Router");
  const schemaImports: ExternalImport[] = [];
  const schemaBuilder = getSchemaBuilder(registry);
  const bodySchemaNames: string[] = [];

  // Build router object
  let routerObjBuilder = conjure.obj();

  for (const method of queries.methods) {
    // Record cross-reference for this query method
    const methodCapability = `queries:${entityName}:${getMethodCapabilitySuffix(
      method,
      entityName,
      inflection,
    )}`;
    const queryHandle = registry.import(methodCapability);

    const { procedureExpr, bodySchemaName, externalImports } = buildProcedure(
      method,
      entityName,
      config.baseProcedure,
      registry,
      schemaBuilder,
      queryHandle,
    );

    if (bodySchemaName && !bodySchemaNames.includes(bodySchemaName)) {
      bodySchemaNames.push(bodySchemaName);
      // Import schema via cross-reference system
      const schemaCapability = `schema:${bodySchemaName}`;
      if (registry.has(schemaCapability)) {
        registry.import(schemaCapability).ref();
      }
    }

    schemaImports.push(...externalImports);

    routerObjBuilder = routerObjBuilder.prop(method.name, procedureExpr);
  }

  // Build: export const userRouter = router({ ... })
  const routerCall = b.callExpression(b.identifier("router"), [cast.toExpr(routerObjBuilder.build())]);
  const variableDeclarator = b.variableDeclarator(b.identifier(routerName), cast.toExpr(routerCall));
  const variableDeclaration = b.variableDeclaration("const", [variableDeclarator]);

  const externalImports: ExternalImport[] = schemaImports;

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
  inflection: CoreInflection,
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
  const routerName = inflection.variableName(entityName, "Router");
    const key = inflection.camelCase(entityName);

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
    trpcImport: config?.trpcImport,
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
      const inflection = yield* Inflection;

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
            name: inflection.variableName(entity.name, "Router"),
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
      const inflection = yield* Inflection;

      const rendered: RenderedSymbolWithImports[] = [];

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

      // User module imports for router and procedure (if configured)
      const trpcUserImports: readonly UserModuleRef[] | undefined = resolvedConfig.trpcImport
        ? [resolvedConfig.trpcImport]
        : undefined;

      for (const [entityName, queries] of entityQueries) {
        const entity = ir.entities.get(entityName);
        if (!entity || !isTableEntity(entity)) continue;

        const capability = `http-routes:trpc:${entityName}`;

        // Scope cross-references to this specific capability
        const { statements, externalImports } = registry.forSymbol(capability, () =>
          generateTrpcRouter(entityName, queries, resolvedConfig, registry, inflection),
        );

        rendered.push({
          name: inflection.variableName(entityName, "Router"),
          capability,
          node: statements[0],
          exports: "named",
          externalImports,
          userImports: trpcUserImports,
        });
      }

      if (entityQueries.size > 0) {
        const appCapability = "http-routes:trpc:app";

        // Scope cross-references to the app capability
        const { statements, externalImports } = registry.forSymbol(appCapability, () =>
          generateAggregator(entityQueries, resolvedConfig, registry, inflection),
        );

        // The aggregator has multiple statements (const + type export)
        // We need to handle this differently - wrap in a program or return multiple
        rendered.push({
          name: resolvedConfig.aggregatorName,
          capability: appCapability,
          node: statements[0], // The const declaration
          exports: "named",
          externalImports,
          userImports: trpcUserImports,
        });

        // Add the type export as a separate rendered symbol
        if (statements[1]) {
          rendered.push({
            name: "AppRouter",
            capability: "http-routes:trpc:app:type",
            node: statements[1],
            exports: false, // Already has export in the node
            // No userImports needed for type export
          });
        }
      }

      return rendered;
    }),
  };
}

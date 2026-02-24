/**
 * HTTP oRPC Plugin - Generates oRPC routers from query symbols
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
import { Effect, Schema as S, pipe } from "effect";
import type { namedTypes as n } from "ast-types";

import type { Plugin, SymbolHandle } from "../runtime/types.js";
import { IR } from "../services/ir.js";
import { IRExtensions } from "../services/ir-extensions.js";
import { Inflection, type CoreInflection } from "../services/inflection.js";
import { SymbolRegistry, type SymbolRegistryService } from "../runtime/registry.js";
import { Conjure } from "../services/conjure.js";
import { isTableEntity } from "../ir/semantic-ir.js";
import { conjure, cast } from "../conjure/index.js";
import type {
  QueryMethod,
  QueryMethodParam,
  EntityQueriesExtension,
} from "../ir/extensions/queries.js";
import { SCHEMA_BUILDER_KEY, type SchemaBuilder, type SchemaBuilderResult } from "../ir/extensions/schema-builder.js";
import type { ExternalImport } from "../runtime/emit.js";
import { type FileNaming, normalizeFileNaming } from "../runtime/file-assignment.js";
import { type UserModuleRef } from "../user-module.js";
import {
  buildEntityQueriesMap,
  buildQueryInvocation,
  getBodySchemaName,
  getHttpEligibleEntities,
  getMethodCapabilitySuffix,
  toExternalImport,
} from "./shared/http-helpers.js";

const b = conjure.b;
const stmt = conjure.stmt;

const PLUGIN_NAME = "orpc-http";

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_OUTPUT_DIR = "";
const DEFAULT_ROUTES_FILE = "orpc.ts";
const DEFAULT_APP_FILE = "orpc.ts";

/**
 * Schema-validated portion of the config (simple types only).
 */
const HttpOrpcConfigSchema = S.Struct({
  outputDir: S.optionalWith(S.String, { default: () => DEFAULT_OUTPUT_DIR }),
  /** Name of the aggregated router export. Default: "appRouter" */
  aggregatorName: S.optionalWith(S.String, { default: () => "appRouter" }),
});

/**
 * Config type for user input.
 */
export interface HttpOrpcConfig {
  outputDir?: string;
  aggregatorName?: string;
  /**
   * Import for oRPC builder (`os`).
   * Use userModule() helper to specify the path relative to your config file.
   *
   * @example
   * ```typescript
   * import { userModule } from "pg-sourcerer";
   *
   * orpc({
   *   orpcImport: userModule("./orpc.ts", { named: ["os"] }),
   * })
   * ```
   */
  orpcImport?: UserModuleRef;
  /**
   * Output file for router procedures.
   * Can be a static string or a function receiving FileNamingContext.
   * @example "orpc.ts" - all routers in one file
   * @example ({ entityName }) => `${entityName}/orpc.ts` - per-entity files
   */
  routesFile?: string | FileNaming;
  /**
   * Output file for the aggregator router.
   * @example "index.ts"
   */
  appFile?: string | FileNaming;
}

/** Resolved config type with normalized FileNaming functions */
interface ResolvedHttpOrpcConfig {
  outputDir: string;
  aggregatorName: string;
  routesFile: FileNaming;
  appFile: FileNaming;
  orpcImport?: UserModuleRef;
}

// ============================================================================
// Procedure Builders
// ============================================================================

type ConsumeFn = (input: n.Expression) => n.Expression;

interface ProcedureSchemas {
  readonly paramSchema?: SchemaBuilderResult;
  readonly bodyConsume?: ConsumeFn;
  readonly bodySource?: n.Expression;
  readonly queryHandle: SymbolHandle;
}

/**
 * Build the handler function body for an oRPC procedure.
 * oRPC handlers receive { input } and return data directly.
 */
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
    args.push(...method.params.map(paramExpr));
  } else {
    // Named style
    const bodyParam = method.params.find(p => p.source === "body");
    const nonBodyParams = method.params.filter(p => p.source && p.source !== "body");

    if (bodyParam && callSig.bodyStyle === "spread") {
      // Body fields spread directly: fn(input)
      if (nonBodyParams.length > 0) {
        const objBuilder = nonBodyParams
          .reduce((obj, param) => obj.prop(param.name, paramExpr(param)), conjure.obj())
          .spread(bodyConsume ? b.identifier("body") : bodySource);
        args.push(objBuilder.build());
      } else {
        args.push(bodyConsume ? b.identifier("body") : bodySource);
      }
    } else if (bodyParam && callSig.bodyStyle === "property") {
      // Body wrapped in property: fn({ id, data })
      const propertyParams = method.params.filter(
        p =>
          p.source === "pk" ||
          p.source === "fk" ||
          p.source === "lookup" ||
          p.source === "pagination",
      );

      if (propertyParams.length > 0) {
        // Build object with non-body params + body property
        const objBuilder = propertyParams
          .reduce((obj, param) => obj.prop(param.name, paramExpr(param)), conjure.obj())
          .prop(bodyParam.name, bodyConsume ? b.identifier("body") : bodySource);
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
 * Get the body schema name for a method if it needs validation.
 */
/**
 * Build input schema expression for a procedure.
 * Returns the schema expression and whether we need z import.
 */
function getBodySource(method: QueryMethod): n.Expression {
  const bodyParam = method.params.find(p => p.source === "body");
  if (!bodyParam) return b.identifier("input");

  const callSig = method.callSignature ?? { style: "named" as const };
  if (callSig.bodyStyle === "property") {
    return b.memberExpression(b.identifier("input"), b.identifier(bodyParam.name));
  }

  return b.identifier("input");
}

/**
 * Build a single oRPC procedure expression.
 */
function buildProcedure(
  method: QueryMethod,
  entityName: string,
  registry: SymbolRegistryService,
  schemaBuilder: SchemaBuilder | undefined,
  queryHandle: SymbolHandle,
): {
  procedureExpr: n.Expression;
  bodySchemaName: string | null;
  imports: ExternalImport[];
} {
  const bodySchemaName = getBodySchemaName(method, entityName);
  const bodySchema =
    bodySchemaName && registry.has(`schema:${bodySchemaName}`)
      ? registry.import(`schema:${bodySchemaName}`)
      : undefined;
  const bodyConsume = bodySchema?.consume
    ? (input: n.Expression) => bodySchema.consume!(input) as n.Expression
    : undefined;

  const nonBodyParams = method.params.filter(p => p.source !== "body");
  const paramSchema =
    schemaBuilder && nonBodyParams.length > 0
      ? schemaBuilder.build({ variant: "params", params: nonBodyParams })
      : undefined;

  const imports: ExternalImport[] = paramSchema ? [toExternalImport(paramSchema.importSpec)] : [];

  const hasBody = method.params.some(p => p.source === "body");
  const shouldUseInputSchema = !hasBody && paramSchema;

  // Build the handler: async ({ input }) => { ... }
  const handlerParams: n.ObjectProperty[] =
    method.params.length > 0
      ? [
          pipe(
            b.objectProperty(b.identifier("input"), b.identifier("input")),
            prop => {
              prop.shorthand = true;
              return prop;
            },
          ),
        ]
      : [];

  const handlerBody = buildProcedureBody(method, {
    paramSchema: hasBody ? paramSchema : undefined,
    bodyConsume,
    bodySource: getBodySource(method),
    queryHandle,
  });
  const handler = pipe(
    b.arrowFunctionExpression(
      [b.objectPattern(handlerParams)],
      b.blockStatement(handlerBody.map(cast.toStmt)),
    ),
    fn => {
      fn.async = true;
      return fn;
    },
  );

  // Build the procedure chain: os -> .input(schema)? -> .handler(fn)
  const baseExpr = b.identifier("os");

  const withInputExpr = shouldUseInputSchema
    ? b.callExpression(b.memberExpression(baseExpr, b.identifier("input")), [
        cast.toExpr(paramSchema!.ast),
      ])
    : baseExpr;

  const procedureExpr = b.callExpression(
    b.memberExpression(withInputExpr, b.identifier("handler")),
    [handler],
  );

  return { procedureExpr, bodySchemaName, imports };
}


/**
 * Generate oRPC router for an entity.
 * Returns the init expression for the router variable (not the full statement).
 */
function generateOrpcRouter(
  entityName: string,
  queries: EntityQueriesExtension,
  config: ResolvedHttpOrpcConfig,
  registry: SymbolRegistryService,
  inflection: CoreInflection,
  schemaBuilder: SchemaBuilder | undefined,
): {
  initExpr: n.Expression;
  imports: ExternalImport[];
} {
  const { routerObjBuilder, schemaImports, bodySchemaNames } = queries.methods.reduce(
    (acc, method) => {
      const methodCapability = `queries:${entityName}:${getMethodCapabilitySuffix(
        method,
        entityName,
        inflection,
      )}`;
      const queryHandle = registry.import(methodCapability);

      const { procedureExpr, bodySchemaName, imports } = buildProcedure(
        method,
        entityName,
        registry,
        schemaBuilder,
        queryHandle,
      );

      if (bodySchemaName && !acc.bodySchemaNames.includes(bodySchemaName)) {
        acc.bodySchemaNames.push(bodySchemaName);
        const schemaCapability = `schema:${bodySchemaName}`;
        if (registry.has(schemaCapability)) {
          registry.import(schemaCapability).ref();
        }
      }

      return {
        routerObjBuilder: acc.routerObjBuilder.prop(method.name, procedureExpr),
        schemaImports: [...acc.schemaImports, ...imports],
        bodySchemaNames: acc.bodySchemaNames,
      };
    },
    {
      routerObjBuilder: conjure.obj(),
      schemaImports: [] as ExternalImport[],
      bodySchemaNames: [] as string[],
    },
  );

  return {
    initExpr: cast.toExpr(routerObjBuilder.build()),
    imports: schemaImports,
  };
}

/**
 * Generate aggregator router that combines all entity routers.
 * Returns the init expression for the aggregator variable (not the full statement).
 */
function generateAggregator(
  entities: Map<string, EntityQueriesExtension>,
  config: ResolvedHttpOrpcConfig,
  registry: SymbolRegistryService,
  inflection: CoreInflection,
): {
  initExpr: n.Expression | null;
  imports: ExternalImport[];
} {
  const entityEntries = Array.from(entities.entries());

  if (entityEntries.length === 0) {
    return { initExpr: null, imports: [] };
  }

  const routerObjBuilder = entityEntries.reduce((acc, [entityName]) => {
    const routerName = inflection.variableName(entityName, "Router");
    const key = inflection.variableName(entityName, "");
    const routeCapability = `http-routes:orpc:${entityName}`;
    if (registry.has(routeCapability)) {
      registry.import(routeCapability).ref();
    }
    return acc.prop(key, b.identifier(routerName));
  }, conjure.obj());

  return {
    initExpr: cast.toExpr(routerObjBuilder.build()),
    imports: [],
  };
}

// ============================================================================
// Plugin Definition
// ============================================================================

/**
 * Create an http-orpc plugin that generates oRPC routers.
 *
 * @example
 * ```typescript
 * import { orpc } from "pg-sourcerer"
 *
 * export default defineConfig({
 *   plugins: [
 *     zod(),
 *     kyselyQueries(),
 *     orpc({
 *       aggregatorName: "appRouter",
 *     }),
 *   ],
 * })
 * ```
 */
export function orpc(config?: HttpOrpcConfig): Plugin {
  const schemaConfig = S.decodeSync(HttpOrpcConfigSchema)(config ?? {});

  const resolvedConfig: ResolvedHttpOrpcConfig = {
    outputDir: schemaConfig.outputDir,
    aggregatorName: schemaConfig.aggregatorName,
    routesFile: normalizeFileNaming(config?.routesFile, DEFAULT_ROUTES_FILE),
    appFile: normalizeFileNaming(config?.appFile, DEFAULT_APP_FILE),
    orpcImport: config?.orpcImport,
  };

  return {
    name: PLUGIN_NAME,

    provides: [],

    fileDefaults: [
      // Entity routers use routesFile config
      {
        pattern: "http-routes:orpc:",
        outputDir: resolvedConfig.outputDir,
        fileNaming: resolvedConfig.routesFile,
      },
      // App aggregator uses appFile config (more specific pattern wins)
      {
        pattern: "http-routes:orpc:app",
        outputDir: resolvedConfig.outputDir,
        fileNaming: resolvedConfig.appFile,
      },
    ],

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const registry = yield* SymbolRegistry;
      const inflection = yield* Inflection;
      const extensions = yield* IRExtensions;
      const cj = yield* Conjure;

      const schemaBuilder = extensions.get<SchemaBuilder>(SCHEMA_BUILDER_KEY);
      const entityQueries = buildEntityQueriesMap(extensions);
      const statements: n.Statement[] = [];

      const orpcUserImports: readonly UserModuleRef[] | undefined = resolvedConfig.orpcImport
        ? [resolvedConfig.orpcImport]
        : undefined;

      for (const [entityName, queries] of entityQueries.entries()) {
        const entity = ir.entities.get(entityName);
        if (!entity || !isTableEntity(entity)) continue;

        const capability = `http-routes:orpc:${entityName}`;
        const { initExpr, imports } = registry.forSymbol(capability, () =>
          generateOrpcRouter(entityName, queries, resolvedConfig, registry, inflection, schemaBuilder),
        );

        const routerStmt = yield* cj.exp.const(
          inflection.variableName(entityName, "Router"),
          initExpr,
          { capability, imports, userImports: orpcUserImports, baseEntityName: entityName },
        );
        statements.push(routerStmt);
      }

      // Generate aggregator app if we have any routes
      if (entityQueries.size > 0) {
        const appCapability = "http-routes:orpc:app";
        const { initExpr, imports } = registry.forSymbol(appCapability, () =>
          generateAggregator(entityQueries, resolvedConfig, registry, inflection),
        );

        if (initExpr) {
          const appStmt = yield* cj.exp.const(resolvedConfig.aggregatorName, initExpr, {
            capability: appCapability,
            imports,
            userImports: orpcUserImports,
          });
          statements.push(appStmt);

          // Generate AppRouter type export: type AppRouter = typeof aggregatorName
          const typeStmt = yield* cj.exp.type(
            "AppRouter",
            b.tsTypeQuery(b.identifier(resolvedConfig.aggregatorName)),
            { capability: "http-routes:orpc:app:type" },
          );
          statements.push(typeStmt);
        }
      }

      return statements;
    }),
  };
}

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
import { Effect, Match, Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";

import type { Plugin, SymbolHandle } from "../runtime/types.js";
import { IR } from "../services/ir.js";
import { Inflection, type CoreInflection } from "../services/inflection.js";
import { SymbolRegistry, type SymbolRegistryService } from "../runtime/registry.js";
import { isTableEntity } from "../ir/semantic-ir.js";
import { QueryMethodKind } from "../ir/extensions/queries.js";
import { conjure, cast } from "../conjure/index.js";
import type {
  QueryMethod,
  QueryMethodParam,
  EntityQueriesExtension,
} from "../ir/extensions/queries.js";
import type { SchemaBuilder, SchemaBuilderResult } from "../ir/extensions/schema-builder.js";
import type { RenderedSymbol } from "../runtime/types.js";
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
import { getSchemaBuilder } from "./shared/schema-builder.js";

const { b, stmt } = conjure;

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
const kindToProcedureType = (kind: QueryMethodKind): "query" | "mutation" =>
  Match.value(kind).pipe(
    Match.whenOr("read", "list", "lookup", () => "query" as const),
    Match.whenOr("create", "update", "delete", "function", () => "mutation" as const),
    Match.exhaustive,
  );

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
      const nonBodyParams = method.params.filter(
        p =>
          p.source === "pk" ||
          p.source === "fk" ||
          p.source === "lookup" ||
          p.source === "pagination",
      );

      if (nonBodyParams.length > 0) {
        // Build object with non-body params + body property
        const objBuilder = nonBodyParams
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
 * Build Zod type expression for a param.
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
  imports: ExternalImport[];
} {
  const procedureType = kindToProcedureType(method.kind);

  const imports: ExternalImport[] = [];
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

  if (paramSchema) {
    imports.push(toExternalImport(paramSchema.importSpec));
  }

  const hasBody = method.params.some(p => p.source === "body");
  const shouldUseInputSchema = !hasBody && paramSchema;

  // Build the handler: async ({ input }) => { ... }
  const handlerParams: n.ObjectProperty[] =
    method.params.length > 0
      ? [
          (() => {
            const prop = b.objectProperty(b.identifier("input"), b.identifier("input"));
            prop.shorthand = true;
            return prop;
          })(),
        ]
      : [];

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

  // Build chain: baseProcedure[.input(schema)].query/mutation(handler)
  const baseExpr = b.identifier(baseProcedure);
  const withInput = shouldUseInputSchema
    ? b.callExpression(b.memberExpression(baseExpr, b.identifier("input")), [
        cast.toExpr(paramSchema!.ast),
      ])
    : baseExpr;
  const procedureExpr = b.callExpression(
    b.memberExpression(withInput, b.identifier(procedureType)),
    [handler],
  );

  return { procedureExpr, bodySchemaName, imports };
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
  imports: ExternalImport[];
} {
  const routerName = inflection.variableName(entityName, "Router");
  const schemaBuilder = getSchemaBuilder(registry);

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
        config.baseProcedure,
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

  const routerCall = b.callExpression(b.identifier("router"), [
    cast.toExpr(routerObjBuilder.build()),
  ]);
  const variableDeclarator = b.variableDeclarator(
    b.identifier(routerName),
    cast.toExpr(routerCall),
  );
  const variableDeclaration = b.variableDeclaration("const", [variableDeclarator]);

  return {
    statements: [variableDeclaration as n.Statement],
    imports: schemaImports,
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
  imports: ExternalImport[];
} {
  const entityEntries = Array.from(entities.entries());

  if (entityEntries.length === 0) {
    return { statements: [], imports: [] };
  }

  const routerObjBuilder = entityEntries.reduce((acc, [entityName]) => {
    const routerName = inflection.variableName(entityName, "Router");
    const key = inflection.camelCase(entityName);
    const routeCapability = `http-routes:trpc:${entityName}`;
    if (registry.has(routeCapability)) {
      registry.import(routeCapability).ref();
    }
    return acc.prop(key, b.identifier(routerName));
  }, conjure.obj());

  const routerCall = b.callExpression(b.identifier("router"), [
    cast.toExpr(routerObjBuilder.build()),
  ]);
  const variableDeclarator = b.variableDeclarator(
    b.identifier(config.aggregatorName),
    cast.toExpr(routerCall),
  );
  const variableDeclaration = b.variableDeclaration("const", [variableDeclarator]);

  const typeExport = b.exportNamedDeclaration(
    b.tsTypeAliasDeclaration(
      b.identifier("AppRouter"),
      b.tsTypeQuery(b.identifier(config.aggregatorName)),
    ),
  );

  return {
    statements: [variableDeclaration as n.Statement, typeExport as n.Statement],
    imports: [],
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

      const entityDeclarations = getHttpEligibleEntities(ir).map(entity => ({
        name: inflection.variableName(entity.name, "Router"),
        capability: `http-routes:trpc:${entity.name}`,
        baseEntityName: entity.name,
      }));

      return [
        ...entityDeclarations,
        {
          name: resolvedConfig.aggregatorName,
          capability: "http-routes:trpc:app",
        },
      ];
    }),

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const registry = yield* SymbolRegistry;
      const inflection = yield* Inflection;

      const entityQueries = buildEntityQueriesMap(registry);

      const trpcUserImports: readonly UserModuleRef[] | undefined = resolvedConfig.trpcImport
        ? [resolvedConfig.trpcImport]
        : undefined;

      const entitySymbols = [...entityQueries.entries()].flatMap(([entityName, queries]) => {
        const entity = ir.entities.get(entityName);
        if (!entity || !isTableEntity(entity)) return [];

        const capability = `http-routes:trpc:${entityName}`;
        const { statements, imports } = registry.forSymbol(capability, () =>
          generateTrpcRouter(entityName, queries, resolvedConfig, registry, inflection),
        );

        return [
          {
            name: inflection.variableName(entityName, "Router"),
            capability,
            node: statements[0] ?? null,
            exports: "named" as const,
            imports,
            userImports: trpcUserImports,
          },
        ];
      });

      const appSymbols =
        entityQueries.size > 0
          ? (() => {
              const appCapability = "http-routes:trpc:app";
              const { statements, imports } = registry.forSymbol(appCapability, () =>
                generateAggregator(entityQueries, resolvedConfig, registry, inflection),
              );

              return [
                {
                  name: resolvedConfig.aggregatorName,
                  capability: appCapability,
                  node: statements[0] ?? null,
                  exports: "named" as const,
                  imports,
                  userImports: trpcUserImports,
                },
                ...(statements[1]
                  ? [
                      {
                        name: "AppRouter",
                        capability: "http-routes:trpc:app:type",
                        node: statements[1],
                        exports: false as const,
                      },
                    ]
                  : []),
              ];
            })()
          : [];

      return [...entitySymbols, ...appSymbols];
    }),
  };
}

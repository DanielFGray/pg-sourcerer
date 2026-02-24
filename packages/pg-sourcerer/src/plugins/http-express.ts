/**
 * HTTP Express Plugin - Generates Express route handlers from query symbols
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

import type { Plugin, SymbolHandle } from "../runtime/types.js";
import { IR } from "../services/ir.js";
import { Inflection, type CoreInflection } from "../services/inflection.js";
import { inflect } from "../services/inflection.js";
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
import {
  buildEntityQueriesMap,
  buildQueryInvocation,
  coerceParam,
  getBodySchemaName,
  getHttpEligibleEntities,
  getMethodCapabilitySuffix,
  getRoutePath,
  kindToHttpMethod,
  needsCoercion,
  toExternalImport,
} from "./shared/http-helpers.js";
import { IRExtensions, type IRExtensionsService } from "../services/ir-extensions.js";

const { b, stmt } = conjure;

const PLUGIN_NAME = "express-http";

const DEFAULT_OUTPUT_DIR = "";
const DEFAULT_ROUTES_FILE = "routes.ts";
const DEFAULT_APP_FILE = "index.ts";

/**
 * Schema-validated portion of the config (simple types only).
 * FileNaming functions are handled separately since Schema can't validate functions.
 */
const HttpExpressConfigSchema = S.Struct({
  outputDir: S.optionalWith(S.String, { default: () => DEFAULT_OUTPUT_DIR }),
  basePath: S.optionalWith(S.String, { default: () => "" }),
});

/**
 * Config type for user input.
 * Supports both string literals and FileNaming functions for file paths.
 */
export interface HttpExpressConfig {
  outputDir?: string;
  basePath?: string;
  /**
   * Output file for route handlers.
   * Can be a static string or a function receiving FileNamingContext.
   * @example "routes.ts" - all routes in one file
   * @example ({ entityName }) => `${entityName}/routes.ts` - per-entity files
   */
  routesFile?: string | FileNaming;
  /**
   * Output file for the aggregator that .use()s all routes.
   * @example "index.ts"
   * @example ({ folderName }) => `${folderName}/app.ts`
   */
  appFile?: string | FileNaming;
}

/** Resolved config type with normalized FileNaming functions */
interface ResolvedHttpExpressConfig {
  outputDir: string;
  basePath: string;
  routesFile: FileNaming;
  appFile: FileNaming;
}

type ConsumeFn = (input: n.Expression) => n.Expression;

interface ValidationSchemas {
  readonly paramSchema?: SchemaBuilderResult;
  readonly querySchema?: SchemaBuilderResult;
  readonly bodyConsume?: ConsumeFn;
}

function buildHandlerBody(
  method: QueryMethod,
  inflection: CoreInflection,
  schemas: ValidationSchemas,
  queryHandle: SymbolHandle,
): n.Statement[] {
  const callSig = method.callSignature ?? { style: "named" };
  const statements: n.Statement[] = [];
  const paramConsume = schemas.paramSchema?.consume;
  const queryConsume = schemas.querySchema?.consume;
  const bodyConsume = schemas.bodyConsume;

  // Extract path params: const { id } = req.params
  const pathParams = method.params.filter(
    p => p.source === "pk" || p.source === "fk" || p.source === "lookup",
  );
  if (pathParams.length > 0 && paramConsume) {
    statements.push(
      stmt.const(
        "params",
        paramConsume(b.memberExpression(b.identifier("req"), b.identifier("params"))),
      ),
    );
  } else if (pathParams.length > 0) {
    const pattern = b.objectPattern(
      pathParams.map(p => {
        const prop = b.property("init", b.identifier(p.name), b.identifier(p.name));
        prop.shorthand = true;
        return prop;
      }),
    );
    statements.push(
      stmt.const(
        pathParams.map(p => p.name).join(", "),
        b.memberExpression(b.identifier("req"), b.identifier("params")),
      ),
    );
  }

  // Extract query params: const { limit, offset } = req.query
  const queryParams = method.params.filter(p => p.source === "pagination");
  if (queryParams.length > 0 && queryConsume) {
    statements.push(
      stmt.const(
        "query",
        queryConsume(b.memberExpression(b.identifier("req"), b.identifier("query"))),
      ),
    );
  } else if (queryParams.length > 0) {
    const pattern = b.objectPattern(
      queryParams.map(p => {
        const prop = b.property("init", b.identifier(p.name), b.identifier(p.name));
        prop.shorthand = true;
        return prop;
      }),
    );
    statements.push(
      stmt.const(
        queryParams.map(p => p.name).join(", "),
        b.memberExpression(b.identifier("req"), b.identifier("query")),
      ),
    );
  }

  // Extract body: const body = req.body
  const needsBody =
    method.params.some(p => p.source === "body") ||
    method.kind === "create" ||
    method.kind === "update" ||
    (method.kind === "function" && method.params.some(p => !p.source));
  if (needsBody) {
    statements.push(
      stmt.const(
        "body",
        bodyConsume
          ? bodyConsume(b.memberExpression(b.identifier("req"), b.identifier("body")))
          : b.memberExpression(b.identifier("req"), b.identifier("body")),
      ),
    );
  }

  // Build the function call arguments
  const args: n.Expression[] = [];

  const paramExpr = (param: QueryMethodParam): n.Expression => {
    if (param.source === "body") {
      return b.identifier("body");
    }

    if (param.source === "pagination") {
      if (queryConsume) {
        return b.memberExpression(b.identifier("query"), b.identifier(param.name));
      }
      return needsCoercion(param) ? coerceParam(param.name, param.type) : b.identifier(param.name);
    }

    if (param.source === "pk" || param.source === "fk" || param.source === "lookup") {
      if (paramConsume) {
        return b.memberExpression(b.identifier("params"), b.identifier(param.name));
      }
      return needsCoercion(param) ? coerceParam(param.name, param.type) : b.identifier(param.name);
    }

    return b.memberExpression(b.identifier("body"), b.identifier(param.name));
  };

  if (callSig.style === "positional") {
    args.push(...method.params.map(paramExpr));
  } else {
    const bodyParam = method.params.find(p => p.source === "body");
    const nonBodyParams = method.params.filter(p => p.source && p.source !== "body");

    if (bodyParam && callSig.bodyStyle === "spread") {
      if (nonBodyParams.length > 0) {
        const objBuilder = nonBodyParams.reduce(
          (obj, param) => obj.prop(param.name, paramExpr(param)),
          conjure.obj(),
        ).spread(b.identifier("body"));
        args.push(objBuilder.build());
      } else {
        args.push(b.identifier("body"));
      }
    } else if (bodyParam && callSig.bodyStyle === "property") {
      const objBuilder = method.params
        .filter(p => p.source && p.source !== "body")
        .reduce((obj, param) => obj.prop(param.name, paramExpr(param)), conjure.obj())
        .prop(bodyParam.name, b.identifier("body"));
      args.push(objBuilder.build());
    } else {
      const objBuilder = method.params
        .filter(p => p.source && p.source !== "body")
        .reduce((obj, param) => obj.prop(param.name, paramExpr(param)), conjure.obj());
      if (method.params.length > 0) {
        args.push(objBuilder.build());
      }
    }
  }

  // Call the query function and execute based on method kind
  const queryCall = buildQueryInvocation(queryHandle, args);
  statements.push(stmt.const("result", b.awaitExpression(cast.toExpr(queryCall))));

  // Handle 404 for read/lookup that returns null/undefined
  if (method.kind === "read" || (method.kind === "lookup" && method.isUniqueLookup)) {
    const notFoundResponse = b.callExpression(
      b.memberExpression(
        b.callExpression(b.memberExpression(b.identifier("res"), b.identifier("status")), [
          b.numericLiteral(404),
        ]),
        b.identifier("json"),
      ),
      [conjure.obj().prop("error", b.stringLiteral("Not found")).build()],
    );
    statements.push(
      b.ifStatement(
        b.unaryExpression("!", b.identifier("result")),
        b.returnStatement(notFoundResponse),
      ),
    );
  }

  // Return response: res.json(result) or res.status(201).json(result) for create
  const responseExpr: n.Expression = method.kind === "create"
    ? b.callExpression(
        b.memberExpression(
          b.callExpression(b.memberExpression(b.identifier("res"), b.identifier("status")), [
            b.numericLiteral(201),
          ]),
          b.identifier("json"),
        ),
        [b.identifier("result")],
      )
    : b.callExpression(b.memberExpression(b.identifier("res"), b.identifier("json")), [
        b.identifier("result"),
      ]);
  statements.push(b.returnStatement(cast.toExpr(responseExpr)));

  return statements;
}

function buildRouteCall(
  method: QueryMethod,
  entityName: string,
  inflection: CoreInflection,
  schemas: ValidationSchemas,
  queryHandle: SymbolHandle,
): {
  httpMethod: string;
  path: string;
  handler: n.ArrowFunctionExpression;
} {
  const httpMethod = kindToHttpMethod(method.kind);
  const path = getRoutePath(method, { kebabCase: inflection.kebabCase });

  const handlerBody = buildHandlerBody(method, inflection, schemas, queryHandle);
  const handler = b.arrowFunctionExpression(
    [b.identifier("req"), b.identifier("res")],
    b.blockStatement(handlerBody.map(cast.toStmt)),
  );
  handler.async = true;

  return { httpMethod, path, handler };
}

/**
 * Generate Express routes init expression for an entity.
 * Returns the init expression (not the full statement).
 */
function generateExpressRoutes(
  entityName: string,
  queries: EntityQueriesExtension,
  config: ResolvedHttpExpressConfig,
  registry: SymbolRegistryService,
  inflection: CoreInflection,
  schemaBuilder: SchemaBuilder | undefined,
): {
  initExpr: n.Expression;
  imports: ExternalImport[];
} {
  const { chainExpr, schemaImports } = queries.methods.reduce<{
    chainExpr: n.Expression;
    schemaImports: ExternalImport[];
  }>(
    (acc, method) => {
      const methodCapability = `queries:${entityName}:${getMethodCapabilitySuffix(method, entityName, inflection)}`;
      if (registry.has(methodCapability)) {
        registry.import(methodCapability).ref();
      }

      const pathParams = method.params.filter(
        p => p.source === "pk" || p.source === "fk" || p.source === "lookup",
      );
      const queryParams = method.params.filter(p => p.source === "pagination");

      const paramSchema =
        schemaBuilder && pathParams.length > 0
          ? schemaBuilder.build({ variant: "params", params: pathParams })
          : undefined;

      const querySchema =
        schemaBuilder && queryParams.length > 0
          ? schemaBuilder.build({ variant: "query", params: queryParams })
          : undefined;

      const bodySchemaName = getBodySchemaName(method, entityName);
      const bodySchema =
        bodySchemaName && registry.has(`schema:${bodySchemaName}`)
          ? registry.import(`schema:${bodySchemaName}`)
          : undefined;
      const bodyConsume = bodySchema?.consume
        ? (input: n.Expression) => bodySchema.consume!(input) as n.Expression
        : undefined;

      const queryHandle = registry.import(methodCapability);
      const { httpMethod, path, handler } = buildRouteCall(
        method,
        entityName,
        inflection,
        { paramSchema, querySchema, bodyConsume },
        queryHandle,
      );

      return {
        chainExpr: b.callExpression(
          b.memberExpression(cast.toExpr(acc.chainExpr), b.identifier(httpMethod)),
          [b.stringLiteral(path), handler],
        ),
        schemaImports: [
          ...acc.schemaImports,
          ...(paramSchema ? [toExternalImport(paramSchema.importSpec)] : []),
          ...(querySchema ? [toExternalImport(querySchema.importSpec)] : []),
        ],
      };
    },
    { chainExpr: b.callExpression(b.identifier("Router"), []), schemaImports: [] },
  );

  return {
    initExpr: chainExpr,
    imports: [{ from: "express", names: ["Router"] }, ...schemaImports],
  };
}


/**
 * Generate aggregator init expression.
 * Returns the init expression (not the full statement).
 */
function generateAggregatorExpr(
  entities: Map<string, EntityQueriesExtension>,
  config: ResolvedHttpExpressConfig,
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

  const chainExpr = entityEntries.reduce<n.Expression>(
    (chain, [entityName]) => {
      const routesVarName = `${inflect.uncapitalize(entityName)}Routes`;
      const routeCapability = `http-routes:express:${entityName}`;
      if (registry.has(routeCapability)) {
        registry.import(routeCapability).ref();
      }
      return b.callExpression(b.memberExpression(cast.toExpr(chain), b.identifier("use")), [
        b.identifier(routesVarName),
      ]);
    },
    b.callExpression(b.identifier("Router"), []),
  );

  return {
    initExpr: chainExpr,
    imports: [{ from: "express", names: ["Router"] }],
  };
}

export function express(config?: HttpExpressConfig): Plugin {
  const schemaConfig = S.decodeSync(HttpExpressConfigSchema)(config ?? {});

  const resolvedConfig: ResolvedHttpExpressConfig = {
    outputDir: schemaConfig.outputDir,
    basePath: schemaConfig.basePath,
    routesFile: normalizeFileNaming(config?.routesFile, DEFAULT_ROUTES_FILE),
    appFile: normalizeFileNaming(config?.appFile, DEFAULT_APP_FILE),
  };

  return {
    name: PLUGIN_NAME,

    provides: [],

    fileDefaults: [
      {
        pattern: "http-routes:express:",
        outputDir: resolvedConfig.outputDir,
        fileNaming: resolvedConfig.routesFile,
      },
      {
        pattern: "http-routes:express:app",
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

      for (const [entityName, queries] of entityQueries.entries()) {
        const entity = ir.entities.get(entityName);
        if (!entity || !isTableEntity(entity)) continue;

        const capability = `http-routes:express:${entityName}`;
        const { initExpr, imports } = registry.forSymbol(capability, () =>
          generateExpressRoutes(entityName, queries, resolvedConfig, registry, inflection, schemaBuilder),
        );

        const routeStmt = yield* cj.exp.const(
          `${inflect.uncapitalize(entityName)}Routes`,
          initExpr,
          { capability, imports, baseEntityName: entityName },
        );
        statements.push(routeStmt);
      }

      // Generate aggregator app if we have any routes
      if (entityQueries.size > 0) {
        const appCapability = "http-routes:express:app";
        const { initExpr, imports } = registry.forSymbol(appCapability, () =>
          generateAggregatorExpr(entityQueries, resolvedConfig, registry, inflection),
        );

        if (initExpr) {
          const appStmt = yield* cj.exp.const("api", initExpr, {
            capability: appCapability,
            imports,
          });
          statements.push(appStmt);
        }
      }

      return statements;
    }),
  };
}

/**
 * Hono HTTP Plugin - Generates Hono route handlers from query symbols
 *
 * Consumes "queries" and "schema" capabilities (provider-agnostic).
 * Works with any queries provider (kysely, drizzle, effect-sql, etc.)
 * and any schema provider (zod, arktype, valibot, etc.).
 *
 * Uses the SymbolRegistry to resolve query functions and optionally
 * schema symbols for request validation.
 *
 * For param/query validation, uses the SchemaBuilder service when available.
 * For body validation, imports schema symbols via registry.
 *
 * Routes use @hono/standard-validator for middleware-based validation.
 */
import { Effect, Schema as S } from "effect";
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
import { SCHEMA_BUILDER_KEY, type SchemaBuilder } from "../ir/extensions/schema-builder.js";
import type { ExternalImport } from "../runtime/emit.js";
import {
  buildEntityQueriesMap,
  buildQueryInvocation,
  coerceParam,
  getBodySchemaName,
  getHttpEligibleEntities,
  getMethodCapabilitySuffix,
  getRoutePath,
  kindToHttpMethod,
  listByRouteFromName,
  toExternalImport,
} from "./shared/http-helpers.js";
import { FileNaming, normalizeFileNaming } from "../runtime/file-assignment.js";

const { b, stmt } = conjure;

const PLUGIN_NAME = "hono-http";

const DEFAULT_OUTPUT_DIR = "";
const DEFAULT_ROUTES_FILE = "routes.ts";
const DEFAULT_APP_FILE = "routes.ts";

/**
 * Schema-validated portion of the config (simple types only).
 */
const HttpHonoConfigSchema = S.Struct({
  outputDir: S.optionalWith(S.String, { default: () => DEFAULT_OUTPUT_DIR }),
  basePath: S.optionalWith(S.String, { default: () => "" }),
});

export interface HttpHonoConfig {
  outputDir?: string;
  basePath?: string;
  /**
   * Output file for route handlers.
   * @example "routes.ts" - all routes in one file
   * @example ({ entityName }) => `${entityName}/routes.ts` - per-entity files
   */
  routesFile?: string | FileNaming;
  /**
   * Output file for the aggregator app.
   * @example "index.ts"
   * @example ({ folderName }) => `${folderName}/app.ts`
   */
  appFile?: string | FileNaming;
}

interface ResolvedHttpHonoConfig {
  outputDir: string;
  basePath: string;
  routesFile: FileNaming;
  appFile: FileNaming;
}

interface HandlerValidationState {
  readonly hasParamValidation: boolean;
  readonly hasQueryValidation: boolean;
  readonly hasBodyValidation: boolean;
}

function buildHandlerBody(
  method: QueryMethod,
  validation: HandlerValidationState,
  queryHandle: SymbolHandle,
): n.Statement[] {
  const callSig = method.callSignature ?? { style: "named" };
  const statements: n.Statement[] = [];
  const pathParams = method.params.filter(
    p => p.source === "pk" || p.source === "fk" || p.source === "lookup",
  );
  const queryParams = method.params.filter(p => p.source === "pagination");
  const needsBody =
    method.params.some(p => p.source === "body") ||
    method.kind === "create" ||
    method.kind === "update" ||
    (method.kind === "function" && method.params.some(p => !p.source));

  if (pathParams.length > 0) {
    const paramSource = validation.hasParamValidation
      ? b.callExpression(
          b.memberExpression(
            b.memberExpression(b.identifier("c"), b.identifier("req")),
            b.identifier("valid"),
          ),
          [b.stringLiteral("param")],
        )
      : b.callExpression(
          b.memberExpression(
            b.memberExpression(b.identifier("c"), b.identifier("req")),
            b.identifier("param"),
          ),
          [],
        );
    statements.push(stmt.const("params", paramSource));
  }

  if (queryParams.length > 0) {
    const querySource = validation.hasQueryValidation
      ? b.callExpression(
          b.memberExpression(
            b.memberExpression(b.identifier("c"), b.identifier("req")),
            b.identifier("valid"),
          ),
          [b.stringLiteral("query")],
        )
      : b.callExpression(
          b.memberExpression(
            b.memberExpression(b.identifier("c"), b.identifier("req")),
            b.identifier("query"),
          ),
          [],
        );
    statements.push(stmt.const("query", querySource));
  }

  if (needsBody) {
    const bodySource = validation.hasBodyValidation
      ? b.callExpression(
          b.memberExpression(
            b.memberExpression(b.identifier("c"), b.identifier("req")),
            b.identifier("valid"),
          ),
          [b.stringLiteral("json")],
        )
      : b.awaitExpression(
          b.callExpression(
            b.memberExpression(
              b.memberExpression(b.identifier("c"), b.identifier("req")),
              b.identifier("json"),
            ),
            [],
          ),
        );
    statements.push(stmt.const("body", bodySource));
  }

  const args: n.Expression[] = [];

  const paramExpr = (param: QueryMethodParam): n.Expression => {
    if (param.source === "body") {
      return b.identifier("body");
    }

    if (param.source === "pagination") {
      const sourceExpr = b.memberExpression(b.identifier("query"), b.identifier(param.name));
      return validation.hasQueryValidation ? sourceExpr : coerceParam(param.name, param.type);
    }

    if (param.source === "pk" || param.source === "fk" || param.source === "lookup") {
      const sourceExpr = b.memberExpression(b.identifier("params"), b.identifier(param.name));
      return validation.hasParamValidation ? sourceExpr : coerceParam(param.name, param.type);
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
        const objBuilder = nonBodyParams
          .reduce((builder, param) => builder.prop(param.name, paramExpr(param)), conjure.obj())
          .spread(b.identifier("body"));
        args.push(objBuilder.build());
      } else {
        args.push(b.identifier("body"));
      }
    } else if (bodyParam && callSig.bodyStyle === "property") {
      const objBuilder = method.params
        .filter(p => p.source && p.source !== "body")
        .reduce((builder, param) => builder.prop(param.name, paramExpr(param)), conjure.obj())
        .prop(bodyParam.name, b.identifier("body"));
      args.push(objBuilder.build());
    } else {
      const objBuilder = method.params
        .filter(p => p.source && p.source !== "body")
        .reduce((builder, param) => builder.prop(param.name, paramExpr(param)), conjure.obj());

      if (method.params.length > 0) {
        args.push(objBuilder.build());
      }
    }
  }

  const queryCall = buildQueryInvocation(queryHandle, args);
  const awaitExpr = b.awaitExpression(cast.toExpr(queryCall));
  statements.push(conjure.stmt.const("result", awaitExpr));

  if (method.kind === "read" || (method.kind === "lookup" && method.isUniqueLookup)) {
    const notFoundResponse = b.callExpression(
      b.memberExpression(b.identifier("c"), b.identifier("json")),
      [
        conjure.obj().prop("error", b.stringLiteral("Not found")).build(),
        b.numericLiteral(404),
      ].map(cast.toExpr),
    );
    statements.push(
      b.ifStatement(
        b.unaryExpression("!", b.identifier("result")),
        b.returnStatement(notFoundResponse),
      ),
    );
  }

  const statusCode = method.kind === "create" ? 201 : undefined;
  const jsonArgs: n.Expression[] = [b.identifier("result")];
  if (statusCode) {
    jsonArgs.push(b.numericLiteral(statusCode));
  }
  const jsonResponse = b.callExpression(
    b.memberExpression(b.identifier("c"), b.identifier("json")),
    jsonArgs.map(cast.toExpr),
  );
  statements.push(b.returnStatement(jsonResponse));

  return statements;
}

/**
 * Build sValidator('target', schema) middleware call.
 */
function buildSValidator(target: string, schema: n.Expression): n.Expression {
  return b.callExpression(b.identifier("sValidator"), [
    b.stringLiteral(target),
    cast.toExpr(schema),
  ]);
}

interface RouteCallResult {
  httpMethod: string;
  path: string;
  handler: n.ArrowFunctionExpression;
  validators: n.Expression[];
  bodySchemaName: string | null;
  schemaImports: ExternalImport[];
  hasParamValidation: boolean;
  hasQueryValidation: boolean;
}

/**
 * Build a single route with optional validation middleware.
 */
function buildRouteCall(
  method: QueryMethod,
  entityName: string,
  inflection: CoreInflection,
  queryHandle: SymbolHandle,
  schemaBuilder: SchemaBuilder | undefined,
): RouteCallResult {
  const httpMethod = kindToHttpMethod(method.kind);
  const path = getRoutePath(method, {
    kebabCase: inflection.kebabCase,
    listByRoute: candidate => listByRouteFromName(candidate, inflection.kebabCase),
  });
  const validators: n.Expression[] = [];
  const schemaImports: ExternalImport[] = [];

  const pathParams = method.params.filter(
    p => p.source === "pk" || p.source === "fk" || p.source === "lookup",
  );
  const paramValidation =
    pathParams.length > 0 && schemaBuilder
      ? schemaBuilder.build({ variant: "params", params: pathParams })
      : undefined;
  if (paramValidation) {
    validators.push(buildSValidator("param", paramValidation.ast));
    schemaImports.push(toExternalImport(paramValidation.importSpec));
  }
  const hasParamValidation = paramValidation != null;

  const queryParams = method.params.filter(p => p.source === "pagination");
  const queryValidation =
    queryParams.length > 0 && schemaBuilder
      ? schemaBuilder.build({ variant: "query", params: queryParams })
      : undefined;
  if (queryValidation) {
    validators.push(buildSValidator("query", queryValidation.ast));
    schemaImports.push(toExternalImport(queryValidation.importSpec));
  }
  const hasQueryValidation = queryValidation != null;

  const bodySchemaName = getBodySchemaName(method, entityName);
  if (bodySchemaName) {
    validators.push(buildSValidator("json", b.identifier(bodySchemaName)));
  }

  const handlerBody = buildHandlerBody(
    method,
    {
      hasParamValidation,
      hasQueryValidation,
      hasBodyValidation: bodySchemaName != null,
    },
    queryHandle,
  );
  const handler = b.arrowFunctionExpression(
    [b.identifier("c")],
    b.blockStatement(handlerBody.map(cast.toStmt)),
  );
  handler.async = true;

  return {
    httpMethod,
    path,
    handler,
    validators,
    bodySchemaName,
    schemaImports,
    hasParamValidation,
    hasQueryValidation,
  };
}

/**
 * Generate Hono routes for an entity.
 * Returns the init expression for the routes variable (not the full statement).
 */
function generateHonoRoutes(
  entityName: string,
  queries: EntityQueriesExtension,
  config: ResolvedHttpHonoConfig,
  registry: SymbolRegistryService,
  inflection: CoreInflection,
  schemaBuilder: SchemaBuilder | undefined,
): {
  initExpr: n.Expression;
  imports: ExternalImport[];
  needsSValidator: boolean;
} {
  const initialChainExpr: n.Expression = b.newExpression(b.identifier("Hono"), []);
  const schemaCapabilities: string[] = [];
  const schemaImports: ExternalImport[] = [];

  const chainExpr = queries.methods.reduce((chain, method) => {
    const methodCapability = `queries:${entityName}:${getMethodCapabilitySuffix(method, entityName, inflection)}`;
    const queryHandle = registry.import(methodCapability);

    const {
      httpMethod,
      path,
      handler,
      validators,
      bodySchemaName,
      schemaImports: routeImports,
    } = buildRouteCall(method, entityName, inflection, queryHandle, schemaBuilder);
    schemaImports.push(...routeImports);

    if (bodySchemaName) {
      const schemaCapability = `schema:${bodySchemaName}`;
      if (registry.has(schemaCapability)) {
        registry.import(schemaCapability).ref();
        schemaCapabilities.push(schemaCapability);
      }
    }

    const callArgs: n.Expression[] = [b.stringLiteral(path), ...validators, handler];

    return b.callExpression(
      b.memberExpression(cast.toExpr(chain), b.identifier(httpMethod)),
      callArgs.map(cast.toExpr),
    );
  }, initialChainExpr);

  const imports: ExternalImport[] = [{ from: "hono", names: ["Hono"] }, ...schemaImports];
  const needsSValidator =
    schemaCapabilities.length > 0 ||
    queries.methods.some(m =>
      m.params.some(
        p =>
          p.source === "pk" ||
          p.source === "fk" ||
          p.source === "lookup" ||
          p.source === "pagination",
      ),
    );

  return {
    initExpr: chainExpr,
    imports,
    needsSValidator,
  };
}


/**
 * Generate the aggregator app init expression.
 * Returns the init expression for the app variable (not the full statement).
 */
function generateAggregatorExpr(
  entities: Map<string, EntityQueriesExtension>,
  config: ResolvedHttpHonoConfig,
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

  const basePath = config.basePath.replace(/^\/+|\/+$/g, "");
  const baseExpr: n.Expression = b.newExpression(b.identifier("Hono"), []);

  const withBasePath = basePath
    ? b.callExpression(
        b.memberExpression(cast.toExpr(baseExpr), b.identifier("basePath")),
        [b.stringLiteral(`/${basePath}`)].map(cast.toExpr),
      )
    : baseExpr;

  const chainExpr = entityEntries.reduce((chain, [entityName]) => {
    const routesVarName = inflection.variableName(entityName, "Routes");
    const routeCapability = `http-routes:hono:${entityName}`;
    const prefix = inflection.entityRoutePath(entityName);

    if (registry.has(routeCapability)) {
      registry.import(routeCapability).ref();
    }

    return b.callExpression(
      b.memberExpression(cast.toExpr(chain), b.identifier("route")),
      [b.stringLiteral(prefix), b.identifier(routesVarName)].map(cast.toExpr),
    );
  }, withBasePath);

  return {
    initExpr: chainExpr,
    imports: [{ from: "hono", names: ["Hono"] }],
  };
}

export function hono(config?: HttpHonoConfig): Plugin {
  const schemaConfig = S.decodeSync(HttpHonoConfigSchema)(config ?? {});

  const resolvedConfig: ResolvedHttpHonoConfig = {
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
        pattern: "http-routes:hono:",
        outputDir: resolvedConfig.outputDir,
        fileNaming: resolvedConfig.routesFile,
      },
      {
        pattern: "http-routes:hono:app",
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

      // Generate routes for each entity
      for (const [entityName, queries] of entityQueries.entries()) {
        const entity = ir.entities.get(entityName);
        if (!entity || !isTableEntity(entity)) continue;

        const capability = `http-routes:hono:${entityName}`;
        // Scope ref tracking to this capability
        const { initExpr, imports, needsSValidator } = registry.forSymbol(capability, () =>
          generateHonoRoutes(entityName, queries, resolvedConfig, registry, inflection, schemaBuilder),
        );

        const finalImports = needsSValidator
          ? [...imports, { from: "@hono/standard-validator", names: ["sValidator"] }]
          : imports;

        const routeStmt = yield* cj.exp.const(
          inflection.variableName(entityName, "Routes"),
          initExpr,
          { capability, imports: finalImports },
        );
        statements.push(routeStmt);
      }

      // Generate aggregator app if we have any routes
      if (entityQueries.size > 0) {
        const appCapability = "http-routes:hono:app";
        // Scope ref tracking to this capability
        const { initExpr, imports } = registry.forSymbol(appCapability, () =>
          generateAggregatorExpr(entityQueries, resolvedConfig, registry, inflection),
        );

        if (initExpr) {
          const appStmt = yield* cj.exp.const("honoApp", initExpr, {
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

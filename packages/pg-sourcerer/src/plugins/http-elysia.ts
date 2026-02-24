/**
 * Elysia HTTP Plugin - Generates Elysia route handlers from query symbols
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
import type { ExternalImport } from "../runtime/emit.js";
import { type FileNaming, normalizeFileNaming } from "../runtime/file-assignment.js";
import {
  buildEntityQueriesMap,
  buildQueryInvocation,
  defaultHttpMethodMap,
  getBodySchemaName,
  getHttpEligibleEntities,
  getMethodCapabilitySuffix,
  getRoutePath,
  kindToHttpMethod,
  listByRouteFromName,
} from "./shared/http-helpers.js";

const { b, stmt } = conjure;

const PLUGIN_NAME = "elysia-http";

const DEFAULT_OUTPUT_DIR = "";
const DEFAULT_ROUTES_FILE = "routes.ts";
const DEFAULT_APP_FILE = "routes.ts";

/**
 * Schema-validated portion of the config (simple types only).
 * FileNaming functions are handled separately since Schema can't validate functions.
 */
const HttpElysiaConfigSchema = S.Struct({
  outputDir: S.optionalWith(S.String, { default: () => DEFAULT_OUTPUT_DIR }),
  basePath: S.optionalWith(S.String, { default: () => "" }),
});

/**
 * Config type for user input.
 * Supports both string literals and FileNaming functions for file paths.
 */
export interface HttpElysiaConfig {
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
   * Output file for the aggregator app that .use()s all routes.
   * @example "index.ts"
   * @example ({ folderName }) => `${folderName}/app.ts`
   */
  appFile?: string | FileNaming;
}

/** Resolved config type with normalized FileNaming functions */
interface ResolvedHttpElysiaConfig {
  outputDir: string;
  basePath: string;
  routesFile: FileNaming;
  appFile: FileNaming;
}

// Manual casing helpers removed - now using inflection service:
// - inflection.kebabCase(), inflection.pascalCase() for primitives
// - inflection.elysiaRoutesName() for route variable names
// - inflection.entityRoutePath() for entity path segments

/**
 * Build handler body for Elysia routes.
 *
 * With Elysia-native validation, params and body are pre-validated via route options.
 * Handler accesses params.field and body directly (no inline parsing needed).
 */
function buildHandlerBody(
  method: QueryMethod,
  queryHandle: SymbolHandle,
): n.Statement[] {
  const callSig = method.callSignature ?? { style: "named" };
  const args: n.Expression[] = [];

  const paramExpr = (param: QueryMethodParam): n.Expression => {
    if (param.source === "body") {
      return b.identifier("body");
    }
    if (param.source === "pagination") {
      return b.memberExpression(b.identifier("query"), b.identifier(param.name));
    }
    if (param.source === "pk" || param.source === "fk" || param.source === "lookup") {
      return b.memberExpression(b.identifier("params"), b.identifier(param.name));
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
  const resultDecl = stmt.const("result", awaitExpr);

  if (method.kind === "read" || (method.kind === "lookup" && method.isUniqueLookup)) {
    const statusCall = b.callExpression(b.identifier("status"), [
      b.numericLiteral(404),
      b.stringLiteral("Not found"),
    ]);
    const notFoundCheck = b.ifStatement(
      b.unaryExpression("!", b.identifier("result")),
      b.returnStatement(statusCall),
    );
    return [resultDecl, notFoundCheck, b.returnStatement(b.identifier("result"))];
  }

  return [resultDecl, b.returnStatement(b.identifier("result"))];
}

const elysiaMethodMap = {
  ...defaultHttpMethodMap,
  update: "patch",
};

function buildRouteCall(
  method: QueryMethod,
  entityName: string,
  inflection: CoreInflection,
  queryHandle: SymbolHandle,
  registry: SymbolRegistryService,
): {
  httpMethod: string;
  path: string;
  handler: n.ArrowFunctionExpression;
  needsBody: boolean;
  bodySchemaName: string | null;
  paramsSchemaExpr: n.Expression | null;
  options: n.ObjectExpression | null;
} {
  const httpMethod = kindToHttpMethod(method.kind, elysiaMethodMap);
  const path = getRoutePath(method, {
    kebabCase: inflection.kebabCase,
    listByRoute: candidate => listByRouteFromName(candidate, inflection.kebabCase),
  });

  const handlerProps: n.Property[] = [];

  const pathParams = method.params.filter(
    p => p.source === "pk" || p.source === "fk" || p.source === "lookup",
  );
  if (pathParams.length > 0) {
    const paramsProp = b.property("init", b.identifier("params"), b.identifier("params"));
    paramsProp.shorthand = true;
    handlerProps.push(paramsProp);
  }

  const needsBody =
    method.params.some(p => p.source === "body") ||
    method.kind === "create" ||
    method.kind === "update" ||
    (method.kind === "function" && method.params.some(p => !p.source));
  if (needsBody) {
    const prop = b.property("init", b.identifier("body"), b.identifier("body"));
    prop.shorthand = true;
    handlerProps.push(prop);
  }

  const paginationParams = method.params.filter(p => p.source === "pagination");
  if (paginationParams.length > 0) {
    const queryProp = b.property("init", b.identifier("query"), b.identifier("query"));
    queryProp.shorthand = true;
    handlerProps.push(queryProp);
  }

  if (method.kind === "read" || (method.kind === "lookup" && method.isUniqueLookup)) {
    const prop = b.property("init", b.identifier("status"), b.identifier("status"));
    prop.shorthand = true;
    handlerProps.push(prop);
  }

  const handlerParamPattern = b.objectPattern(handlerProps);

  const handlerBody = buildHandlerBody(method, queryHandle);
  const handler = b.arrowFunctionExpression(
    [handlerParamPattern],
    b.blockStatement(handlerBody.map(cast.toStmt)),
  );
  handler.async = true;

  // Build Elysia-native validation options
  const bodySchemaName = getBodySchemaName(method, entityName);
  let paramsSchemaExpr: n.Expression | null = null;

  // Build params schema: EntitySchema.pick({ field: true }) for Elysia-native validation
  if (pathParams.length > 0) {
    const entitySchemaCapability = `schema:${entityName}`;
    if (registry.has(entitySchemaCapability)) {
      const entitySchemaHandle = registry.import(entitySchemaCapability);
      entitySchemaHandle.ref();
      let pickObj = conjure.obj();
      for (const p of pathParams) {
        pickObj = pickObj.prop(p.name, b.booleanLiteral(true));
      }
      paramsSchemaExpr = b.callExpression(
        b.memberExpression(b.identifier(entitySchemaHandle.name), b.identifier("pick")),
        [pickObj.build()],
      );
    }
  }

  // Build route options object
  let optBuilder = conjure.obj();
  let hasOptions = false;

  if (bodySchemaName) {
    optBuilder = optBuilder.prop("body", b.identifier(bodySchemaName));
    hasOptions = true;
  }
  if (paramsSchemaExpr) {
    optBuilder = optBuilder.prop("params", paramsSchemaExpr);
    hasOptions = true;
  }

  const options: n.ObjectExpression | null = hasOptions ? optBuilder.build() : null;

  return { httpMethod, path, handler, needsBody, bodySchemaName, paramsSchemaExpr, options };
}

/**
 * Generate Elysia routes for an entity.
 * Returns the init expression for the routes variable (not the full statement).
 *
 * @param entityName - The entity name
 * @param queries - Query extension metadata
 * @param config - Plugin config
 * @param registry - Symbol registry for recording cross-references
 */
function generateElysiaRoutes(
  entityName: string,
  queries: EntityQueriesExtension,
  config: ResolvedHttpElysiaConfig,
  registry: SymbolRegistryService,
  inflection: CoreInflection,
): {
  initExpr: n.Expression;
  imports: ExternalImport[];
} {
  // Use inflection.entityRoutePath which handles pluralization and kebab-casing
  const prefix = inflection.entityRoutePath(entityName);

  // Build prefix: ensure proper slashes with basePath
  const basePath = config.basePath.replace(/^\/+|\/+$/g, ""); // trim slashes
  const fullPrefix = basePath ? `/${basePath}${prefix}` : prefix;

  const initialChainExpr: n.Expression = b.newExpression(b.identifier("Elysia"), [
    conjure.obj().prop("prefix", b.stringLiteral(fullPrefix)).build(),
  ]);
  const chainExpr = queries.methods.reduce((chain, method) => {
    // Record cross-reference for this query method via registry
    // This allows emit phase to generate the import automatically
    // Use generic prefix - registry resolves to implementation (e.g., queries:kysely:...)
    const methodCapability = `queries:${entityName}:${getMethodCapabilitySuffix(method, entityName, inflection)}`;
    if (registry.has(methodCapability)) {
      registry.import(methodCapability).ref();
    }

    const queryHandle = registry.import(methodCapability);
    const {
      httpMethod,
      path,
      handler,
      bodySchemaName: routeBodySchema,
      options,
    } = buildRouteCall(method, entityName, inflection, queryHandle, registry);

    if (routeBodySchema) {
      // Use registry to import schema - this ensures correct relative path resolution
      // Use generic prefix - registry resolves to implementation (e.g., schema:zod:...)
      const schemaCapability = `schema:${routeBodySchema}`;
      if (registry.has(schemaCapability)) {
        registry.import(schemaCapability).ref();
      }
    }

    // Build route call: .get(path, handler) or .post(path, handler, { body: Schema })
    const callArgs: n.Expression[] = [b.stringLiteral(path), handler];
    if (options) {
      callArgs.push(options);
    }

    return b.callExpression(
      b.memberExpression(cast.toExpr(chain), b.identifier(httpMethod)),
      callArgs.map(cast.toExpr),
    );
  }, initialChainExpr);

  // Only external package imports go here; query and schema imports are handled via cross-references
  const imports: ExternalImport[] = [
    { from: "elysia", names: ["Elysia"] },
  ];

  return {
    initExpr: chainExpr,
    imports,
  };
}


/**
 * Generate the aggregator app init expression.
 * Returns the init expression for the app variable (not the full statement).
 */
function generateAggregatorExpr(
  entities: Map<string, EntityQueriesExtension>,
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

  const chainExpr = entityEntries.reduce((chain, [entityName]) => {
    const routesVarName = inflection.variableName(entityName, "Routes");
    const routeCapability = `http-routes:elysia:${entityName}`;

    if (registry.has(routeCapability)) {
      registry.import(routeCapability).ref();
    }

    return b.callExpression(b.memberExpression(cast.toExpr(chain), b.identifier("use")), [
      b.identifier(routesVarName),
    ]);
  }, b.newExpression(b.identifier("Elysia"), []) as n.Expression);

  return {
    initExpr: chainExpr,
    imports: [{ from: "elysia", names: ["Elysia"] }],
  };
}

export function elysia(config?: HttpElysiaConfig): Plugin {
  const schemaConfig = S.decodeSync(HttpElysiaConfigSchema)(config ?? {});

  // Resolve FileNaming functions (Schema can't validate these)
  const resolvedConfig: ResolvedHttpElysiaConfig = {
    outputDir: schemaConfig.outputDir,
    basePath: schemaConfig.basePath,
    routesFile: normalizeFileNaming(config?.routesFile, DEFAULT_ROUTES_FILE),
    appFile: normalizeFileNaming(config?.appFile, DEFAULT_APP_FILE),
  };

  return {
    name: PLUGIN_NAME,

    provides: [],

    fileDefaults: [
      // Entity routes use routesFile config
      {
        pattern: "http-routes:elysia:",
        outputDir: resolvedConfig.outputDir,
        fileNaming: resolvedConfig.routesFile,
      },
      // App aggregator uses appFile config (more specific pattern wins)
      {
        pattern: "http-routes:elysia:app",
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

      const entityQueries = buildEntityQueriesMap(extensions);
      const statements: n.Statement[] = [];

      // Generate routes for each entity
      for (const [entityName, queries] of entityQueries.entries()) {
        const entity = ir.entities.get(entityName);
        if (!entity || !isTableEntity(entity)) continue;

        const capability = `http-routes:elysia:${entityName}`;
        // Scope ref tracking to this capability
        const { initExpr, imports } = registry.forSymbol(capability, () =>
          generateElysiaRoutes(entityName, queries, resolvedConfig, registry, inflection),
        );

        const routeStmt = yield* cj.exp.const(
          inflection.variableName(entityName, "Routes"),
          initExpr,
          { capability, imports, baseEntityName: entityName },
        );
        statements.push(routeStmt);
      }

      // Generate aggregator app if we have any routes
      if (entityQueries.size > 0) {
        const appCapability = "http-routes:elysia:app";
        // Scope ref tracking to this capability
        const { initExpr, imports } = registry.forSymbol(appCapability, () =>
          generateAggregatorExpr(entityQueries, registry, inflection),
        );

        if (initExpr) {
          const appStmt = yield* cj.exp.const("elysiaApp", initExpr, {
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

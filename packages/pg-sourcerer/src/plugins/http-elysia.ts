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

import type { Plugin, SymbolDeclaration, RenderedSymbol, SymbolHandle } from "../runtime/types.js";
import { IR } from "../services/ir.js";
import { Inflection, type CoreInflection } from "../services/inflection.js";
import { SymbolRegistry, type SymbolRegistryService } from "../runtime/registry.js";
import { isTableEntity } from "../ir/semantic-ir.js";
import { conjure, cast } from "../conjure/index.js";
import type {
  QueryMethod,
  QueryMethodParam,
  EntityQueriesExtension,
} from "../ir/extensions/queries.js";
import type { SchemaBuilderResult } from "../ir/extensions/schema-builder.js";
import type { ExternalImport } from "../runtime/emit.js";
import { type FileNaming, normalizeFileNaming } from "../runtime/file-assignment.js";
import {
  buildQueryInvocation,
  coerceParam,
  defaultHttpMethodMap,
  getBodySchemaName,
  getRoutePath,
  kindToHttpMethod,
  listByRouteFromName,
  needsCoercion,
  toExternalImport,
} from "./shared/http-helpers.js";
import { getSchemaBuilder } from "./shared/schema-builder.js";

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

function buildHandlerBody(
  method: QueryMethod,
  schemas: ValidationSchemas,
  queryHandle: SymbolHandle,
): n.Statement[] {
  const callSig = method.callSignature ?? { style: "named" };
  const statements: n.Statement[] = [];
  const args: n.Expression[] = [];
  const paramConsume = schemas.paramSchema?.consume;
  const queryConsume = schemas.querySchema?.consume;
  const bodyConsume = schemas.bodyConsume;

  const pathParams = method.params.filter(
    p => p.source === "pk" || p.source === "fk" || p.source === "lookup",
  );
  const queryParams = method.params.filter(p => p.source === "pagination");

  if (pathParams.length > 0 && paramConsume) {
    statements.push(stmt.const("parsedParams", paramConsume(b.identifier("params"))));
  }

  if (queryParams.length > 0 && queryConsume) {
    statements.push(stmt.const("parsedQuery", queryConsume(b.identifier("query"))));
  }

  const needsBody =
    method.params.some(p => p.source === "body") ||
    method.kind === "create" ||
    method.kind === "update" ||
    (method.kind === "function" && method.params.some(p => !p.source));

  if (needsBody && bodyConsume) {
    statements.push(stmt.const("parsedBody", bodyConsume(b.identifier("body"))));
  }

  const paramExpr = (param: QueryMethodParam): n.Expression => {
    if (param.source === "body") {
      return bodyConsume ? b.identifier("parsedBody") : b.identifier("body");
    }

    if (param.source === "pagination") {
      if (queryConsume) {
        return b.memberExpression(b.identifier("parsedQuery"), b.identifier(param.name));
      }
      return needsCoercion(param)
        ? coerceParam(param.name, param.type)
        : b.memberExpression(b.identifier("query"), b.identifier(param.name));
    }

    if (param.source === "pk" || param.source === "fk" || param.source === "lookup") {
      if (paramConsume) {
        return b.memberExpression(b.identifier("parsedParams"), b.identifier(param.name));
      }
      return needsCoercion(param)
        ? coerceParam(param.name, param.type)
        : b.memberExpression(b.identifier("params"), b.identifier(param.name));
    }

    return b.memberExpression(b.identifier("body"), b.identifier(param.name));
  };

  if (callSig.style === "positional") {
    for (const param of method.params) {
      args.push(paramExpr(param));
    }
  } else {
    const bodyParam = method.params.find(p => p.source === "body");
    const nonBodyParams = method.params.filter(p => p.source && p.source !== "body");
    const bodyExpr = bodyConsume ? b.identifier("parsedBody") : b.identifier("body");

    if (bodyParam && callSig.bodyStyle === "spread") {
      if (nonBodyParams.length > 0) {
        let objBuilder = conjure.obj();
        for (const param of nonBodyParams) {
          objBuilder = objBuilder.prop(param.name, paramExpr(param));
        }
        objBuilder = objBuilder.spread(bodyExpr);
        args.push(objBuilder.build());
      } else {
        args.push(bodyExpr);
      }
    } else if (bodyParam && callSig.bodyStyle === "property") {
      let objBuilder = conjure.obj();

      for (const param of method.params) {
        if (param.source && param.source !== "body") {
          objBuilder = objBuilder.prop(param.name, paramExpr(param));
        }
      }

      objBuilder = objBuilder.prop(
        bodyParam.name,
        bodyConsume ? b.identifier("parsedBody") : b.identifier("body"),
      );
      args.push(objBuilder.build());
    } else {
      let objBuilder = conjure.obj();

      for (const param of method.params) {
        if (param.source && param.source !== "body") {
          objBuilder = objBuilder.prop(param.name, paramExpr(param));
        }
      }

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
    return [...statements, resultDecl, notFoundCheck, b.returnStatement(b.identifier("result"))];
  }

  return [...statements, resultDecl, b.returnStatement(b.identifier("result"))];
}

const elysiaMethodMap = {
  ...defaultHttpMethodMap,
  update: "patch",
};

type ConsumeFn = (input: n.Expression) => n.Expression;

interface ValidationSchemas {
  readonly paramSchema?: SchemaBuilderResult;
  readonly querySchema?: SchemaBuilderResult;
  readonly bodyConsume?: ConsumeFn;
}

function buildRouteCall(
  method: QueryMethod,
  entityName: string,
  inflection: CoreInflection,
  queryHandle: SymbolHandle,
  schemas: ValidationSchemas,
): {
  httpMethod: string;
  path: string;
  handler: n.ArrowFunctionExpression;
  needsBody: boolean;
  bodySchemaName: string | null;
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

  const handlerBody = buildHandlerBody(method, schemas, queryHandle);
  const handler = b.arrowFunctionExpression(
    [handlerParamPattern],
    b.blockStatement(handlerBody.map(cast.toStmt)),
  );
  handler.async = true;

  // Build route options with body schema validation
  const bodySchemaName = getBodySchemaName(method, entityName);
  let options: n.ObjectExpression | null = null;
  if (bodySchemaName) {
    // { body: EntityInsert } or { body: EntityUpdate }
    options = conjure.obj().prop("body", b.identifier(bodySchemaName)).build();
  }

  return { httpMethod, path, handler, needsBody, bodySchemaName, options };
}

/**
 * Generate Elysia routes for an entity.
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
  statements: n.Statement[];
  externalImports: ExternalImport[];
} {
  // Use inflection.entityRoutePath which handles pluralization and kebab-casing
  const prefix = inflection.entityRoutePath(entityName);
  // Use same name as the symbol declaration for consistency with cross-references
  const routesVarName = inflection.variableName(entityName, "ElysiaRoutes");

  // Build prefix: ensure proper slashes with basePath
  const basePath = config.basePath.replace(/^\/+|\/+$/g, ""); // trim slashes
  const fullPrefix = basePath ? `/${basePath}${prefix}` : prefix;

  let chainExpr: n.Expression = b.newExpression(b.identifier("Elysia"), [
    conjure.obj().prop("prefix", b.stringLiteral(fullPrefix)).build(),
  ]);
  const schemaBuilder = getSchemaBuilder(registry);
  const schemaImports: ExternalImport[] = [];

  for (const method of queries.methods) {
    // Record cross-reference for this query method via registry
    // This allows emit phase to generate the import automatically
    // Use generic prefix - registry resolves to implementation (e.g., queries:kysely:...)
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
    if (paramSchema) {
      schemaImports.push(toExternalImport(paramSchema.importSpec));
    }

    const querySchema =
      schemaBuilder && queryParams.length > 0
        ? schemaBuilder.build({ variant: "query", params: queryParams })
        : undefined;
    if (querySchema) {
      schemaImports.push(toExternalImport(querySchema.importSpec));
    }

    const bodySchemaName = getBodySchemaName(method, entityName);
    const bodySchema =
      bodySchemaName && registry.has(`schema:${bodySchemaName}`)
        ? registry.import(`schema:${bodySchemaName}`)
        : undefined;
    const bodyConsume = bodySchema?.consume
      ? (input: n.Expression) => bodySchema.consume!(input) as n.Expression
      : undefined;

    const queryHandle = registry.import(methodCapability);
    const {
      httpMethod,
      path,
      handler,
      bodySchemaName: routeBodySchema,
      options,
    } = buildRouteCall(method, entityName, inflection, queryHandle, {
      paramSchema,
      querySchema,
      bodyConsume,
    });

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

    chainExpr = b.callExpression(
      b.memberExpression(cast.toExpr(chainExpr), b.identifier(httpMethod)),
      callArgs.map(cast.toExpr),
    );
  }

  const variableDeclarator = b.variableDeclarator(
    b.identifier(routesVarName),
    cast.toExpr(chainExpr),
  );
  const variableDeclaration = b.variableDeclaration("const", [variableDeclarator]);

  // Only external package imports go here; query and schema imports are handled via cross-references
  const externalImports: ExternalImport[] = [
    { from: "elysia", names: ["Elysia"] },
    ...schemaImports,
  ];

  return {
    statements: [variableDeclaration as n.Statement],
    externalImports,
  };
}

/**
 * Get the capability suffix for a query method.
 * E.g., "findById", "list", "create", "update", "delete", "findByEmail"
 */
function getMethodCapabilitySuffix(
  method: QueryMethod,
  entityName: string,
  inflection: CoreInflection,
): string {
  // The capability suffix is derived from the method name
  // e.g., "userFindById" -> "findById", "userList" -> "list"
  // We use generic capabilities that the registry resolves to the implementation.

  // Generic capabilities (resolved by registry):
  // - queries:User:findById → queries:kysely:User:findById (if kysely provides)
  // - queries:User:list → queries:kysely:User:list
  // - queries:User:create → queries:kysely:User:create
  // - queries:User:update → queries:kysely:User:update
  // - queries:User:delete → queries:kysely:User:delete
  // - queries:User:findByEmail → queries:kysely:User:findByEmail

  // The method.name is like "userFindById", "userList", etc.
  // We need to extract just the operation part

  // Method kinds map to capability suffixes:
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
      // For lookups, the suffix is like "findByEmail" where Email is the field
      if (method.lookupField) {
        const pascalField = inflection.pascalCase(method.lookupField);
        return `findBy${pascalField}`;
      }
      return "lookup";
    case "function":
      return method.name;
  }
}

function generateAggregator(
  entities: Map<string, EntityQueriesExtension>,
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

  let chainExpr: n.Expression = b.newExpression(b.identifier("Elysia"), []);

  const externalImports: ExternalImport[] = [{ from: "elysia", names: ["Elysia"] }];

  for (const [entityName, queries] of entityEntries) {
    // Use same name as the symbol declaration for consistency with cross-references
    const routesVarName = inflection.variableName(entityName, "ElysiaRoutes");

    chainExpr = b.callExpression(b.memberExpression(cast.toExpr(chainExpr), b.identifier("use")), [
      b.identifier(routesVarName),
    ]);

    // Record cross-reference to the entity's routes capability
    // The emit phase will generate the import automatically
    const routeCapability = `http-routes:elysia:${entityName}`;
    if (registry.has(routeCapability)) {
      registry.import(routeCapability).ref();
    }
  }

  const variableDeclarator = b.variableDeclarator(b.identifier("app"), cast.toExpr(chainExpr));
  const variableDeclaration = b.variableDeclaration("const", [variableDeclarator]);

  return {
    statements: [variableDeclaration as n.Statement],
    externalImports,
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

    declare: Effect.gen(function* () {
      const ir = yield* IR;
      const inflection = yield* Inflection;

      const declarations: SymbolDeclaration[] = [];

      // Declare routes for all table entities that might have queries
      // The actual routes generated depend on what queries exist at render time
      for (const entity of ir.entities.values()) {
        if (!isTableEntity(entity)) continue;
        if (entity.tags.omit === true) continue;

        // If entity has any CRUD permissions, it could have queries
        const hasAnyPermissions =
          entity.permissions.canSelect ||
          entity.permissions.canInsert ||
          entity.permissions.canUpdate ||
          entity.permissions.canDelete;

        if (hasAnyPermissions) {
          declarations.push({
            name: inflection.variableName(entity.name, "ElysiaRoutes"),
            capability: `http-routes:elysia:${entity.name}`,
            baseEntityName: entity.name,
          });
        }
      }

      // Also declare the aggregator
      declarations.push({
        name: "elysiaApp",
        capability: "http-routes:elysia:app",
      });

      return declarations;
    }),

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const registry = yield* SymbolRegistry;
      const inflection = yield* Inflection;

      const rendered: RenderedSymbol[] = [];

      // Query the registry for all entity query capabilities
      // Use generic prefix - registry resolves to implementation provider
      const entityQueries = new Map<string, EntityQueriesExtension>();
      const queryCapabilities = registry.query("queries:");

      for (const decl of queryCapabilities) {
        // Only look at aggregate capabilities (queries:impl:EntityName, not queries:impl:EntityName:method)
        const parts = decl.capability.split(":");
        if (parts.length !== 3) continue; // Skip method-specific capabilities

        const entityName = parts[2]!;
        const metadata = registry.getMetadata(decl.capability);
        if (metadata && typeof metadata === "object" && "methods" in metadata) {
          entityQueries.set(entityName, metadata as EntityQueriesExtension);
        }
      }

      for (const [entityName, queries] of entityQueries) {
        const entity = ir.entities.get(entityName);
        if (!entity || !isTableEntity(entity)) continue;

        const capability = `http-routes:elysia:${entityName}`;

        // Scope cross-references to this specific capability
        const { statements, externalImports } = registry.forSymbol(capability, () =>
          generateElysiaRoutes(entityName, queries, resolvedConfig, registry, inflection),
        );

        rendered.push({
          name: inflection.variableName(entityName, "ElysiaRoutes"),
          capability,
          node: statements[0],
          exports: "named",
          externalImports,
        });
      }

      if (entityQueries.size > 0) {
        const appCapability = "http-routes:elysia:app";

        // Scope cross-references to the app capability
        const { statements, externalImports } = registry.forSymbol(appCapability, () =>
          generateAggregator(entityQueries, registry, inflection),
        );

        rendered.push({
          name: "elysiaApp",
          capability: appCapability,
          node: statements[0],
          exports: "named",
          externalImports,
        });
      }

      return rendered;
    }),
  };
}

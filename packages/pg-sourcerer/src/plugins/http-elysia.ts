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
import { Effect, Array as Arr, pipe, Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";

import type { Plugin, SymbolDeclaration, RenderedSymbol } from "../runtime/types.js";
import { IR } from "../services/ir.js";
import { SymbolRegistry, type SymbolRegistryService } from "../runtime/registry.js";
import { isTableEntity, type TableEntity } from "../ir/semantic-ir.js";
import { QueryMethodKind } from "../ir/extensions/queries.js";
import { conjure, cast } from "../conjure/index.js";
import type { QueryMethod, QueryMethodParam, EntityQueriesExtension } from "../ir/extensions/queries.js";
import type { ExternalImport } from "../runtime/emit.js";
import { type FileNaming, type FileNamingContext, normalizeFileNaming } from "../runtime/file-assignment.js";

const b = conjure.b;

const PLUGIN_NAME = "elysia-http";

/**
 * Coerce a URL param (always string) to the expected type.
 * Returns an expression that wraps the identifier with the appropriate coercion.
 */
function coerceParam(paramName: string, paramType: string): n.Expression {
  const ident = b.identifier(paramName);
  const lowerType = paramType.toLowerCase();

  // Numeric types
  if (lowerType === "number" || lowerType === "int" || lowerType === "integer" || lowerType === "bigint") {
    return b.callExpression(b.identifier("Number"), [ident]);
  }

  // Date types
  if (lowerType === "date" || lowerType.includes("timestamp") || lowerType.includes("datetime")) {
    return b.newExpression(b.identifier("Date"), [ident]);
  }

  // Boolean
  if (lowerType === "boolean" || lowerType === "bool") {
    // "true" -> true, anything else -> false
    return b.binaryExpression("===", ident, b.stringLiteral("true"));
  }

  // String, UUID, and other types - no coercion needed
  return ident;
}

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

function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function toCamelCase(str: string): string {
  return str.charAt(0).toLowerCase() + str.slice(1);
}

function toPluralKebabCase(entityName: string): string {
  const singular = toKebabCase(entityName);
  return singular.endsWith("y")
    ? singular.slice(0, -1) + "ies"
    : singular + "s";
}

const kindToHttpMethod = (kind: QueryMethodKind): string => {
  switch (kind) {
    case "read":
    case "list":
    case "lookup":
      return "get";
    case "create":
      return "post";
    case "update":
      return "patch";
    case "delete":
      return "delete";
    case "function":
      return "post";
  }
};

const getRoutePath = (method: QueryMethod, entityName: string): string => {
  switch (method.kind) {
    case "read":
    case "update":
    case "delete": {
      const pkParam = method.params.find((p) => p.source === "pk");
      const paramName = pkParam?.name ?? "id";
      return `/:${paramName}`;
    }
    case "list":
    case "create":
      return "/";
    case "lookup": {
      const field = method.lookupField ?? "field";
      const fieldKebab = toKebabCase(field);
      const lookupParam = method.params.find((p) => p.source === "lookup" || p.source === "fk");
      const paramName = lookupParam?.name ?? field;
      return `/by-${fieldKebab}/:${paramName}`;
    }
    case "function": {
      return `/${toKebabCase(method.name)}`;
    }
  }
};

function buildHandlerBody(method: QueryMethod): n.Statement[] {
  const callSig = method.callSignature ?? { style: "named" };

  const args: n.Expression[] = [];

  if (callSig.style === "positional") {
    for (const param of method.params) {
      if (needsCoercion(param)) {
        // URL params need coercion to their expected type
        args.push(coerceParam(param.name, param.type));
      } else if (param.source === "body") {
        args.push(b.identifier("body"));
      } else {
        args.push(
          b.memberExpression(b.identifier("body"), b.identifier(param.name)),
        );
      }
    }
  } else {
    const bodyParam = method.params.find((p) => p.source === "body");

    if (bodyParam && callSig.bodyStyle === "spread") {
      args.push(b.identifier("body"));
    } else if (bodyParam && callSig.bodyStyle === "property") {
      let objBuilder = conjure.obj();

      for (const param of method.params) {
        if (needsCoercion(param)) {
          // URL params need coercion - use prop() instead of shorthand()
          objBuilder = objBuilder.prop(param.name, coerceParam(param.name, param.type));
        }
      }

      objBuilder = objBuilder.prop(bodyParam.name, b.identifier("body"));
      args.push(objBuilder.build());
    } else {
      let objBuilder = conjure.obj();

      for (const param of method.params) {
        if (needsCoercion(param)) {
          // URL params need coercion - use prop() instead of shorthand()
          objBuilder = objBuilder.prop(param.name, coerceParam(param.name, param.type));
        }
      }

      if (method.params.length > 0) {
        args.push(objBuilder.build());
      }
    }
  }

  // Call the query function directly since we use named imports
  const queryCall = b.callExpression(
    b.identifier(method.name),
    args.map(cast.toExpr),
  );

  // Add the appropriate .execute*() method based on query kind
  // - read/lookup(unique): .executeTakeFirst() - returns single row or undefined
  // - list/lookup(non-unique): .execute() - returns array
  // - create/update: .executeTakeFirstOrThrow() - returns single row, throws if not found
  // - delete: .execute() - just executes
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
  const resultDecl = stmt.const("result", awaitExpr);

  if (method.kind === "read" || (method.kind === "lookup" && method.isUniqueLookup)) {
    const statusCall = b.callExpression(
      b.identifier("status"),
      [b.numericLiteral(404), b.stringLiteral("Not found")],
    );
    const notFoundCheck = b.ifStatement(
      b.unaryExpression("!", b.identifier("result")),
      b.returnStatement(statusCall),
    );
    return [resultDecl, notFoundCheck, b.returnStatement(b.identifier("result"))];
  }

  return [resultDecl, b.returnStatement(b.identifier("result"))];
}

const stmt = conjure.stmt;

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

function buildRouteCall(
  method: QueryMethod,
  entityName: string,
): {
  httpMethod: string;
  path: string;
  handler: n.ArrowFunctionExpression;
  needsBody: boolean;
  bodySchemaName: string | null;
  options: n.ObjectExpression | null;
} {
  const httpMethod = kindToHttpMethod(method.kind);
  const path = getRoutePath(method, entityName);

  const handlerProps: n.Property[] = [];

  const pathParams = method.params.filter(
    (p) =>
      p.source === "pk" || p.source === "fk" || p.source === "lookup",
  );
  if (pathParams.length > 0) {
    const paramsPattern = b.objectPattern(
      pathParams.map((p) => {
        const prop = b.property("init", b.identifier(p.name), b.identifier(p.name));
        prop.shorthand = true;
        return prop;
      }),
    );
    handlerProps.push(b.property("init", b.identifier("params"), paramsPattern));
  }

  const needsBody =
    method.params.some((p) => p.source === "body") ||
    method.kind === "create" ||
    method.kind === "update" ||
    (method.kind === "function" && method.params.some((p) => !p.source));
  if (needsBody) {
    const prop = b.property("init", b.identifier("body"), b.identifier("body"));
    prop.shorthand = true;
    handlerProps.push(prop);
  }

  const paginationParams = method.params.filter(
    (p) => p.source === "pagination",
  );
  if (paginationParams.length > 0) {
    const queryPattern = b.objectPattern(
      paginationParams.map((p) => {
        const prop = b.property("init", b.identifier(p.name), b.identifier(p.name));
        prop.shorthand = true;
        return prop;
      }),
    );
    handlerProps.push(b.property("init", b.identifier("query"), queryPattern));
  }

  if (method.kind === "read" || (method.kind === "lookup" && method.isUniqueLookup)) {
    const prop = b.property("init", b.identifier("status"), b.identifier("status"));
    prop.shorthand = true;
    handlerProps.push(prop);
  }

  const handlerParamPattern = b.objectPattern(handlerProps);

  const handlerBody = buildHandlerBody(method);
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
    options = conjure
      .obj()
      .prop("body", b.identifier(bodySchemaName))
      .build();
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
): {
  statements: n.Statement[];
  externalImports: ExternalImport[];
} {
  const pathSegment = toPluralKebabCase(entityName);
  // Use same name as the symbol declaration for consistency with cross-references
  const routesVarName = `${toCamelCase(entityName)}ElysiaRoutes`;

  // Build prefix: ensure proper slashes
  const basePath = config.basePath.replace(/^\/+|\/+$/g, ""); // trim slashes
  const prefix = basePath ? `/${basePath}/${pathSegment}` : `/${pathSegment}`;

  let chainExpr: n.Expression = b.newExpression(b.identifier("Elysia"), [
    conjure
      .obj()
      .prop("prefix", b.stringLiteral(prefix))
      .build(),
  ]);

  for (const method of queries.methods) {
    // Record cross-reference for this query method via registry
    // This allows emit phase to generate the import automatically
    // Use generic prefix - registry resolves to implementation (e.g., queries:kysely:...)
    const methodCapability = `queries:${entityName}:${getMethodCapabilitySuffix(method)}`;
    if (registry.has(methodCapability)) {
      registry.import(methodCapability).ref();
    }

    const { httpMethod, path, handler, bodySchemaName, options } = buildRouteCall(
      method,
      entityName,
    );

    if (bodySchemaName) {
      // Use registry to import schema - this ensures correct relative path resolution
      // Use generic prefix - registry resolves to implementation (e.g., schema:zod:...)
      const schemaCapability = `schema:${bodySchemaName}`;
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
function getMethodCapabilitySuffix(method: QueryMethod): string {
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
        const pascalField = method.lookupField
          .split("_")
          .map(s => s.charAt(0).toUpperCase() + s.slice(1))
          .join("");
        return `findBy${pascalField}`;
      }
      return "lookup";
    case "function":
      return method.name;
  }
}

function generateAggregator(
  entities: Map<string, EntityQueriesExtension>,
  config: ResolvedHttpElysiaConfig,
  registry: SymbolRegistryService,
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
    const routesVarName = `${toCamelCase(entityName)}ElysiaRoutes`;

    chainExpr = b.callExpression(
      b.memberExpression(cast.toExpr(chainExpr), b.identifier("use")),
      [b.identifier(routesVarName)],
    );

    // Record cross-reference to the entity's routes capability
    // The emit phase will generate the import automatically
    const routeCapability = `http-routes:elysia:${entityName}`;
    if (registry.has(routeCapability)) {
      registry.import(routeCapability).ref();
    }
  }

  const variableDeclarator = b.variableDeclarator(
    b.identifier("app"),
    cast.toExpr(chainExpr),
  );
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
            name: `${toCamelCase(entity.name)}ElysiaRoutes`,
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
          generateElysiaRoutes(
            entityName,
            queries,
            resolvedConfig,
            registry,
          ),
        );

        rendered.push({
          name: `${toCamelCase(entityName)}ElysiaRoutes`,
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
          generateAggregator(
            entityQueries,
            resolvedConfig,
            registry,
          ),
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

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
import { Effect, Array as Arr, pipe, Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";

import type { Plugin, SymbolDeclaration, RenderedSymbol } from "../runtime/types.js";
import { IR } from "../services/ir.js";
import { Inflection, type CoreInflection } from "../services/inflection.js";
import { inflect } from "../services/inflection.js";
import { SymbolRegistry, type SymbolRegistryService } from "../runtime/registry.js";
import { isTableEntity, type TableEntity } from "../ir/semantic-ir.js";
import { QueryMethodKind } from "../ir/extensions/queries.js";
import { conjure, cast } from "../conjure/index.js";
import type { QueryMethod, QueryMethodParam, EntityQueriesExtension } from "../ir/extensions/queries.js";
import type { ExternalImport } from "../runtime/emit.js";
import { type FileNaming, type FileNamingContext, normalizeFileNaming } from "../runtime/file-assignment.js";

const b = conjure.b;

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

const kindToHttpMethod = (kind: QueryMethodKind): string => {
  switch (kind) {
    case "read":
    case "list":
    case "lookup":
      return "get";
    case "create":
      return "post";
    case "update":
      return "put";
    case "delete":
      return "delete";
    case "function":
      return "post";
  }
};

const getRoutePath = (method: QueryMethod, entityName: string, inflection: CoreInflection): string => {
  switch (method.kind) {
    case "read":
    case "update":
    case "delete": {
      const pkParam = method.params.find((p) => p.source === "pk");
      const paramName = pkParam?.name ?? "id";
      return `/:${paramName}`;
    }
    case "list":
      return "/";
    case "create":
      return "/";
    case "lookup": {
      const field = method.lookupField ?? "field";
      const lookupParam = method.params.find((p) => p.source === "lookup" || p.source === "fk");
      const paramName = lookupParam?.name ?? field;
      const kebab = inflection.kebabCase(field);
      return `/by-${kebab}/:${paramName}`;
    }
    case "function": {
      return `/${inflection.kebabCase(method.name)}`;
    }
  }
};

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

function buildHandlerBody(
  method: QueryMethod,
  inflection: CoreInflection,
): n.Statement[] {
  const callSig = method.callSignature ?? { style: "named" };
  const statements: n.Statement[] = [];

  // Extract path params: const { id } = req.params
  const pathParams = method.params.filter(
    (p) => p.source === "pk" || p.source === "fk" || p.source === "lookup",
  );
  if (pathParams.length > 0) {
    const pattern = b.objectPattern(
      pathParams.map((p) => {
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
  const queryParams = method.params.filter((p) => p.source === "pagination");
  if (queryParams.length > 0) {
    const pattern = b.objectPattern(
      queryParams.map((p) => {
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
    method.params.some((p) => p.source === "body") ||
    method.kind === "create" ||
    method.kind === "update" ||
    (method.kind === "function" && method.params.some((p) => !p.source));
  if (needsBody) {
    statements.push(
      stmt.const("body", b.memberExpression(b.identifier("req"), b.identifier("body"))),
    );
  }

  // Build the function call arguments
  const args: n.Expression[] = [];

  if (callSig.style === "positional") {
    for (const param of method.params) {
      if (needsCoercion(param)) {
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
          objBuilder = objBuilder.prop(param.name, coerceParam(param.name, param.type));
        }
      }
      objBuilder = objBuilder.prop(bodyParam.name, b.identifier("body"));
      args.push(objBuilder.build());
    } else {
      let objBuilder = conjure.obj();
      for (const param of method.params) {
        if (needsCoercion(param)) {
          objBuilder = objBuilder.prop(param.name, coerceParam(param.name, param.type));
        }
      }
      if (method.params.length > 0) {
        args.push(objBuilder.build());
      }
    }
  }

  // Call the query function: const result = await Queries.queryFn(args)
  const queryCall = b.callExpression(
    b.identifier(method.name),
    args.map(cast.toExpr),
  );
  statements.push(stmt.const("result", b.awaitExpression(queryCall)));

  // Handle 404 for read/lookup that returns null/undefined
  if (method.kind === "read" || (method.kind === "lookup" && method.isUniqueLookup)) {
    const notFoundResponse = b.callExpression(
      b.memberExpression(
        b.callExpression(
          b.memberExpression(b.identifier("res"), b.identifier("status")),
          [b.numericLiteral(404)],
        ),
        b.identifier("json"),
      ),
      [
        conjure
          .obj()
          .prop("error", b.stringLiteral("Not found"))
          .build(),
      ],
    );
    statements.push(
      b.ifStatement(
        b.unaryExpression("!", b.identifier("result")),
        b.returnStatement(notFoundResponse),
      ),
    );
  }

  // Return response: res.json(result) or res.status(201).json(result) for create
  let responseExpr: n.Expression;
  if (method.kind === "create") {
    responseExpr = b.callExpression(
      b.memberExpression(
        b.callExpression(
          b.memberExpression(b.identifier("res"), b.identifier("status")),
          [b.numericLiteral(201)],
        ),
        b.identifier("json"),
      ),
      [b.identifier("result")],
    );
  } else {
    responseExpr = b.callExpression(
      b.memberExpression(b.identifier("res"), b.identifier("json")),
      [b.identifier("result")],
    );
  }
  statements.push(b.returnStatement(cast.toExpr(responseExpr)));

  return statements;
}

function buildRouteCall(
  method: QueryMethod,
  entityName: string,
  inflection: CoreInflection,
): {
  httpMethod: string;
  path: string;
  handler: n.ArrowFunctionExpression;
} {
  const httpMethod = kindToHttpMethod(method.kind);
  const path = getRoutePath(method, entityName, inflection);

  const handlerBody = buildHandlerBody(method, inflection);
  const handler = b.arrowFunctionExpression(
    [b.identifier("req"), b.identifier("res")],
    b.blockStatement(handlerBody.map(cast.toStmt)),
  );
  handler.async = true;

  return { httpMethod, path, handler };
}

/**
 * Generate Express routes for an entity.
 *
 * @param entityName - The entity name
 * @param queries - Query extension metadata
 * @param config - Plugin config
 * @param registry - Symbol registry for recording cross-references
 * @param inflection - Inflection service for naming
 */
function generateExpressRoutes(
  entityName: string,
  queries: EntityQueriesExtension,
  config: ResolvedHttpExpressConfig,
  registry: SymbolRegistryService,
  inflection: CoreInflection,
): {
  statements: n.Statement[];
  externalImports: ExternalImport[];
} {
  const routesVarName = `${inflect.uncapitalize(entityName)}Routes`;

  let chainExpr: n.Expression = b.callExpression(b.identifier("Router"), []);

  for (const method of queries.methods) {
    const methodCapability = `queries:${entityName}:${getMethodCapabilitySuffix(method, inflection)}`;
    if (registry.has(methodCapability)) {
      registry.import(methodCapability).ref();
    }

    const { httpMethod, path, handler } = buildRouteCall(
      method,
      entityName,
      inflection,
    );

    chainExpr = b.callExpression(
      b.memberExpression(cast.toExpr(chainExpr), b.identifier(httpMethod)),
      [b.stringLiteral(path), handler],
    );
  }

  const variableDeclarator = b.variableDeclarator(
    b.identifier(routesVarName),
    cast.toExpr(chainExpr),
  );
  const variableDeclaration = b.variableDeclaration("const", [variableDeclarator]);

  const externalImports: ExternalImport[] = [
    { from: "express", names: ["Router"] },
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
function getMethodCapabilitySuffix(method: QueryMethod, inflection: CoreInflection): string {
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
  config: ResolvedHttpExpressConfig,
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

  let chainExpr: n.Expression = b.callExpression(b.identifier("Router"), []);

  const externalImports: ExternalImport[] = [{ from: "express", names: ["Router"] }];

  for (const [entityName, queries] of entityEntries) {
    const routesVarName = `${inflect.uncapitalize(entityName)}Routes`;

    chainExpr = b.callExpression(
      b.memberExpression(cast.toExpr(chainExpr), b.identifier("use")),
      [b.identifier(routesVarName)],
    );

    const routeCapability = `http-routes:express:${entityName}`;
    if (registry.has(routeCapability)) {
      registry.import(routeCapability).ref();
    }
  }

  const variableDeclarator = b.variableDeclarator(
    b.identifier("api"),
    cast.toExpr(chainExpr),
  );
  const variableDeclaration = b.variableDeclaration("const", [variableDeclarator]);

  return {
    statements: [variableDeclaration as n.Statement],
    externalImports,
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

    declare: Effect.gen(function* () {
      const ir = yield* IR;
      const inflection = yield* Inflection;

      const declarations: SymbolDeclaration[] = [];

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
            name: `${inflect.uncapitalize(entity.name)}Routes`,
            capability: `http-routes:express:${entity.name}`,
            baseEntityName: entity.name,
          });
        }
      }

      declarations.push({
        name: "api",
        capability: "http-routes:express:app",
      });

      return declarations;
    }),

    render: Effect.gen(function* () {
      const ir = yield* IR;
      const registry = yield* SymbolRegistry;
      const inflection = yield* Inflection;

      const rendered: RenderedSymbol[] = [];

      const entityQueries = new Map<string, EntityQueriesExtension>();
      const queryCapabilities = registry.query("queries:");

      for (const decl of queryCapabilities) {
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

        const capability = `http-routes:express:${entityName}`;

        const { statements, externalImports } = registry.forSymbol(capability, () =>
          generateExpressRoutes(
            entityName,
            queries,
            resolvedConfig,
            registry,
            inflection,
          ),
        );

        rendered.push({
          name: `${inflect.uncapitalize(entityName)}Routes`,
          capability,
          node: statements[0],
          exports: "named",
          externalImports,
        });
      }

      if (entityQueries.size > 0) {
        const appCapability = "http-routes:express:app";

        const { statements, externalImports } = registry.forSymbol(appCapability, () =>
          generateAggregator(
            entityQueries,
            resolvedConfig,
            registry,
            inflection,
          ),
        );

        rendered.push({
          name: "api",
          capability: appCapability,
          node: statements[0],
          exports: "default",
          externalImports,
        });
      }

      return rendered;
    }),
  };
}

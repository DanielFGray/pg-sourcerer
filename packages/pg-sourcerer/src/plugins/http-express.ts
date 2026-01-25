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

import type { Plugin, SymbolDeclaration, RenderedSymbol, SymbolHandle } from "../runtime/types.js";
import { IR } from "../services/ir.js";
import { Inflection, type CoreInflection } from "../services/inflection.js";
import { inflect } from "../services/inflection.js";
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
  getBodySchemaName,
  getRoutePath,
  kindToHttpMethod,
  needsCoercion,
  toExternalImport,
} from "./shared/http-helpers.js";
import { getSchemaBuilder } from "./shared/schema-builder.js";

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
    for (const param of method.params) {
      args.push(paramExpr(param));
    }
  } else {
    const bodyParam = method.params.find(p => p.source === "body");
    const nonBodyParams = method.params.filter(p => p.source && p.source !== "body");

    if (bodyParam && callSig.bodyStyle === "spread") {
      if (nonBodyParams.length > 0) {
        let objBuilder = conjure.obj();
        for (const param of nonBodyParams) {
          objBuilder = objBuilder.prop(param.name, paramExpr(param));
        }
        objBuilder = objBuilder.spread(b.identifier("body"));
        args.push(objBuilder.build());
      } else {
        args.push(b.identifier("body"));
      }
    } else if (bodyParam && callSig.bodyStyle === "property") {
      let objBuilder = conjure.obj();
      for (const param of method.params) {
        if (param.source && param.source !== "body") {
          objBuilder = objBuilder.prop(param.name, paramExpr(param));
        }
      }
      objBuilder = objBuilder.prop(bodyParam.name, b.identifier("body"));
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
  let responseExpr: n.Expression;
  if (method.kind === "create") {
    responseExpr = b.callExpression(
      b.memberExpression(
        b.callExpression(b.memberExpression(b.identifier("res"), b.identifier("status")), [
          b.numericLiteral(201),
        ]),
        b.identifier("json"),
      ),
      [b.identifier("result")],
    );
  } else {
    responseExpr = b.callExpression(b.memberExpression(b.identifier("res"), b.identifier("json")), [
      b.identifier("result"),
    ]);
  }
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
  const schemaBuilder = getSchemaBuilder(registry);
  const schemaImports: ExternalImport[] = [];

  for (const method of queries.methods) {
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
    const { httpMethod, path, handler } = buildRouteCall(
      method,
      entityName,
      inflection,
      {
        paramSchema,
        querySchema,
        bodyConsume,
      },
      queryHandle,
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

    chainExpr = b.callExpression(b.memberExpression(cast.toExpr(chainExpr), b.identifier("use")), [
      b.identifier(routesVarName),
    ]);

    const routeCapability = `http-routes:express:${entityName}`;
    if (registry.has(routeCapability)) {
      registry.import(routeCapability).ref();
    }
  }

  const variableDeclarator = b.variableDeclarator(b.identifier("api"), cast.toExpr(chainExpr));
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
          generateExpressRoutes(entityName, queries, resolvedConfig, registry, inflection),
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
          generateAggregator(entityQueries, resolvedConfig, registry, inflection),
        );

        rendered.push({
          name: "api",
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

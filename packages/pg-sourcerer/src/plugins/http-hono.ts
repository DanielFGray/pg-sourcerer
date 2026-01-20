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
import { Effect, Array as Arr, pipe, Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";

import type { Plugin, SymbolDeclaration, RenderedSymbol } from "../runtime/types.js";
import { IR } from "../services/ir.js";
import { Inflection, type CoreInflection } from "../services/inflection.js";
import { SymbolRegistry, type SymbolRegistryService } from "../runtime/registry.js";
import { isTableEntity, type TableEntity } from "../ir/semantic-ir.js";
import { QueryMethodKind } from "../ir/extensions/queries.js";
import { conjure, cast } from "../conjure/index.js";
import type { QueryMethod, QueryMethodParam, EntityQueriesExtension } from "../ir/extensions/queries.js";
import type {
  SchemaBuilder,
  SchemaBuilderRequest,
  SchemaBuilderResult,
} from "../ir/extensions/schema-builder.js";
import type { ExternalImport } from "../runtime/emit.js";
import { type FileNaming, type FileNamingContext, normalizeFileNaming } from "../runtime/file-assignment.js";

const b = conjure.b;

const PLUGIN_NAME = "hono-http";

const DEFAULT_OUTPUT_DIR = "";
const DEFAULT_ROUTES_FILE = "routes.ts";
const DEFAULT_APP_FILE = "routes.ts";

/**
 * Coerce a URL param (always string) to the expected type.
 * Returns an expression that wraps the identifier with the appropriate coercion.
 */
function coerceParam(paramName: string, paramType: string): n.Expression {
  const ident = b.identifier(paramName);
  const lowerType = paramType.toLowerCase();

  if (lowerType === "number" || lowerType === "int" || lowerType === "integer" || lowerType === "bigint") {
    return b.callExpression(b.identifier("Number"), [ident]);
  }

  if (lowerType === "date" || lowerType.includes("timestamp") || lowerType.includes("datetime")) {
    return b.newExpression(b.identifier("Date"), [ident]);
  }

  if (lowerType === "boolean" || lowerType === "bool") {
    return b.binaryExpression("===", ident, b.stringLiteral("true"));
  }

  return ident;
}

function needsCoercion(param: QueryMethodParam): boolean {
  return (
    param.source === "pk" ||
    param.source === "fk" ||
    param.source === "lookup" ||
    param.source === "pagination"
  );
}

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
      if (/ListBy/i.test(method.name) || /listBy/i.test(method.name)) {
        const match = method.name.match(/(?:ListBy|listBy)(.+)/i);
        if (match && match[1]) {
          const columnKebab = inflection.kebabCase(match[1]);
          return `/by-${columnKebab}`;
        }
      }
      return "/";
    case "create":
      return "/";
    case "lookup": {
      const field = method.lookupField ?? "field";
      const fieldKebab = inflection.kebabCase(field);
      const lookupParam = method.params.find((p) => p.source === "lookup" || p.source === "fk");
      const paramName = lookupParam?.name ?? field;
      return `/by-${fieldKebab}/:${paramName}`;
    }
    case "function": {
      return `/${inflection.kebabCase(method.name)}`;
    }
  }
};

function buildHandlerBody(method: QueryMethod): n.Statement[] {
  const callSig = method.callSignature ?? { style: "named" };
  const statements: n.Statement[] = [];

  const args: n.Expression[] = [];

  if (callSig.style === "positional") {
    for (const param of method.params) {
      if (needsCoercion(param)) {
        args.push(coerceParam(param.name, param.type));
      } else if (param.source === "body") {
        args.push(b.identifier("body"));
      } else {
        args.push(b.memberExpression(b.identifier("body"), b.identifier(param.name)));
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

  const queryCall = b.callExpression(
    b.identifier(method.name),
    args.map(cast.toExpr),
  );

  const awaitExpr = b.awaitExpression(queryCall);
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

const stmt = conjure.stmt;

function getBodySchemaName(method: QueryMethod, entityName: string): string | null {
  if (method.kind === "create") {
    return `${entityName}Insert`;
  }
  if (method.kind === "update") {
    return `${entityName}Update`;
  }
  return null;
}

/**
 * Build sValidator('target', schema) middleware call.
 */
function buildSValidator(target: string, schema: n.Expression): n.Expression {
  return b.callExpression(
    b.identifier("sValidator"),
    [b.stringLiteral(target), cast.toExpr(schema)],
  );
}

interface RouteCallResult {
  httpMethod: string;
  path: string;
  handler: n.ArrowFunctionExpression;
  validators: n.Expression[];
  bodySchemaName: string | null;
}

/**
 * Build a single route with optional validation middleware.
 */
function buildRouteCall(
  method: QueryMethod,
  entityName: string,
  inflection: CoreInflection,
  schemaBuilder: SchemaBuilder | undefined,
): RouteCallResult {
  const httpMethod = kindToHttpMethod(method.kind);
  const path = getRoutePath(method, entityName, inflection);
  const validators: n.Expression[] = [];

  const pathParams = method.params.filter(
    (p) => p.source === "pk" || p.source === "fk" || p.source === "lookup",
  );
  if (pathParams.length > 0 && schemaBuilder) {
    const request: SchemaBuilderRequest = { variant: "params", params: pathParams };
    const result = schemaBuilder.build(request);
    if (result) {
      validators.push(buildSValidator("param", result.ast));
    }
  }

  const queryParams = method.params.filter((p) => p.source === "pagination");
  if (queryParams.length > 0 && schemaBuilder) {
    const request: SchemaBuilderRequest = { variant: "query", params: queryParams };
    const result = schemaBuilder.build(request);
    if (result) {
      validators.push(buildSValidator("query", result.ast));
    }
  }

  const bodySchemaName = getBodySchemaName(method, entityName);
  if (bodySchemaName) {
    validators.push(buildSValidator("json", b.identifier(bodySchemaName)));
  }

  const handlerBody = buildHandlerBody(method);
  const handler = b.arrowFunctionExpression(
    [b.identifier("c")],
    b.blockStatement(handlerBody.map(cast.toStmt)),
  );
  handler.async = true;

  return { httpMethod, path, handler, validators, bodySchemaName };
}

/**
 * Generate Hono routes for an entity.
 */
function generateHonoRoutes(
  entityName: string,
  queries: EntityQueriesExtension,
  config: ResolvedHttpHonoConfig,
  registry: SymbolRegistryService,
  inflection: CoreInflection,
): {
  statements: n.Statement[];
  externalImports: ExternalImport[];
  needsSValidator: boolean;
} {
    const routesVarName = inflection.variableName(entityName, "HonoRoutes");

  let chainExpr: n.Expression = b.newExpression(b.identifier("Hono"), []);
  const schemaCapabilities: string[] = [];

  for (const method of queries.methods) {
    const methodCapability = `queries:${entityName}:${getMethodCapabilitySuffix(method, inflection)}`;
    if (registry.has(methodCapability)) {
      registry.import(methodCapability).ref();
    }

    const schemaBuilder = getSchemaBuilder(registry);
    const { httpMethod, path, handler, validators, bodySchemaName } = buildRouteCall(
      method,
      entityName,
      inflection,
      schemaBuilder,
    );

    if (bodySchemaName) {
      const schemaCapability = `schema:${bodySchemaName}`;
      if (registry.has(schemaCapability)) {
        registry.import(schemaCapability).ref();
        schemaCapabilities.push(schemaCapability);
      }
    }

    const callArgs: n.Expression[] = [b.stringLiteral(path), ...validators, handler];

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

  const externalImports: ExternalImport[] = [{ from: "hono", names: ["Hono"] }];
  const needsSValidator = schemaCapabilities.length > 0 ||
    queries.methods.some(m => m.params.some(p => p.source === "pk" || p.source === "fk" || p.source === "lookup" || p.source === "pagination"));

  return {
    statements: [variableDeclaration as n.Statement],
    externalImports,
    needsSValidator,
  };
}

/**
 * Get the capability suffix for a query method.
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

/**
 * Get the schema builder from registry if available.
 */
function getSchemaBuilder(registry: SymbolRegistryService): SchemaBuilder | undefined {
  const schemaBuilders = registry.query("schema:").filter(decl => decl.capability.endsWith(":builder"));
  if (schemaBuilders.length === 0) return undefined;

  const metadata = registry.getMetadata(schemaBuilders[0]!.capability);
  if (metadata && typeof metadata === "object" && "builder" in metadata) {
    return (metadata as { builder: SchemaBuilder }).builder;
  }
  return undefined;
}

function generateAggregator(
  entities: Map<string, EntityQueriesExtension>,
  config: ResolvedHttpHonoConfig,
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

  let chainExpr: n.Expression = b.newExpression(b.identifier("Hono"), []);
  const basePath = config.basePath.replace(/^\/+|\/+$/g, "");

  if (basePath) {
    chainExpr = b.callExpression(
      b.memberExpression(cast.toExpr(chainExpr), b.identifier("basePath")),
      [b.stringLiteral(`/${basePath}`)].map(cast.toExpr),
    );
  }

  const externalImports: ExternalImport[] = [{ from: "hono", names: ["Hono"] }];

  for (const [entityName] of entityEntries) {
  const routesVarName = inflection.variableName(entityName, "HonoRoutes");
    const routeCapability = `http-routes:hono:${entityName}`;

    const prefix = inflection.entityRoutePath(entityName);
    chainExpr = b.callExpression(
      b.memberExpression(cast.toExpr(chainExpr), b.identifier("route")),
      [b.stringLiteral(prefix), b.identifier(routesVarName)].map(cast.toExpr),
    );

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
            name: inflection.variableName(entity.name, "HonoRoutes"),
            capability: `http-routes:hono:${entity.name}`,
            baseEntityName: entity.name,
          });
        }
      }

      declarations.push({
        name: "honoApp",
        capability: "http-routes:hono:app",
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

      const allNeedsSValidator = new Set<string>();

      for (const [entityName, queries] of entityQueries) {
        const entity = ir.entities.get(entityName);
        if (!entity || !isTableEntity(entity)) continue;

        const capability = `http-routes:hono:${entityName}`;

        const { statements, externalImports, needsSValidator } = registry.forSymbol(
          capability,
          () =>
            generateHonoRoutes(
              entityName,
              queries,
              resolvedConfig,
              registry,
              inflection,
            ),
        );

        if (needsSValidator) {
          allNeedsSValidator.add(capability);
        }

        rendered.push({
          name: inflection.variableName(entityName, "HonoRoutes"),
          capability,
          node: statements[0],
          exports: "named",
          externalImports,
        });
      }

      if (entityQueries.size > 0) {
        const appCapability = "http-routes:hono:app";

        const { statements, externalImports } = registry.forSymbol(appCapability, () =>
          generateAggregator(
            entityQueries,
            resolvedConfig,
            registry,
            inflection,
          ),
        );

        rendered.push({
          name: "honoApp",
          capability: appCapability,
          node: statements[0],
          exports: "named",
          externalImports,
        });
      }

      return rendered.map((r) => {
        const needsSValidator = allNeedsSValidator.has(r.capability);
        return {
          ...r,
          externalImports: needsSValidator
            ? [
                ...(r.externalImports ?? []),
                { from: "@hono/standard-validator", names: ["sValidator"] },
              ]
            : r.externalImports,
        };
      });
    }),
  };
}

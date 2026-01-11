/**
 * HTTP Hono Plugin - Generate Hono route handlers from query plugins
 *
 * Consumes method symbols from sql-queries or kysely-queries via the symbol registry
 * and generates type-safe Hono HTTP route handlers.
 *
 * Schema validation is provided via @hono/standard-validator when a schema plugin
 * (zod, valibot, arktype) is configured. Without a schema plugin, routes are
 * generated without validation middleware.
 */
import { Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";
import { definePlugin, type PluginContext } from "../services/plugin.js";
import { conjure, cast } from "../lib/conjure.js";
import { inflect } from "../services/inflection.js";
import type { MethodSymbol } from "../services/symbols.js";
import type { QueryMethodKind, QueryMethodParam } from "../ir/extensions/queries.js";
import {
  SCHEMA_BUILDER_KIND,
  type SchemaBuilderRequest,
  type SchemaBuilderResult,
  type SchemaImportSpec,
} from "../ir/extensions/schema-builder.js";
import { getTableEntities, type TableEntity } from "../ir/semantic-ir.js";
import { TsType } from "../services/pg-types.js";

const { b, stmt } = conjure;

// ============================================================================
// Configuration
// ============================================================================

const HttpHonoConfigSchema = S.Struct({
  /** Output directory for generated route files. Default: "routes" */
  outputDir: S.optionalWith(S.String, { default: () => "routes" }),

  /** Base path for all routes. Default: "/api" */
  basePath: S.optionalWith(S.String, { default: () => "/api" }),

  /** Header content to prepend to each generated file */
  header: S.optional(S.String),

  /**
   * Name of the aggregated router export.
   * Default: "api"
   */
  aggregatorName: S.optionalWith(S.String, { default: () => "api" }),
});

/** Input config type (with optional fields) */
export type HttpHonoConfig = S.Schema.Encoded<typeof HttpHonoConfigSchema>;

// ============================================================================
// String Helpers
// ============================================================================

/** Convert PascalCase/camelCase to kebab-case */
const toKebabCase = (str: string): string =>
  str
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();

/** Convert entity name to URL path segment (kebab-case plural) */
const entityToPathSegment = (entityName: string): string =>
  inflect.pluralize(toKebabCase(entityName));

// ============================================================================
// Route Generation Helpers
// ============================================================================

/** Map query method kind to HTTP method */
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

/** Get the route path for a method */
const getRoutePath = (method: MethodSymbol): string => {
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

// ============================================================================
// Schema Validation Types
// ============================================================================

/**
 * Function type for requesting schema builder results.
 * Returns undefined if no schema builder is registered.
 */
type SchemaBuilderFn = (params: readonly QueryMethodParam[]) => SchemaBuilderResult | undefined;

/**
 * Build sValidator('target', schema) middleware call
 */
const buildSValidator = (target: string, schema: n.Expression): n.Expression =>
  b.callExpression(b.identifier("sValidator"), [b.stringLiteral(target), cast.toExpr(schema)]);

/** Schema import info needed for body validation */
interface SchemaImport {
  readonly entity: string;
  readonly shape: "insert" | "update";
  readonly schemaName: string;
}

/**
 * Determine if a method needs body validation and which schema to use.
 */
const getBodySchemaImport = (method: MethodSymbol, entityName: string): SchemaImport | null => {
  if (method.kind === "create") {
    return { entity: entityName, shape: "insert", schemaName: `${entityName}Insert` };
  }
  if (method.kind === "update") {
    return { entity: entityName, shape: "update", schemaName: `${entityName}Update` };
  }
  return null;
};

// ============================================================================
// Handler Body Generation
// ============================================================================

/**
 * Build the handler function body for a query method.
 *
 * When hasValidation is true, uses c.req.valid() for validated data.
 * Otherwise falls back to manual extraction via c.req.param/query/json.
 */
const buildHandlerBody = (method: MethodSymbol, hasValidation: boolean): n.Statement[] => {
  const statements: n.Statement[] = [];
  const callSig = method.callSignature ?? { style: "named" as const };

  const pathParams = method.params.filter(
    (p) => p.source === "pk" || p.source === "fk" || p.source === "lookup",
  );
  const queryParams = method.params.filter((p) => p.source === "pagination");
  const needsBody =
    method.params.some((p) => p.source === "body") ||
    method.kind === "create" ||
    method.kind === "update" ||
    (method.kind === "function" && method.params.some((p) => !p.source));

  if (hasValidation) {
    // Use c.req.valid() for validated data
    if (pathParams.length > 0) {
      // const { id, slug } = c.req.valid('param')
      const paramPattern = b.objectPattern(
        pathParams.map((p) => {
          const prop = b.property("init", b.identifier(p.name), b.identifier(p.name));
          prop.shorthand = true;
          return prop;
        }),
      );
      const validCall = b.callExpression(
        b.memberExpression(
          b.memberExpression(b.identifier("c"), b.identifier("req")),
          b.identifier("valid"),
        ),
        [b.stringLiteral("param")],
      );
      statements.push(
        b.variableDeclaration("const", [b.variableDeclarator(paramPattern, validCall)]),
      );
    }

    if (queryParams.length > 0) {
      // const { limit, offset } = c.req.valid('query')
      const queryPattern = b.objectPattern(
        queryParams.map((p) => {
          const prop = b.property("init", b.identifier(p.name), b.identifier(p.name));
          prop.shorthand = true;
          return prop;
        }),
      );
      const validCall = b.callExpression(
        b.memberExpression(
          b.memberExpression(b.identifier("c"), b.identifier("req")),
          b.identifier("valid"),
        ),
        [b.stringLiteral("query")],
      );
      statements.push(
        b.variableDeclaration("const", [b.variableDeclarator(queryPattern, validCall)]),
      );
    }

    if (needsBody) {
      // const body = c.req.valid('json')
      const validCall = b.callExpression(
        b.memberExpression(
          b.memberExpression(b.identifier("c"), b.identifier("req")),
          b.identifier("valid"),
        ),
        [b.stringLiteral("json")],
      );
      statements.push(stmt.const("body", validCall));
    }
  } else {
    // No validation - manual extraction
    for (const param of pathParams) {
      const paramCall = b.callExpression(
        b.memberExpression(
          b.memberExpression(b.identifier("c"), b.identifier("req")),
          b.identifier("param"),
        ),
        [b.stringLiteral(param.name)],
      );
      statements.push(stmt.const(param.name, paramCall));
    }

    for (const param of queryParams) {
      const queryCall = b.callExpression(
        b.memberExpression(
          b.memberExpression(b.identifier("c"), b.identifier("req")),
          b.identifier("query"),
        ),
        [b.stringLiteral(param.name)],
      );
      // Parse as number if needed
      if (param.type === TsType.Number) {
        const parsed = b.callExpression(b.identifier("Number"), [queryCall]);
        statements.push(stmt.const(param.name, parsed));
      } else {
        statements.push(stmt.const(param.name, queryCall));
      }
    }

    if (needsBody) {
      const jsonCall = b.callExpression(
        b.memberExpression(
          b.memberExpression(b.identifier("c"), b.identifier("req")),
          b.identifier("json"),
        ),
        [],
      );
      statements.push(stmt.const("body", b.awaitExpression(jsonCall)));
    }
  }

  // Build the function call arguments
  const args: n.Expression[] = [];

  if (callSig.style === "positional") {
    for (const param of method.params) {
      if (
        param.source === "pk" ||
        param.source === "fk" ||
        param.source === "lookup" ||
        param.source === "pagination"
      ) {
        args.push(b.identifier(param.name));
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
        if (
          param.source === "pk" ||
          param.source === "fk" ||
          param.source === "lookup" ||
          param.source === "pagination"
        ) {
          objBuilder = objBuilder.shorthand(param.name);
        }
      }
      objBuilder = objBuilder.prop(bodyParam.name, b.identifier("body"));
      args.push(objBuilder.build());
    } else {
      let objBuilder = conjure.obj();
      for (const param of method.params) {
        if (
          param.source === "pk" ||
          param.source === "fk" ||
          param.source === "lookup" ||
          param.source === "pagination"
        ) {
          objBuilder = objBuilder.shorthand(param.name);
        }
      }
      if (method.params.length > 0) {
        args.push(objBuilder.build());
      }
    }
  }

  // Build: const result = await Queries.queryFn(args)
  const queryCall = b.callExpression(
    b.memberExpression(b.identifier("Queries"), b.identifier(method.name)),
    args.map(cast.toExpr),
  );
  statements.push(stmt.const("result", b.awaitExpression(queryCall)));

  // Handle 404 for read/lookup that returns null
  if (method.kind === "read" || (method.kind === "lookup" && method.isUniqueLookup)) {
    const notFoundResponse = b.callExpression(
      b.memberExpression(b.identifier("c"), b.identifier("json")),
      [conjure.obj().prop("error", b.stringLiteral("Not found")).build(), b.numericLiteral(404)],
    );
    statements.push(
      b.ifStatement(
        b.unaryExpression("!", b.identifier("result")),
        b.returnStatement(notFoundResponse),
      ),
    );
  }

  // return c.json(result) or c.json(result, 201) for create
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
};

// ============================================================================
// Route Validation Builders
// ============================================================================

/**
 * Build validators for a route method.
 *
 * Returns:
 * - validators: Array of sValidator() middleware expressions
 * - needsSValidator: Whether to import sValidator from @hono/standard-validator
 * - bodySchema: Body schema symbol import info (for symbol registry lookup)
 * - schemaBuilderImport: Import spec for the schema library (zod, valibot, etc.)
 */
const buildRouteValidators = (
  method: MethodSymbol,
  entityName: string,
  requestSchema: SchemaBuilderFn,
  hasSchemaProvider: boolean,
): {
  validators: n.Expression[];
  needsSValidator: boolean;
  bodySchema: SchemaImport | null;
  schemaBuilderImport: SchemaImportSpec | null;
} => {
  const validators: n.Expression[] = [];
  let needsSValidator = false;
  let schemaBuilderImport: SchemaImportSpec | null = null;

  // Build param validator for path parameters
  const pathParams = method.params.filter(
    (p) => p.source === "pk" || p.source === "fk" || p.source === "lookup",
  );
  if (pathParams.length > 0) {
    const schemaResult = requestSchema(pathParams);
    if (schemaResult) {
      validators.push(buildSValidator("param", schemaResult.ast));
      needsSValidator = true;
      schemaBuilderImport = schemaResult.importSpec;
    }
  }

  // Build query validator for pagination parameters
  const queryParams = method.params.filter((p) => p.source === "pagination");
  if (queryParams.length > 0) {
    const schemaResult = requestSchema(queryParams);
    if (schemaResult) {
      validators.push(buildSValidator("query", schemaResult.ast));
      needsSValidator = true;
      if (!schemaBuilderImport) {
        schemaBuilderImport = schemaResult.importSpec;
      }
    }
  }

  // Body validation - use imported schema from schema provider
  const bodySchemaInfo = getBodySchemaImport(method, entityName);
  let bodySchema: SchemaImport | null = null;

  if (bodySchemaInfo && hasSchemaProvider) {
    // Import schema from schema provider and use it
    bodySchema = bodySchemaInfo;
    validators.push(buildSValidator("json", b.identifier(bodySchema.schemaName)));
    needsSValidator = true;
  }

  return { validators, needsSValidator, bodySchema, schemaBuilderImport };
};

/**
 * Build a single route with optional validation middleware.
 */
const buildRouteCall = (
  method: MethodSymbol,
  entityName: string,
  requestSchema: SchemaBuilderFn,
  hasSchemaProvider: boolean,
): {
  httpMethod: string;
  path: string;
  handler: n.ArrowFunctionExpression;
  validators: n.Expression[];
  needsSValidator: boolean;
  bodySchema: SchemaImport | null;
  schemaBuilderImport: SchemaImportSpec | null;
} => {
  const httpMethod = kindToHttpMethod(method.kind);
  const path = getRoutePath(method);

  const { validators, needsSValidator, bodySchema, schemaBuilderImport } = buildRouteValidators(
    method,
    entityName,
    requestSchema,
    hasSchemaProvider,
  );

  // Build handler with or without validation
  const hasValidation = validators.length > 0;
  const handlerBody = buildHandlerBody(method, hasValidation);
  const handler = b.arrowFunctionExpression(
    [b.identifier("c")],
    b.blockStatement(handlerBody.map(cast.toStmt)),
  );
  handler.async = true;

  return { httpMethod, path, handler, validators, needsSValidator, bodySchema, schemaBuilderImport };
};

// ============================================================================
// Plugin Definition
// ============================================================================

export function httpHono(config: HttpHonoConfig = {}): ReturnType<typeof definePlugin> {
  const parsed = S.decodeUnknownSync(HttpHonoConfigSchema)(config);

  return definePlugin({
    name: "http-hono",
    kind: "http-routes",
    singleton: true,

    canProvide: () => true,

    requires: () => [{ kind: "queries", params: {} }],

    optionalRequires: () => [{ kind: "schemas", params: {} }],

    provide: (_params: unknown, _deps: readonly unknown[], ctx: PluginContext): void => {
      const { outputDir, basePath, header, aggregatorName } = parsed;

      const entityNames = ctx.symbols.getEntitiesWithMethods();

      if (entityNames.length === 0) {
        return;
      }

      const generatedRoutes: Array<{ fileName: string; exportName: string; pathSegment: string }> =
        [];

      const tableEntities = getTableEntities(ctx.ir);

      for (const entityName of entityNames) {
        const entityMethods = ctx.symbols.getEntityMethods(entityName);
        if (!entityMethods || entityMethods.methods.length === 0) continue;

        const entity = tableEntities.find((e) => e.name === entityName);

        const pathSegment = entityToPathSegment(entityName);
        const filePath = `${outputDir}/${inflect.uncapitalize(entityName)}.ts`;
        const routesVarName = `${inflect.uncapitalize(entityName)}Routes`;

        const file = ctx.file(filePath);

        if (header) {
          file.header(header);
        }

        // Import Hono
        file.import({ kind: "package", names: ["Hono"], from: "hono" });

        // Import queries as namespace
        const queriesImportPath = `../${entityMethods.importPath.replace(/\.ts$/, ".js")}`;
        file.import({
          kind: "relative",
          namespace: "Queries",
          from: queriesImportPath,
        });

        // Create a schema builder function that requests from the service registry
        const requestSchema: SchemaBuilderFn = (params) => {
          if (params.length === 0) return undefined;
          try {
            const request: SchemaBuilderRequest = { variant: "params", params };
            return ctx.request<SchemaBuilderResult | undefined>(SCHEMA_BUILDER_KIND, request);
          } catch {
            // No schema-builder registered, skip validation
            return undefined;
          }
        };

        // Check if a schema provider is available for body validation
        // by checking if insert schema is registered in symbol registry
        const hasSchemaProvider = ctx.symbols.resolve({
          capability: "schemas",
          entity: entityName,
          shape: "insert",
        }) !== undefined;

        // Build the Hono route chain
        let chainExpr: n.Expression = b.newExpression(b.identifier("Hono"), []);

        let fileNeedsSValidator = false;
        const bodySchemaImports: SchemaImport[] = [];
        let schemaLibraryImport: SchemaImportSpec | null = null;

        for (const method of entityMethods.methods) {
          const { httpMethod, path, handler, validators, needsSValidator, bodySchema, schemaBuilderImport } =
            buildRouteCall(method, entityName, requestSchema, hasSchemaProvider);

          if (needsSValidator) fileNeedsSValidator = true;
          if (bodySchema) bodySchemaImports.push(bodySchema);
          if (schemaBuilderImport) schemaLibraryImport = schemaBuilderImport;

          // Build route call: .get('/path', validator1, validator2, handler)
          const callArgs: n.Expression[] = [b.stringLiteral(path), ...validators, handler];

          chainExpr = b.callExpression(
            b.memberExpression(cast.toExpr(chainExpr), b.identifier(httpMethod)),
            callArgs.map(cast.toExpr),
          );
        }

        // Add imports based on what we need
        if (fileNeedsSValidator) {
          file.import({ kind: "package", names: ["sValidator"], from: "@hono/standard-validator" });
        }

        // Import schema library (e.g., { z } from 'zod') if using schema-builder
        if (schemaLibraryImport) {
          if (schemaLibraryImport.names) {
            file.import({
              kind: "package",
              names: [...schemaLibraryImport.names],
              from: schemaLibraryImport.from,
            });
          } else if (schemaLibraryImport.namespace) {
            file.import({
              kind: "package",
              namespace: schemaLibraryImport.namespace,
              from: schemaLibraryImport.from,
            });
          }
        }

        // Import body schemas from schema plugins via symbol registry
        for (const schemaImport of bodySchemaImports) {
          file.import({
            kind: "symbol",
            ref: {
              capability: "schemas",
              entity: schemaImport.entity,
              shape: schemaImport.shape,
            },
          });
        }

        const exportStmt = conjure.export.const(routesVarName, chainExpr);
        file.ast(conjure.program(exportStmt)).emit();

        generatedRoutes.push({
          fileName: `${inflect.uncapitalize(entityName)}.js`,
          exportName: routesVarName,
          pathSegment,
        });
      }

      // Generate aggregator index.ts
      if (generatedRoutes.length > 0) {
        const indexPath = `${outputDir}/index.ts`;
        const indexFile = ctx.file(indexPath);

        if (header) {
          indexFile.header(header);
        }

        indexFile.import({ kind: "package", names: ["Hono"], from: "hono" });

        for (const route of generatedRoutes) {
          indexFile.import({
            kind: "relative",
            names: [route.exportName],
            from: `./${route.fileName}`,
          });
        }

        // Build: new Hono().basePath('/api').route('/users', userRoutes).route('/posts', postRoutes)...
        let chainExpr: n.Expression = b.newExpression(b.identifier("Hono"), []);

        // Add basePath
        chainExpr = b.callExpression(
          b.memberExpression(cast.toExpr(chainExpr), b.identifier("basePath")),
          [b.stringLiteral(basePath)],
        );

        // Add routes
        for (const route of generatedRoutes) {
          chainExpr = b.callExpression(
            b.memberExpression(cast.toExpr(chainExpr), b.identifier("route")),
            [b.stringLiteral(`/${route.pathSegment}`), b.identifier(route.exportName)],
          );
        }

        const exportStmt = conjure.export.const(aggregatorName, chainExpr);
        indexFile.ast(conjure.program(exportStmt)).emit();
      }
    },
  });
}

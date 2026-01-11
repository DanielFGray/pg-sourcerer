/**
 * HTTP Express Plugin - Generate Express route handlers from query plugins
 *
 * Consumes method symbols from sql-queries or kysely-queries via the symbol registry
 * and generates type-safe Express HTTP route handlers.
 *
 * Supports validation via schema plugins (zod, valibot, arktype):
 * - Body validation: imports entity schemas (UserInsert, UserUpdate) and uses .parse(req.body)
 * - Path/query param validation: uses schema builder for type coercion
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
} from "../ir/extensions/schema-builder.js";
import { getTableEntities, getEnumEntities } from "../ir/semantic-ir.js";
import { TsType } from "../services/pg-types.js";

const { b, stmt } = conjure;

// ============================================================================
// Schema Validation Support
// ============================================================================

interface SchemaImport {
  readonly entity: string;
  readonly shape: "insert" | "update";
  readonly schemaName: string;
}

type SchemaBuilderFn = (params: readonly QueryMethodParam[]) => SchemaBuilderResult | undefined;

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
// Configuration
// ============================================================================

const HttpExpressConfigSchema = S.Struct({
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
export type HttpExpressConfig = S.Schema.Encoded<typeof HttpExpressConfigSchema>;

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
      const pkParam = method.params.find(p => p.source === "pk");
      const paramName = pkParam?.name ?? "id";
      return `/:${paramName}`;
    }
    case "list":
    case "create":
      return "/";
    case "lookup": {
      const field = method.lookupField ?? "field";
      const fieldKebab = toKebabCase(field);
      const lookupParam = method.params.find(p => p.source === "lookup" || p.source === "fk");
      const paramName = lookupParam?.name ?? field;
      return `/by-${fieldKebab}/:${paramName}`;
    }
    case "function": {
      return `/${toKebabCase(method.name)}`;
    }
  }
};

/**
 * Build the handler function body for a query method.
 * In Express, we use req.params, req.query, req.body, res.json()
 *
 * When validation is enabled, uses schema.parse() for body and converts path params.
 */
const buildHandlerBody = (
  method: MethodSymbol,
  entityName: string,
  options: {
    hasSchemaProvider: boolean;
    bodySchema: SchemaImport | null;
    pathParams: readonly QueryMethodParam[];
  },
): n.Statement[] => {
  const statements: n.Statement[] = [];
  const callSig = method.callSignature ?? { style: "named" as const };
  const { hasSchemaProvider, bodySchema, pathParams } = options;

  // Extract path params with validation if schema provider available
  if (pathParams.length > 0 && hasSchemaProvider) {
    const firstParam = pathParams[0]!;
    // Use schema builder to validate and coerce path params
    // const _params = UserIdParams["~standard"].validate({ id: req.params.id });
    // if (_params.issues) return res.status(400).json({ error: _params.issues });
    // const { id } = _params.value;
    const paramsObject = b.objectExpression([
      b.property("init", b.stringLiteral(firstParam.name), b.memberExpression(
        b.memberExpression(b.identifier("req"), b.identifier("params")),
        b.identifier(firstParam.name),
      )),
    ]);
    const paramsSchemaName = `${entityName}${firstParam.name.charAt(0).toUpperCase() + firstParam.name.slice(1)}Params`;
    const standardMember = b.memberExpression(
      b.identifier(paramsSchemaName),
      b.stringLiteral("~standard"),
      true,
    );
    const validateCall = b.memberExpression(cast.toExpr(standardMember), b.identifier("validate"));
    const validationExpr = b.callExpression(validateCall, [paramsObject]);
    const validationVar = b.variableDeclarator(b.identifier("_params"), b.awaitExpression(validationExpr));
    statements.push(b.variableDeclaration("const", [validationVar]));

    // if (_params.issues) return res.status(400).json({ error: _params.issues });
    const errorResponse = b.callExpression(
      b.memberExpression(
        b.callExpression(
          b.memberExpression(b.identifier("res"), b.identifier("status")),
          [b.numericLiteral(400)],
        ),
        b.identifier("json"),
      ),
      [b.objectExpression([b.property("init", b.stringLiteral("error"), b.memberExpression(b.identifier("_params"), b.identifier("issues")))])],
    );
    const ifStatement = b.ifStatement(
      b.memberExpression(b.identifier("_params"), b.identifier("issues")),
      b.blockStatement([b.returnStatement(errorResponse)]),
    );
    statements.push(ifStatement);

    // Destructure validated params: const { id } = _params.value;
    const pattern = b.objectPattern(
      pathParams.map(p => {
        const prop = b.property("init", b.identifier(p.name), b.identifier(p.name));
        prop.shorthand = true;
        return prop;
      }),
    );
    statements.push(
      b.variableDeclaration("const", [
        b.variableDeclarator(pattern, b.memberExpression(b.identifier("_params"), b.identifier("value"))),
      ]),
    );
  } else if (pathParams.length > 0) {
    // No schema provider - just extract without validation
    const pattern = b.objectPattern(
      pathParams.map(p => {
        const prop = b.property("init", b.identifier(p.name), b.identifier(p.name));
        prop.shorthand = true;
        return prop;
      }),
    );
    statements.push(
      b.variableDeclaration("const", [
        b.variableDeclarator(
          pattern,
          b.memberExpression(b.identifier("req"), b.identifier("params")),
        ),
      ]),
    );
  }

  // Extract query params: const { limit, offset } = req.query
  const queryParams = method.params.filter(p => p.source === "pagination");
  if (queryParams.length > 0) {
    const pattern = b.objectPattern(
      queryParams.map(p => {
        const prop = b.property("init", b.identifier(p.name), b.identifier(p.name));
        prop.shorthand = true;
        return prop;
      }),
    );
    statements.push(
      b.variableDeclaration("const", [
        b.variableDeclarator(
          pattern,
          b.memberExpression(b.identifier("req"), b.identifier("query")),
        ),
      ]),
    );
  }

  // Extract body with optional validation
  const needsBody =
    method.params.some(p => p.source === "body") ||
    method.kind === "create" ||
    method.kind === "update" ||
    (method.kind === "function" && method.params.some(p => !p.source));

  if (needsBody) {
    if (bodySchema && hasSchemaProvider) {
      // Validation handled below using Standard Schema interface
    } else {
      // const body = req.body
      statements.push(
        stmt.const("body", b.memberExpression(b.identifier("req"), b.identifier("body"))),
      );
    }
  }

  // Validate body using Standard Schema interface (works with zod, valibot, arktype)
  if (bodySchema && hasSchemaProvider) {
    // const validation = UserInsert["~standard"].validate(req.body);
    // if (validation.issues) throw new Error("Validation failed");
    // const body = validation.value;
    const standardMember = b.memberExpression(
      b.identifier(bodySchema.schemaName),
      b.stringLiteral("~standard"),
      true, // computed = true
    );
    const validateCall = b.memberExpression(cast.toExpr(standardMember), b.identifier("validate"));
    const validationExpr = b.callExpression(validateCall, [
      b.memberExpression(b.identifier("req"), b.identifier("body")),
    ]);
    const validationVar = b.variableDeclarator(b.identifier("validation"), b.awaitExpression(validationExpr));
    statements.push(b.variableDeclaration("const", [validationVar]));

    // if (validation.issues) return res.status(400).json({ error: validation.issues });
    const errorResponse = b.callExpression(
      b.memberExpression(
        b.callExpression(
          b.memberExpression(b.identifier("res"), b.identifier("status")),
          [b.numericLiteral(400)],
        ),
        b.identifier("json"),
      ),
      [b.objectExpression([b.property("init", b.stringLiteral("error"), b.memberExpression(b.identifier("validation"), b.identifier("issues")))])],
    );
    const ifStatement = b.ifStatement(
      b.memberExpression(b.identifier("validation"), b.identifier("issues")),
      b.blockStatement([b.returnStatement(errorResponse)]),
    );
    statements.push(ifStatement);

    // const body = validation.value;
    statements.push(
      stmt.const("body", b.memberExpression(b.identifier("validation"), b.identifier("value"))),
    );
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
    const bodyParam = method.params.find(p => p.source === "body");

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
    // if (!result) return res.status(404).json({ error: 'Not found' })
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

  // return res.json(result) or res.status(201).json(result) for create
  let responseExpr: n.Expression;
  if (method.kind === "create") {
    // res.status(201).json(result)
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
    // res.json(result)
    responseExpr = b.callExpression(b.memberExpression(b.identifier("res"), b.identifier("json")), [
      b.identifier("result"),
    ]);
  }
  statements.push(b.returnStatement(cast.toExpr(responseExpr)));

  return statements;
};

/**
 * Build a single route method call: router.get('/path', handler)
 */
const buildRouteCall = (
  method: MethodSymbol,
  entityName: string,
  options: {
    hasSchemaProvider: boolean;
    bodySchema: SchemaImport | null;
    pathParams: readonly QueryMethodParam[];
  },
): {
  httpMethod: string;
  path: string;
  handler: n.ArrowFunctionExpression;
} => {
  const httpMethod = kindToHttpMethod(method.kind);
  const path = getRoutePath(method);

  // Build handler: async (req, res) => { ... }
  const handlerBody = buildHandlerBody(method, entityName, options);
  const handler = b.arrowFunctionExpression(
    [b.identifier("req"), b.identifier("res")],
    b.blockStatement(handlerBody.map(cast.toStmt)),
  );
  handler.async = true;

  return { httpMethod, path, handler };
};

// ============================================================================
// Plugin Definition
// ============================================================================

export function httpExpress(config: HttpExpressConfig = {}): ReturnType<typeof definePlugin> {
  const parsed = S.decodeUnknownSync(HttpExpressConfigSchema)(config);

  return definePlugin({
    name: "http-express",
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

      for (const entityName of entityNames) {
        const entityMethods = ctx.symbols.getEntityMethods(entityName);
        if (!entityMethods || entityMethods.methods.length === 0) continue;

        const pathSegment = entityToPathSegment(entityName);
        const filePath = `${outputDir}/${inflect.uncapitalize(entityName)}.ts`;
        const routesVarName = `${inflect.uncapitalize(entityName)}Routes`;

        const file = ctx.file(filePath);

        if (header) {
          file.header(header);
        }

        // Import Router from express
        file.import({ kind: "package", names: ["Router"], from: "express" });

        // Import queries as namespace
        const queriesImportPath = `../${entityMethods.importPath.replace(/\.ts$/, ".js")}`;
        file.import({
          kind: "relative",
          namespace: "Queries",
          from: queriesImportPath,
        });

        // Check if a schema provider is available for body validation
        const hasSchemaProvider =
          ctx.symbols.resolve({
            capability: "schemas",
            entity: entityName,
            shape: "insert",
          }) !== undefined;

        // Collect body schemas needed for imports
        const bodySchemasNeeded: SchemaImport[] = [];

        // Build the Express router chain
        // Router().get('/path', handler).post('/path', handler)...
        let chainExpr: n.Expression = b.callExpression(b.identifier("Router"), []);

        for (const method of entityMethods.methods) {
          const pathParams = method.params.filter(
            p => p.source === "pk" || p.source === "fk" || p.source === "lookup",
          );
          const bodySchema = getBodySchemaImport(method, entityName);

          if (bodySchema && hasSchemaProvider) {
            bodySchemasNeeded.push(bodySchema);
          }

          const { httpMethod, path, handler } = buildRouteCall(method, entityName, {
            hasSchemaProvider,
            bodySchema,
            pathParams,
          });

          chainExpr = b.callExpression(
            b.memberExpression(cast.toExpr(chainExpr), b.identifier(httpMethod)),
            [b.stringLiteral(path), handler],
          );
        }

        // Import schemas needed for body validation
        for (const schema of bodySchemasNeeded) {
          file.import({
            kind: "symbol",
            ref: { capability: "schemas", entity: schema.entity, shape: schema.shape },
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

        indexFile.import({ kind: "package", names: ["Router"], from: "express" });

        for (const route of generatedRoutes) {
          indexFile.import({
            kind: "relative",
            names: [route.exportName],
            from: `./${route.fileName}`,
          });
        }

        // Build: Router().use('/users', userRoutes).use('/posts', postRoutes)...
        let chainExpr: n.Expression = b.callExpression(b.identifier("Router"), []);

        // Add routes with their path prefixes
        for (const route of generatedRoutes) {
          chainExpr = b.callExpression(
            b.memberExpression(cast.toExpr(chainExpr), b.identifier("use")),
            [b.stringLiteral(`${basePath}/${route.pathSegment}`), b.identifier(route.exportName)],
          );
        }

        const exportStmt = conjure.export.const(aggregatorName, chainExpr);
        indexFile.ast(conjure.program(exportStmt)).emit();
      }
    },
  });
}

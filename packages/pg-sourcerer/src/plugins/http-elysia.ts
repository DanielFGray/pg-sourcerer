/**
 * HTTP Elysia Plugin - Generate Elysia route handlers from query plugins
 *
 * Consumes method symbols from sql-queries or kysely-queries via the symbol registry
 * and generates type-safe Elysia HTTP route handlers.
 */
import { Option, pipe, Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";
import { definePlugin, type PluginContext } from "../services/plugin.js";
import { conjure, cast } from "../lib/conjure.js";
import { inflect } from "../services/inflection.js";
import type { MethodSymbol, EntityMethods } from "../services/symbols.js";
import type { QueryMethodKind, QueryMethodParam } from "../ir/extensions/queries.js";
import {
  SCHEMA_BUILDER_KIND,
  type SchemaBuilder,
  type SchemaBuilderRequest,
  type SchemaBuilderResult,
} from "../ir/extensions/schema-builder.js";
import {
  getTableEntities,
  getEnumEntities,
  type TableEntity,
  type Field,
  type EnumEntity,
  type ExtensionInfo,
} from "../ir/semantic-ir.js";
import {
  resolveFieldType,
  isUuidType,
  isDateType,
  isEnumType,
  getPgTypeName,
} from "../lib/field-utils.js";
import { findEnumByPgName, TsType } from "../services/pg-types.js";

const { b, stmt } = conjure;

// ============================================================================
// Configuration
// ============================================================================

const HttpElysiaConfigSchema = S.Struct({
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
export type HttpElysiaConfig = S.Schema.Encoded<typeof HttpElysiaConfigSchema>;

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
// TypeBox Schema Generation (for fallback when no schema plugin)
// ============================================================================

/**
 * Context for TypeBox field resolution
 */
interface TypeBoxContext {
  readonly enums: readonly EnumEntity[];
  readonly extensions: readonly ExtensionInfo[];
}

/**
 * Build a TypeBox type call: t.String(), t.Number(), etc.
 */
const buildTypeBoxCall = (methodName: string, args: n.Expression[] = []): n.Expression =>
  b.callExpression(
    b.memberExpression(b.identifier("t"), b.identifier(methodName)),
    args.map(cast.toExpr),
  );

/**
 * Map TypeScript type string to TypeBox method name.
 * For path params (strings from URL), numeric types use t.Numeric() for coercion.
 */
const tsTypeToTypeBoxMethod = (tsType: string, forPathParam: boolean): string => {
  switch (tsType) {
    case TsType.String:
      return "String";
    case TsType.Number:
      // t.Numeric() coerces string to number (for path/query params)
      return forPathParam ? "Numeric" : "Number";
    case TsType.Boolean:
      return "Boolean";
    case TsType.BigInt:
      // BigInt comes as string from URL params
      return forPathParam ? "String" : "BigInt";
    case TsType.Date:
      // Dates come as strings, need string schema
      return "String";
    case TsType.Buffer:
    case TsType.Unknown:
    default:
      return "Unknown";
  }
};

/**
 * Build TypeBox enum schema: t.Union([t.Literal('a'), t.Literal('b'), ...])
 */
const buildTypeBoxEnum = (values: readonly string[]): n.Expression => {
  const literals = values.map((v) =>
    buildTypeBoxCall("Literal", [b.stringLiteral(v)]),
  );
  return buildTypeBoxCall("Union", [b.arrayExpression(literals.map(cast.toExpr))]);
};

/**
 * Build TypeBox array schema: t.Array(<inner>)
 */
const buildTypeBoxArray = (inner: n.Expression): n.Expression =>
  buildTypeBoxCall("Array", [cast.toExpr(inner)]);

/**
 * Build TypeBox optional schema: t.Optional(<inner>)
 */
const buildTypeBoxOptional = (inner: n.Expression): n.Expression =>
  buildTypeBoxCall("Optional", [cast.toExpr(inner)]);

/**
 * Build TypeBox union with null: t.Union([<inner>, t.Null()])
 */
const buildTypeBoxNullable = (inner: n.Expression): n.Expression =>
  buildTypeBoxCall("Union", [
    b.arrayExpression([cast.toExpr(inner), cast.toExpr(buildTypeBoxCall("Null"))]),
  ]);

/**
 * Resolve a Field to its TypeBox schema expression.
 *
 * @param field - The IR field to resolve
 * @param ctx - Context with enums and extensions
 * @param forInsert - True if generating for insert shape (fields with defaults are optional)
 */
const resolveFieldTypeBoxSchema = (
  field: Field,
  ctx: TypeBoxContext,
  forInsert: boolean,
): n.Expression => {
  let baseSchema: n.Expression;

  // 1. UUID types - still strings
  if (isUuidType(field)) {
    baseSchema = buildTypeBoxCall("String");
  }
  // 2. Date types - accept string or Date
  else if (isDateType(field)) {
    baseSchema = buildTypeBoxCall("Union", [
      b.arrayExpression([
        cast.toExpr(buildTypeBoxCall("String")),
        cast.toExpr(buildTypeBoxCall("Date")),
      ]),
    ]);
  }
  // 3. Enum types - union of literals
  else if (isEnumType(field)) {
    const pgTypeName = getPgTypeName(field);
    const enumDef = pgTypeName
      ? pipe(
          findEnumByPgName(ctx.enums, pgTypeName),
          Option.getOrUndefined,
        )
      : undefined;

    if (enumDef) {
      baseSchema = buildTypeBoxEnum(enumDef.values);
    } else {
      baseSchema = buildTypeBoxCall("Unknown");
    }
  }
  // 4. Fallback to resolved TypeScript type
  else {
    const resolved = resolveFieldType(field, ctx.enums, ctx.extensions);
    const typeBoxMethod = tsTypeToTypeBoxMethod(resolved.tsType, false);
    baseSchema = buildTypeBoxCall(typeBoxMethod);
  }

  // Wrap with array if needed
  if (field.isArray) {
    baseSchema = buildTypeBoxArray(baseSchema);
  }

  // Apply nullable
  if (field.nullable) {
    baseSchema = buildTypeBoxNullable(baseSchema);
  }

  // Apply optional (for insert shapes: fields with defaults are optional)
  if (forInsert && field.optional) {
    baseSchema = buildTypeBoxOptional(baseSchema);
  }

  return baseSchema;
};

/**
 * Build TypeBox object schema for an entity shape.
 *
 * @param entity - The entity to build schema for
 * @param shapeKind - Which shape to use (insert or update)
 * @param ctx - Context with enums and extensions
 */
const buildEntityTypeBoxSchema = (
  entity: TableEntity,
  shapeKind: "insert" | "update",
  ctx: TypeBoxContext,
): n.Expression => {
  const shape = shapeKind === "insert" ? entity.shapes.insert : entity.shapes.update;
  if (!shape) {
    // Fallback to row shape if specific shape doesn't exist
    return buildTypeBoxCall("Unknown");
  }

  let objBuilder = conjure.obj();
  for (const field of shape.fields) {
    // For update shapes, ALL fields are optional (patch semantics)
    // For insert shapes, only fields with defaults/nullable are optional (already marked in IR)
    const applyOptional = shapeKind === "update" || (shapeKind === "insert" && field.optional);
    let fieldSchema = resolveFieldTypeBoxSchema(field, ctx, false); // Don't apply optional inside
    if (applyOptional) {
      fieldSchema = buildTypeBoxOptional(fieldSchema);
    }
    objBuilder = objBuilder.prop(field.name, fieldSchema);
  }

  return buildTypeBoxCall("Object", [objBuilder.build()]);
};

/**
 * Build TypeBox schema for a path/query parameter based on its type string.
 *
 * @param param - The query method param
 */
const buildParamTypeBoxSchema = (param: QueryMethodParam): n.Expression => {
  const typeBoxMethod = tsTypeToTypeBoxMethod(param.type, true);
  return buildTypeBoxCall(typeBoxMethod);
};

/**
 * Build the handler function body for a query method.
 * Params/query are destructured in the handler signature, so we reference them directly.
 */
const buildHandlerBody = (method: MethodSymbol): n.Statement[] => {
  const callSig = method.callSignature ?? { style: "named" as const };

  // Build the function call arguments based on callSignature
  const args: n.Expression[] = [];

  if (callSig.style === "positional") {
    // Positional: fn(a, b, c) - params are already destructured
    for (const param of method.params) {
      if (param.source === "pk" || param.source === "fk" || param.source === "lookup" || param.source === "pagination") {
        args.push(b.identifier(param.name));
      } else if (param.source === "body") {
        args.push(b.identifier("body"));
      } else {
        // No source specified - get from body (body is not destructured)
        args.push(b.memberExpression(b.identifier("body"), b.identifier(param.name)));
      }
    }
  } else {
    // Named: fn({ a, b, c }) or fn({ id, data: body })
    const bodyParam = method.params.find((p) => p.source === "body");

    if (bodyParam && callSig.bodyStyle === "spread") {
      // Body fields spread directly: fn(body)
      args.push(b.identifier("body"));
    } else if (bodyParam && callSig.bodyStyle === "property") {
      // Body wrapped in property: fn({ id, data: body })
      let objBuilder = conjure.obj();

      for (const param of method.params) {
        if (param.source === "pk" || param.source === "fk" || param.source === "lookup" || param.source === "pagination") {
          // Params are destructured, use shorthand: { id }
          objBuilder = objBuilder.shorthand(param.name);
        }
      }

      objBuilder = objBuilder.prop(bodyParam.name, b.identifier("body"));
      args.push(objBuilder.build());
    } else {
      // Build object from path/pagination params using shorthand
      let objBuilder = conjure.obj();

      for (const param of method.params) {
        if (param.source === "pk" || param.source === "fk" || param.source === "lookup" || param.source === "pagination") {
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
  const awaitExpr = b.awaitExpression(queryCall);
  const resultDecl = stmt.const("result", awaitExpr);

  // Handle 404 for read/lookup that returns null
  if (method.kind === "read" || (method.kind === "lookup" && method.isUniqueLookup)) {
    // if (!result) return status(404, 'Not found');
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
};

/** Schema import info needed for body validation */
interface SchemaImport {
  readonly entity: string;
  readonly shape: "insert" | "update";
  readonly schemaName: string;
}

/**
 * Determine if a method needs body validation and which schema to use.
 * Returns the schema import info or null if no body validation needed.
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

/**
 * Function type for requesting schema builder results.
 * Returns undefined if no schema builder is registered.
 */
type SchemaBuilderFn = (params: readonly QueryMethodParam[]) => SchemaBuilderResult | undefined;

/**
 * Build the route options object (params/body/query validation schemas).
 * Returns the options object expression, whether it needs 't' import, body schema info,
 * and any schema builder imports needed.
 *
 * @param hasSchemaProvider - Whether a schema provider is registered for body validation
 * @param entity - The entity for inline TypeBox body schema generation (when no schema provider)
 * @param typeBoxCtx - Context for TypeBox field resolution
 */
const buildRouteOptions = (
  method: MethodSymbol,
  entityName: string,
  requestSchema: SchemaBuilderFn,
  hasSchemaProvider: boolean,
  entity: TableEntity | undefined,
  typeBoxCtx: TypeBoxContext,
): {
  options: n.ObjectExpression | null;
  needsElysiaT: boolean;
  bodySchema: SchemaImport | null;
  schemaBuilderImport: SchemaBuilderResult["importSpec"] | null;
  inlineBodySchema: n.Expression | null;
} => {
  let objBuilder = conjure.obj();
  let hasOptions = false;
  let needsElysiaT = false;
  let schemaBuilderImport: SchemaBuilderResult["importSpec"] | null = null;
  let inlineBodySchema: n.Expression | null = null;

  // Build params schema for path parameters
  const pathParams = method.params.filter(
    (p) => p.source === "pk" || p.source === "fk" || p.source === "lookup",
  );
  if (pathParams.length > 0) {
    const schemaResult = requestSchema(pathParams);
    if (schemaResult) {
      objBuilder = objBuilder.prop("params", schemaResult.ast);
      schemaBuilderImport = schemaResult.importSpec;
    } else {
      // Fallback to TypeBox t.Object({ ... }) with proper type coercion
      needsElysiaT = true;
      let paramsBuilder = conjure.obj();
      for (const param of pathParams) {
        // Use buildParamTypeBoxSchema to get correct type (t.Numeric for numbers)
        paramsBuilder = paramsBuilder.prop(param.name, buildParamTypeBoxSchema(param));
      }
      const paramsSchema = b.callExpression(
        b.memberExpression(b.identifier("t"), b.identifier("Object")),
        [paramsBuilder.build()],
      );
      objBuilder = objBuilder.prop("params", paramsSchema);
    }
    hasOptions = true;
  }

  // Build query schema for pagination params
  const queryParams = method.params.filter((p) => p.source === "pagination");
  if (queryParams.length > 0) {
    const schemaResult = requestSchema(queryParams);
    if (schemaResult) {
      objBuilder = objBuilder.prop("query", schemaResult.ast);
      schemaBuilderImport = schemaResult.importSpec;
    } else {
      // Fallback to TypeBox t.Object({ ... })
      needsElysiaT = true;
      let queryBuilder = conjure.obj();
      for (const param of queryParams) {
        const tNumeric = b.callExpression(
          b.memberExpression(b.identifier("t"), b.identifier("Numeric")),
          [],
        );
        const tOptional = b.callExpression(
          b.memberExpression(b.identifier("t"), b.identifier("Optional")),
          [tNumeric],
        );
        queryBuilder = queryBuilder.prop(param.name, tOptional);
      }
      const querySchema = b.callExpression(
        b.memberExpression(b.identifier("t"), b.identifier("Object")),
        [queryBuilder.build()],
      );
      objBuilder = objBuilder.prop("query", querySchema);
    }
    hasOptions = true;
  }

  // Body validation
  const bodySchemaInfo = getBodySchemaImport(method, entityName);
  let bodySchema: SchemaImport | null = null;
  
  if (bodySchemaInfo) {
    if (hasSchemaProvider) {
      // Use imported schema from schema provider (Zod, Valibot, etc.)
      bodySchema = bodySchemaInfo;
      objBuilder = objBuilder.prop("body", b.identifier(bodySchema.schemaName));
      hasOptions = true;
    } else if (entity) {
      // Generate inline TypeBox schema from IR
      needsElysiaT = true;
      inlineBodySchema = buildEntityTypeBoxSchema(entity, bodySchemaInfo.shape, typeBoxCtx);
      objBuilder = objBuilder.prop("body", inlineBodySchema);
      hasOptions = true;
    }
    // If neither schema provider nor entity, skip body validation (body will be unknown)
  }

  return {
    options: hasOptions ? objBuilder.build() : null,
    needsElysiaT,
    bodySchema,
    schemaBuilderImport,
    inlineBodySchema,
  };
};

/**
 * Build a single route method call: .get('/path', handler, options)
 */
const buildRouteCall = (
  method: MethodSymbol,
  entityName: string,
  requestSchema: SchemaBuilderFn,
  hasSchemaProvider: boolean,
  entity: TableEntity | undefined,
  typeBoxCtx: TypeBoxContext,
): {
  httpMethod: string;
  path: string;
  handler: n.ArrowFunctionExpression;
  options: n.ObjectExpression | null;
  needsElysiaT: boolean;
  bodySchema: SchemaImport | null;
  schemaBuilderImport: SchemaBuilderResult["importSpec"] | null;
} => {
  const httpMethod = kindToHttpMethod(method.kind);
  const path = getRoutePath(method);

  // Build handler: async ({ params: { id }, body, query: { limit }, status }) => { ... }
  const handlerProps: n.Property[] = [];
  
  // Collect path params (pk, fk, lookup) for destructuring
  const pathParams = method.params.filter((p) => p.source === "pk" || p.source === "fk" || p.source === "lookup");
  if (pathParams.length > 0) {
    // params: { id, slug, ... }
    const paramsPattern = b.objectPattern(
      pathParams.map((p) => {
        const prop = b.property("init", b.identifier(p.name), b.identifier(p.name));
        prop.shorthand = true;
        return prop;
      }),
    );
    handlerProps.push(b.property("init", b.identifier("params"), paramsPattern));
  }

  // Add body if: explicit body param, create/update method, or function with params (no source = from body)
  const needsBody = method.params.some((p) => p.source === "body") ||
    method.kind === "create" ||
    method.kind === "update" ||
    (method.kind === "function" && method.params.some((p) => !p.source));
  if (needsBody) {
    const prop = b.property("init", b.identifier("body"), b.identifier("body"));
    prop.shorthand = true;
    handlerProps.push(prop);
  }

  // Collect pagination params for destructuring
  const paginationParams = method.params.filter((p) => p.source === "pagination");
  if (paginationParams.length > 0) {
    // query: { limit, offset, ... }
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

  const { options, needsElysiaT, bodySchema, schemaBuilderImport } = buildRouteOptions(
    method,
    entityName,
    requestSchema,
    hasSchemaProvider,
    entity,
    typeBoxCtx,
  );

  return { httpMethod, path, handler, options, needsElysiaT, bodySchema, schemaBuilderImport };
};

// ============================================================================
// Plugin Definition
// ============================================================================

export function httpElysia(config: HttpElysiaConfig): ReturnType<typeof definePlugin> {
  const parsed = S.decodeUnknownSync(HttpElysiaConfigSchema)(config);

  return definePlugin({
    name: "http-elysia",
    kind: "http-routes",
    singleton: true,

    canProvide: () => true,

    // Declare dependencies: queries required, schemas optional (falls back to TypeBox)
    requires: () => [
      { kind: "queries", params: {} },
    ],

    optionalRequires: () => [
      { kind: "schemas", params: {} },
    ],

    provide: (_params: unknown, _deps: readonly unknown[], ctx: PluginContext): void => {
      const { outputDir, basePath, header, aggregatorName } = parsed;

      // Get all entities with registered query methods
      const entityNames = ctx.symbols.getEntitiesWithMethods();

      if (entityNames.length === 0) {
        // No query methods registered - nothing to generate
        return;
      }

      // Track generated routes for aggregator index
      const generatedRoutes: Array<{ fileName: string; exportName: string }> = [];

      // Build TypeBox context for inline schema generation (when no schema plugin)
      const enumEntities = getEnumEntities(ctx.ir);
      const tableEntities = getTableEntities(ctx.ir);
      const typeBoxCtx: TypeBoxContext = {
        enums: enumEntities,
        extensions: ctx.ir.extensions,
      };

      // Generate routes for each entity
      for (const entityName of entityNames) {
        const entityMethods = ctx.symbols.getEntityMethods(entityName);
        if (!entityMethods || entityMethods.methods.length === 0) continue;

        // Find the entity in the IR for inline TypeBox body schema generation
        const entity = tableEntities.find((e) => e.name === entityName);

        const pathSegment = entityToPathSegment(entityName);
        const filePath = `${outputDir}/${inflect.uncapitalize(entityName)}.ts`;
        const routesVarName = `${inflect.uncapitalize(entityName)}Routes`;

        const file = ctx.file(filePath);

        if (header) {
          file.header(header);
        }

        // Import Elysia
        file.import({ kind: "package", names: ["Elysia"], from: "elysia" });

        // Import queries as namespace
        const queriesImportPath = `../${entityMethods.importPath.replace(/\.ts$/, ".js")}`;
        file.import({
          kind: "relative",
          namespace: "Queries",
          from: queriesImportPath,
        });

        // Build the Elysia route chain
        // new Elysia({ prefix: '/api/users' }).get(...).post(...)
        const prefixPath = `${basePath}/${pathSegment}`;
        const elysiaConfig = conjure.obj().prop("prefix", b.stringLiteral(prefixPath)).build();
        let chainExpr: n.Expression = b.newExpression(b.identifier("Elysia"), [elysiaConfig]);

        let fileNeedsElysiaT = false;
        const bodySchemaImports: SchemaImport[] = [];
        let schemaLibraryImport: SchemaBuilderResult["importSpec"] | null = null;

        // Create a schema builder function that requests from the service registry
        const requestSchema: SchemaBuilderFn = (params) => {
          if (params.length === 0) return undefined;
          try {
            const request: SchemaBuilderRequest = { variant: "params", params };
            return ctx.request<SchemaBuilderResult | undefined>(SCHEMA_BUILDER_KIND, request);
          } catch {
            // No schema-builder registered, will fall back to TypeBox
            return undefined;
          }
        };

        // Check if a schema provider is available for body validation
        // We probe by checking if the schema-builder service exists
        let hasSchemaProvider = false;
        try {
          // Try to request an entity schema - if it succeeds, we have a provider
          ctx.request(SCHEMA_BUILDER_KIND, { variant: "entity", entity: entityName, shape: "insert" });
          hasSchemaProvider = true;
        } catch {
          // No schema provider registered
        }

        for (const method of entityMethods.methods) {
          const { httpMethod, path, handler, options, needsElysiaT, bodySchema, schemaBuilderImport } =
            buildRouteCall(method, entityName, requestSchema, hasSchemaProvider, entity, typeBoxCtx);
          if (needsElysiaT) fileNeedsElysiaT = true;
          if (bodySchema) bodySchemaImports.push(bodySchema);
          if (schemaBuilderImport) schemaLibraryImport = schemaBuilderImport;

          const callArgs: n.Expression[] = [b.stringLiteral(path), handler];
          if (options) {
            callArgs.push(options);
          }

          chainExpr = b.callExpression(
            b.memberExpression(cast.toExpr(chainExpr), b.identifier(httpMethod)),
            callArgs.map(cast.toExpr),
          );
        }

        if (fileNeedsElysiaT) {
          file.import({ kind: "package", names: ["t"], from: "elysia" });
        }

        // Import schema library (e.g., Zod) if using schema-builder for params
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

        // Import body schemas from schema plugins (Zod, Valibot, etc.)
        // These are resolved via the symbol registry's "schemas" capability
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
        });
      }

      // Generate aggregator index.ts
      if (generatedRoutes.length > 0) {
        const indexPath = `${outputDir}/index.ts`;
        const indexFile = ctx.file(indexPath);

        if (header) {
          indexFile.header(header);
        }

        indexFile.import({ kind: "package", names: ["Elysia"], from: "elysia" });

        for (const route of generatedRoutes) {
          indexFile.import({
            kind: "relative",
            names: [route.exportName],
            from: `./${route.fileName}`,
          });
        }

        // Build: new Elysia().use(userRoutes).use(postRoutes)...
        let chainExpr: n.Expression = b.newExpression(b.identifier("Elysia"), []);
        for (const route of generatedRoutes) {
          chainExpr = b.callExpression(
            b.memberExpression(cast.toExpr(chainExpr), b.identifier("use")),
            [b.identifier(route.exportName)],
          );
        }

        const exportStmt = conjure.export.const(aggregatorName, chainExpr);
        indexFile.ast(conjure.program(exportStmt)).emit();
      }
    },
  });
}

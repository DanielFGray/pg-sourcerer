/**
 * HTTP Elysia Plugin - Generate Elysia route handlers from query plugins
 *
 * Consumes QueryArtifact from sql-queries or kysely-queries and generates
 * type-safe Elysia HTTP route handlers with schema validation.
 *
 * When a "schemas" capability is available (zod, arktype, etc.), imports those
 * for body validation. Otherwise, generates inline TypeBox schemas from the IR.
 */
import { Schema as S, Either } from "effect";
import type { namedTypes as n } from "ast-types";
import { definePlugin } from "../services/plugin.js";
import { conjure, cast } from "../lib/conjure.js";
import { inflect } from "../services/inflection.js";
import { resolveFieldType } from "../lib/field-utils.js";
import { TsType } from "../services/pg-types.js";
import type { Shape, Field, EnumEntity, ExtensionInfo, SemanticIR } from "../ir/semantic-ir.js";
import { getEnumEntities, getTableEntities } from "../ir/semantic-ir.js";

const { b, stmt } = conjure;

// ============================================================================
// Query Artifact Schema (consumer-defined)
// ============================================================================
// This schema defines what http-elysia expects from query plugins.
// We decode the artifact.data using this schema.

/** How to call a query function */
const CallSignature = S.Struct({
  style: S.Union(S.Literal("named"), S.Literal("positional")),
  bodyStyle: S.optional(S.Union(S.Literal("property"), S.Literal("spread"))),
});
type CallSignature = S.Schema.Type<typeof CallSignature>;

const QueryMethodParam = S.Struct({
  name: S.String,
  type: S.String,
  required: S.Boolean,
  columnName: S.optional(S.String),
  source: S.optional(S.Union(
    S.Literal("pk"),
    S.Literal("fk"),
    S.Literal("lookup"),
    S.Literal("body"),
    S.Literal("pagination"),
  )),
});
type QueryMethodParam = S.Schema.Type<typeof QueryMethodParam>;

const QueryMethodReturn = S.Struct({
  type: S.String,
  nullable: S.Boolean,
  isArray: S.Boolean,
});

const QueryMethodKind = S.Union(
  S.Literal("read"),
  S.Literal("list"),
  S.Literal("create"),
  S.Literal("update"),
  S.Literal("delete"),
  S.Literal("lookup"),
  S.Literal("function"),
);

const QueryMethod = S.Struct({
  name: S.String,
  kind: QueryMethodKind,
  params: S.Array(QueryMethodParam),
  returns: QueryMethodReturn,
  lookupField: S.optional(S.String),
  isUniqueLookup: S.optional(S.Boolean),
  callSignature: S.optional(CallSignature),
});
type QueryMethod = S.Schema.Type<typeof QueryMethod>;

const EntityQueryMethods = S.Struct({
  entityName: S.String,
  tableName: S.String,
  schemaName: S.String,
  pkType: S.optional(S.String),
  hasCompositePk: S.optional(S.Boolean),
  methods: S.Array(QueryMethod),
});
type EntityQueryMethods = S.Schema.Type<typeof EntityQueryMethods>;

const FunctionQueryMethod = S.Struct({
  functionName: S.String,
  exportName: S.String,
  schemaName: S.String,
  volatility: S.Union(S.Literal("immutable"), S.Literal("stable"), S.Literal("volatile")),
  params: S.Array(QueryMethodParam),
  returns: QueryMethodReturn,
  callSignature: S.optional(CallSignature),
});
type FunctionQueryMethod = S.Schema.Type<typeof FunctionQueryMethod>;

const QueryArtifact = S.Struct({
  entities: S.Array(EntityQueryMethods),
  functions: S.Array(FunctionQueryMethod),
  sourcePlugin: S.String,
  outputDir: S.String,
});
type QueryArtifact = S.Schema.Type<typeof QueryArtifact>;

// ============================================================================
// TypeBox Schema Generation (fallback when no schema plugin available)
// ============================================================================

/**
 * Map TsType to TypeBox builder expression: t.String(), t.Number(), etc.
 */
const tsTypeToTypeBox = (tsType: TsType): n.Expression => {
  const tMethod = (name: string) =>
    b.callExpression(b.memberExpression(b.identifier("t"), b.identifier(name)), []);

  switch (tsType) {
    case TsType.String:
      return tMethod("String");
    case TsType.Number:
      return tMethod("Number");
    case TsType.Boolean:
      return tMethod("Boolean");
    case TsType.Date:
      return tMethod("String"); // Dates come as ISO strings in HTTP
    case TsType.BigInt:
      return tMethod("String"); // BigInt as string in JSON
    case TsType.Buffer:
      return tMethod("String"); // Base64 encoded
    default:
      return tMethod("Unknown");
  }
};

/**
 * Build TypeBox schema for an enum: t.Union([t.Literal('a'), t.Literal('b')])
 */
const buildTypeBoxEnum = (values: readonly string[]): n.Expression => {
  const literals = values.map((v) =>
    b.callExpression(
      b.memberExpression(b.identifier("t"), b.identifier("Literal")),
      [b.stringLiteral(v)]
    )
  );
  return b.callExpression(
    b.memberExpression(b.identifier("t"), b.identifier("Union")),
    [b.arrayExpression(literals)]
  );
};

/**
 * Build TypeBox schema from a field
 */
const buildTypeBoxField = (
  field: Field,
  enums: Iterable<EnumEntity>,
  extensions: readonly ExtensionInfo[]
): n.Expression => {
  const resolved = resolveFieldType(field, enums, extensions);

  let schema: n.Expression;
  if (resolved.enumDef) {
    schema = buildTypeBoxEnum(resolved.enumDef.values);
  } else {
    schema = tsTypeToTypeBox(resolved.tsType);
  }

  // Wrap in array if needed
  if (field.isArray) {
    schema = b.callExpression(
      b.memberExpression(b.identifier("t"), b.identifier("Array")),
      [cast.toExpr(schema)]
    );
  }

  // Wrap in Optional if nullable or optional
  if (field.nullable || field.optional) {
    schema = b.callExpression(
      b.memberExpression(b.identifier("t"), b.identifier("Optional")),
      [cast.toExpr(schema)]
    );
  }

  return schema;
};

/**
 * Build t.Object({ field: schema, ... }) from a Shape
 */
const buildTypeBoxFromShape = (
  shape: Shape,
  enums: Iterable<EnumEntity>,
  extensions: readonly ExtensionInfo[]
): n.Expression => {
  let objBuilder = conjure.obj();

  for (const field of shape.fields) {
    const fieldSchema = buildTypeBoxField(field, enums, extensions);
    objBuilder = objBuilder.prop(field.name, fieldSchema);
  }

  return b.callExpression(
    b.memberExpression(b.identifier("t"), b.identifier("Object")),
    [objBuilder.build()]
  );
};

// ============================================================================
// String Helpers
// ============================================================================

/**
 * Convert PascalCase/camelCase to kebab-case.
 * UserProfile → user-profile
 */
const toKebabCase = (str: string): string =>
  str
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();

// ============================================================================
// Configuration
// ============================================================================

/**
 * Path template configuration for route generation.
 * Supports variables: {entity}, {id}, {field}
 */
const PathTemplateConfig = S.Struct({
  /** Base path for all routes. Default: "/api" */
  basePath: S.optionalWith(S.String, { default: () => "/api" }),
  /** Path template for single entity by ID. Default: "/{entity}/{id}" */
  findById: S.optionalWith(S.String, { default: () => "/{entity}/{id}" }),
  /** Path template for entity list. Default: "/{entity}" */
  list: S.optionalWith(S.String, { default: () => "/{entity}" }),
  /** Path template for create. Default: "/{entity}" */
  create: S.optionalWith(S.String, { default: () => "/{entity}" }),
  /** Path template for update. Default: "/{entity}/{id}" */
  update: S.optionalWith(S.String, { default: () => "/{entity}/{id}" }),
  /** Path template for delete. Default: "/{entity}/{id}" */
  delete: S.optionalWith(S.String, { default: () => "/{entity}/{id}" }),
  /** Path template for lookup methods. Default: "/{entity}/by-{field}/{value}" */
  lookup: S.optionalWith(S.String, { default: () => "/{entity}/by-{field}/{value}" }),
  /** Prefix for function routes. Default: "" (no prefix). Example: "fn" → "/fn/current-user" */
  functionPrefix: S.optionalWith(S.String, { default: () => "" }),
});

type PathTemplateConfig = S.Schema.Type<typeof PathTemplateConfig>;

/**
 * Per-entity configuration overrides.
 */
const EntityOverride = S.Struct({
  /** Override entity path segment (e.g., "user" instead of "users") */
  pathSegment: S.optional(S.String),
  /** Disable specific methods for this entity */
  disableMethods: S.optionalWith(S.Array(S.String), { default: () => [] }),
  /** Custom path templates for this entity */
  paths: S.optional(PathTemplateConfig),
});

type EntityOverride = S.Schema.Type<typeof EntityOverride>;

/**
 * HTTP Elysia Plugin configuration schema.
 */
const HttpElysiaPluginConfigSchema = S.Struct({
  /** Output directory for generated route files. Default: "routes" */
  outputDir: S.optionalWith(S.String, { default: () => "routes" }),

  /** 
   * Path to import query functions from (relative to outputDir).
   * Auto-detected from query artifact's outputDir if not specified.
   */
  queriesPath: S.optional(S.String),

  /** Global path templates */
  paths: S.optional(PathTemplateConfig),

  /** Per-entity configuration overrides */
  entities: S.optionalWith(S.Record({ key: S.String, value: EntityOverride }), {
    default: () => ({}),
  }),

  /**
   * Whether to generate a single routes file or per-entity files.
   * - "single": All routes in routes/index.ts
   * - "per-entity": routes/users.ts, routes/posts.ts, etc.
   * Default: "per-entity"
   */
  outputStyle: S.optionalWith(S.Union(S.Literal("single"), S.Literal("per-entity")), {
    default: () => "per-entity" as const,
  }),

  /** Header content to prepend to each generated file */
  header: S.optional(S.String),

  /**
   * Include functions in route generation.
   * When true, generates routes for PostgreSQL function wrappers.
   * Default: true
   */
  includeFunctions: S.optionalWith(S.Boolean, { default: () => true }),

  /**
   * Generate an index.ts that aggregates all route files.
   * When true, generates routes/index.ts that imports and combines all routes.
   * Default: true
   */
  generateIndex: S.optionalWith(S.Boolean, { default: () => true }),

  /**
   * Name of the aggregated router export.
   * Default: "api"
   */
  aggregatorName: S.optionalWith(S.String, { default: () => "api" }),
});

type HttpElysiaPluginConfig = S.Schema.Type<typeof HttpElysiaPluginConfigSchema>;

// ============================================================================
// Path Generation Helpers
// ============================================================================

/**
 * Convert entity name to URL path segment.
 * Default: kebab-case plural (e.g., "UserProfile" → "user-profiles")
 */
const entityToPathSegment = (entityName: string): string =>
  inflect.pluralize(toKebabCase(entityName));

/**
 * Get the route path for a query method.
 * Returns path relative to the entity prefix (e.g., "/:id" not "/users/:id")
 */
const getRoutePath = (
  method: QueryMethod,
  _pathSegment: string,
  pathConfig: PathTemplateConfig,
): string => {
  switch (method.kind) {
    case "read": {
      // GET /:id
      const pkParam = method.params.find(p => p.source === "pk");
      const paramName = pkParam?.name ?? "id";
      return `/:${paramName}`;
    }
    case "list":
      // GET /
      return "/";
    case "create":
      // POST /
      return "/";
    case "update": {
      // PUT /:id
      const pkParam = method.params.find(p => p.source === "pk");
      const paramName = pkParam?.name ?? "id";
      return `/:${paramName}`;
    }
    case "delete": {
      // DELETE /:id
      const pkParam = method.params.find(p => p.source === "pk");
      const paramName = pkParam?.name ?? "id";
      return `/:${paramName}`;
    }
    case "lookup": {
      // GET /by-{field}/:value
      const field = method.lookupField ?? "field";
      const fieldKebab = toKebabCase(field);
      const lookupParam = method.params.find(p => p.source === "lookup" || p.source === "fk");
      const paramName = lookupParam?.name ?? field;
      return `/by-${fieldKebab}/:${paramName}`;
    }
    case "function": {
      // POST /{prefix}/{functionName} or just /{functionName} if no prefix
      const fnPath = toKebabCase(method.name);
      const prefix = pathConfig.functionPrefix;
      return prefix ? `/${prefix}/${fnPath}` : `/${fnPath}`;
    }
  }
};

/**
 * Get the HTTP method for a query method kind.
 */
const kindToHttpMethod = (kind: QueryMethod["kind"]): string => {
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
      // Functions default to POST for safety
      return "post";
  }
};

// ============================================================================
// Route Handler Builders
// ============================================================================

/**
 * Build the handler function body for a query method.
 * Returns statements that call the query function and return the result.
 * Uses callSignature to determine how to pass arguments.
 */
const buildHandlerBody = (method: QueryMethod): n.Statement[] => {
  const queryFnName = method.name;
  const callSig = method.callSignature ?? { style: "named" as const };

  // Build the function call arguments based on callSignature
  const args: n.Expression[] = [];

  if (callSig.style === "positional") {
    // Positional: fn(a, b, c)
    for (const param of method.params) {
      if (param.source === "pk" || param.source === "fk" || param.source === "lookup") {
        args.push(b.memberExpression(b.identifier("params"), b.identifier(param.name)));
      } else if (param.source === "body") {
        args.push(b.identifier("body"));
      } else if (param.source === "pagination") {
        args.push(b.memberExpression(b.identifier("query"), b.identifier(param.name)));
      } else {
        // No source specified (e.g., function args) - get from body
        args.push(b.memberExpression(b.identifier("body"), b.identifier(param.name)));
      }
    }
  } else {
    // Named: fn({ a, b, c }) or fn({ id, data: body })
    const bodyParam = method.params.find(p => p.source === "body");
    
    if (bodyParam && callSig.bodyStyle === "property") {
      // Body wrapped in property: fn({ id, data: body })
      let objBuilder = conjure.obj();
      
      // Add non-body params first
      for (const param of method.params) {
        if (param.source === "pk" || param.source === "fk" || param.source === "lookup") {
          objBuilder = objBuilder.prop(
            param.name,
            b.memberExpression(b.identifier("params"), b.identifier(param.name))
          );
        } else if (param.source === "pagination") {
          objBuilder = objBuilder.prop(
            param.name,
            b.memberExpression(b.identifier("query"), b.identifier(param.name))
          );
        }
      }
      
      // Add body as "data" property
      objBuilder = objBuilder.prop(bodyParam.name, b.identifier("body"));
      args.push(objBuilder.build());
      
    } else if (bodyParam && callSig.bodyStyle === "spread") {
      // Body fields spread directly: fn({ field1, field2, ... })
      // Just pass body directly - the query function destructures it
      args.push(b.identifier("body"));
      
    } else if (bodyParam) {
      // No bodyStyle specified but has body - default to passing body directly
      args.push(b.identifier("body"));
      
    } else {
      // No body param - build object from path/pagination params
      let objBuilder = conjure.obj();
      
      for (const param of method.params) {
        if (param.source === "pk" || param.source === "fk" || param.source === "lookup") {
          objBuilder = objBuilder.prop(
            param.name,
            b.memberExpression(b.identifier("params"), b.identifier(param.name))
          );
        } else if (param.source === "pagination") {
          objBuilder = objBuilder.prop(
            param.name,
            b.memberExpression(b.identifier("query"), b.identifier(param.name))
          );
        }
      }
      
      if (method.params.length > 0) {
        args.push(objBuilder.build());
      }
    }
  }

  // Build: const result = await queryFn(args)
  const queryCall = b.callExpression(b.identifier(queryFnName), args.map(cast.toExpr));
  const awaitExpr = b.awaitExpression(queryCall);
  const resultDecl = stmt.const("result", awaitExpr);

  // For delete, just return success
  if (method.kind === "delete") {
    return [
      b.expressionStatement(awaitExpr),
      b.returnStatement(
        conjure.obj().prop("success", b.booleanLiteral(true)).build()
      ),
    ];
  }

  // For read/lookup that can return null, handle 404
  if (method.returns.nullable && !method.returns.isArray) {
    const notFoundCheck = stmt.if(
      conjure.op.not(b.identifier("result")),
      [
        b.returnStatement(
          b.callExpression(
            b.identifier("status"),
            [b.numericLiteral(404), b.stringLiteral("Not found")]
          )
        ),
      ]
    );
    return [resultDecl, notFoundCheck, b.returnStatement(b.identifier("result"))];
  }

  return [resultDecl, b.returnStatement(b.identifier("result"))];
};

/**
 * Build destructured handler parameter: ({ params, body, query, status })
 */
const buildHandlerParam = (method: QueryMethod): n.ObjectPattern => {
  const properties: n.ObjectProperty[] = [];

  const hasPathParams = method.params.some(
    p => p.source === "pk" || p.source === "fk" || p.source === "lookup"
  );
  // For function methods with no source on params, treat them as body params
  const hasBody = method.params.some(p => p.source === "body" || p.source === undefined);
  const hasQuery = method.params.some(p => p.source === "pagination");
  const needsError = method.returns.nullable && !method.returns.isArray;

  if (hasPathParams) {
    const prop = b.objectProperty(b.identifier("params"), b.identifier("params"));
    prop.shorthand = true;
    properties.push(prop);
  }

  if (hasBody) {
    const prop = b.objectProperty(b.identifier("body"), b.identifier("body"));
    prop.shorthand = true;
    properties.push(prop);
  }

  if (hasQuery) {
    const prop = b.objectProperty(b.identifier("query"), b.identifier("query"));
    prop.shorthand = true;
    properties.push(prop);
  }

  if (needsError) {
    const prop = b.objectProperty(b.identifier("status"), b.identifier("status"));
    prop.shorthand = true;
    properties.push(prop);
  }

  return b.objectPattern(properties);
};

/**
 * Map a TypeScript type string to an Elysia t.* validator call.
 * Returns an expression like t.String() or t.Number()
 */
const typeToElysiaValidator = (tsType: string, required: boolean): n.Expression => {
  // Normalize the type (remove optionality markers, arrays, etc.)
  const baseType = tsType.replace(/\[\]$/, "").replace(/\?$/, "").toLowerCase();
  
  let validator: n.Expression;
  switch (baseType) {
    case "number":
    case "int":
    case "integer":
    case "float":
    case "double":
      // t.Numeric() parses string to number from URL params
      validator = b.callExpression(
        b.memberExpression(b.identifier("t"), b.identifier("Numeric")),
        []
      );
      break;
    case "boolean":
    case "bool":
      validator = b.callExpression(
        b.memberExpression(b.identifier("t"), b.identifier("Boolean")),
        []
      );
      break;
    case "date":
      // t.Date() accepts ISO strings and converts to Date objects
      validator = b.callExpression(
        b.memberExpression(b.identifier("t"), b.identifier("Date")),
        []
      );
      break;
    case "string":
    default:
      validator = b.callExpression(
        b.memberExpression(b.identifier("t"), b.identifier("String")),
        []
      );
      break;
  }
  
  // Wrap in t.Optional() if not required
  if (!required) {
    validator = b.callExpression(
      b.memberExpression(b.identifier("t"), b.identifier("Optional")),
      [cast.toExpr(validator)]
    );
  }
  
  return validator;
};

/**
 * Build t.Object({ field: t.Type() }) for params or query validation.
 */
const buildElysiaValidatorObject = (
  params: readonly QueryMethodParam[],
): n.Expression => {
  let objBuilder = conjure.obj();
  
  for (const param of params) {
    const validator = typeToElysiaValidator(param.type, param.required);
    objBuilder = objBuilder.prop(param.name, validator);
  }
  
  // t.Object({ ... })
  return b.callExpression(
    b.memberExpression(b.identifier("t"), b.identifier("Object")),
    [cast.toExpr(objBuilder.build())]
  );
};

/**
 * Build the validation schema object for a route.
 * Returns { params: ParamsSchema, body: BodySchema, query: QuerySchema }
 * Also returns whether we need to import 't' from elysia.
 * 
 * When hasExternalSchemas is true, imports body schemas from the schemas provider.
 * Otherwise, builds inline TypeBox schemas from the IR.
 */
const buildValidationSchema = (
  method: QueryMethod,
  entityName: string,
  hasExternalSchemas: boolean,
  ir: SemanticIR | undefined,
): { 
  schemaObj: n.ObjectExpression | null; 
  schemaImports: Array<{ entity: string; shape?: string }>;
  needsElysiaT: boolean;
  inlineBodySchema?: { varName: string; schema: n.Expression };
} => {
  const properties: n.ObjectProperty[] = [];
  const schemaImports: Array<{ entity: string; shape?: string }> = [];
  let needsElysiaT = false;
  let inlineBodySchema: { varName: string; schema: n.Expression } | undefined;

  // Path params validation using Elysia's t.*
  const pathParams = method.params.filter(
    p => p.source === "pk" || p.source === "fk" || p.source === "lookup"
  );
  if (pathParams.length > 0) {
    needsElysiaT = true;
    const paramsValidator = buildElysiaValidatorObject(pathParams);
    properties.push(
      b.objectProperty(b.identifier("params"), cast.toExpr(paramsValidator))
    );
  }

  // Body validation (for create/update)
  const bodyParam = method.params.find(p => p.source === "body");
  // Function methods have params with no source - treat as body params for POST methods
  const functionBodyParams = method.params.filter(p => p.source === undefined);
  
  if (bodyParam) {
    const shapeKind = method.kind === "create" ? "insert" : "update";
    
    if (hasExternalSchemas) {
      // Use imported schema from schemas provider
      schemaImports.push({ entity: entityName, shape: shapeKind });
      const schemaName = `${entityName}${inflect.pascalCase(shapeKind)}`;
      properties.push(
        b.objectProperty(b.identifier("body"), b.identifier(schemaName))
      );
    } else if (ir) {
      // Build inline TypeBox schema from IR
      needsElysiaT = true;
      const entity = getTableEntities(ir).find(e => e.name === entityName);
      const shape = entity?.shapes[shapeKind as "insert" | "update"];
      if (shape) {
        const enums = getEnumEntities(ir);
        const schemaExpr = buildTypeBoxFromShape(shape, enums, ir.extensions);
        const varName = `${entityName}${inflect.pascalCase(shapeKind)}Body`;
        
        inlineBodySchema = { varName, schema: schemaExpr };
        properties.push(
          b.objectProperty(b.identifier("body"), b.identifier(varName))
        );
      }
    }
  } else if (functionBodyParams.length > 0) {
    // Function methods with params that have no source - build inline TypeBox schema
    needsElysiaT = true;
    const bodyValidator = buildElysiaValidatorObject(functionBodyParams);
    properties.push(
      b.objectProperty(b.identifier("body"), cast.toExpr(bodyValidator))
    );
  }

  // Query params validation (pagination) using Elysia's t.*
  const queryParams = method.params.filter(p => p.source === "pagination");
  if (queryParams.length > 0) {
    needsElysiaT = true;
    const queryValidator = buildElysiaValidatorObject(queryParams);
    properties.push(
      b.objectProperty(b.identifier("query"), cast.toExpr(queryValidator))
    );
  }

  if (properties.length === 0) {
    return { schemaObj: null, schemaImports, needsElysiaT, inlineBodySchema };
  }

  return { schemaObj: b.objectExpression(properties), schemaImports, needsElysiaT, inlineBodySchema };
};

/**
 * Build a single route method call: .get('/path', handler, { validation })
 */
const buildRouteMethodCall = (
  method: QueryMethod,
  pathSegment: string,
  entityName: string,
  pathConfig: PathTemplateConfig,
  hasExternalSchemas: boolean,
  ir: SemanticIR | undefined,
): { 
  callExpr: n.CallExpression; 
  schemaImports: Array<{ entity: string; shape?: string }>;
  needsElysiaT: boolean;
  inlineBodySchema?: { varName: string; schema: n.Expression };
} => {
  const httpMethod = kindToHttpMethod(method.kind);
  const routePath = getRoutePath(method, pathSegment, pathConfig);

  // Build async handler: async ({ params, body }) => { ... }
  const handlerParam = buildHandlerParam(method);
  const handlerBody = buildHandlerBody(method);
  const handler = b.arrowFunctionExpression(
    [handlerParam],
    b.blockStatement(handlerBody.map(cast.toStmt))
  );
  handler.async = true;

  // Build validation schema
  const { schemaObj, schemaImports, needsElysiaT, inlineBodySchema } = buildValidationSchema(
    method,
    entityName,
    hasExternalSchemas,
    ir,
  );

  // Build method call: .get('/path', handler) or .get('/path', handler, { body: Schema })
  const methodArgs: n.Expression[] = [b.stringLiteral(routePath), handler];
  if (schemaObj) {
    methodArgs.push(schemaObj);
  }

  const callExpr = b.callExpression(b.identifier(httpMethod), methodArgs.map(cast.toExpr));
  return { callExpr, schemaImports, needsElysiaT, inlineBodySchema };
};

// ============================================================================
// Function Route Helpers
// ============================================================================

/**
 * Get HTTP method for a function based on volatility.
 * - immutable/stable → GET (safe, cacheable)
 * - volatile → POST (may have side effects)
 */
const volatilityToHttpMethod = (volatility: FunctionQueryMethod["volatility"]): string => {
  switch (volatility) {
    case "immutable":
    case "stable":
      return "get";
    case "volatile":
      return "post";
  }
};

/**
 * Build handler body for a function route.
 */
const buildFunctionHandlerBody = (fn: FunctionQueryMethod): n.Statement[] => {
  const fnName = fn.exportName;
  const callSig = fn.callSignature ?? { style: "named" as const };
  
  // Build arguments based on call signature
  const args: n.Expression[] = [];
  
  if (fn.params.length > 0) {
    const isGetMethod = fn.volatility === "immutable" || fn.volatility === "stable";
    const source = isGetMethod ? "query" : "body";
    
    if (callSig.style === "positional") {
      // Positional: fn(body.param1, body.param2)
      for (const param of fn.params) {
        args.push(b.memberExpression(b.identifier(source), b.identifier(param.name)));
      }
    } else {
      // Named: fn({ param1: body.param1, param2: body.param2 })
      let objBuilder = conjure.obj();
      for (const param of fn.params) {
        objBuilder = objBuilder.prop(
          param.name,
          b.memberExpression(b.identifier(source), b.identifier(param.name))
        );
      }
      args.push(objBuilder.build());
    }
  }
  
  // Build: const result = await fnName(args)
  const fnCall = b.callExpression(b.identifier(fnName), args.map(cast.toExpr));
  const awaitExpr = b.awaitExpression(fnCall);
  const resultDecl = stmt.const("result", awaitExpr);
  
  // Handle nullable returns with 404
  if (fn.returns.nullable && !fn.returns.isArray) {
    const notFoundCheck = stmt.if(
      conjure.op.not(b.identifier("result")),
      [
        b.returnStatement(
          b.callExpression(
            b.identifier("status"),
            [b.numericLiteral(404), b.stringLiteral("Not found")]
          )
        ),
      ]
    );
    return [resultDecl, notFoundCheck, b.returnStatement(b.identifier("result"))];
  }
  
  return [resultDecl, b.returnStatement(b.identifier("result"))];
};

/**
 * Build handler parameter for a function route.
 */
const buildFunctionHandlerParam = (fn: FunctionQueryMethod): n.ObjectPattern => {
  const properties: n.ObjectProperty[] = [];
  const isGetMethod = fn.volatility === "immutable" || fn.volatility === "stable";
  const needsStatus = fn.returns.nullable && !fn.returns.isArray;
  
  if (fn.params.length > 0) {
    const sourceIdent = isGetMethod ? "query" : "body";
    const prop = b.objectProperty(b.identifier(sourceIdent), b.identifier(sourceIdent));
    prop.shorthand = true;
    properties.push(prop);
  }
  
  if (needsStatus) {
    const prop = b.objectProperty(b.identifier("status"), b.identifier("status"));
    prop.shorthand = true;
    properties.push(prop);
  }
  
  return b.objectPattern(properties);
};

/**
 * Build validation schema for a function route.
 */
const buildFunctionValidationSchema = (
  fn: FunctionQueryMethod
): { schemaObj: n.ObjectExpression | null; needsElysiaT: boolean } => {
  if (fn.params.length === 0) {
    return { schemaObj: null, needsElysiaT: false };
  }
  
  const isGetMethod = fn.volatility === "immutable" || fn.volatility === "stable";
  const schemaKey = isGetMethod ? "query" : "body";
  
  // Build t.Object({ param: t.Type(), ... })
  const validator = buildElysiaValidatorObject(fn.params);
  
  const schemaObj = b.objectExpression([
    b.objectProperty(b.identifier(schemaKey), cast.toExpr(validator))
  ]);
  
  return { schemaObj, needsElysiaT: true };
};

/**
 * Build a single function route call: .get('/fn-name', handler, { validation })
 */
const buildFunctionRouteCall = (
  fn: FunctionQueryMethod,
  functionPrefix: string,
): { callExpr: n.CallExpression; needsElysiaT: boolean } => {
  const httpMethod = volatilityToHttpMethod(fn.volatility);
  
  // Build path: /{prefix}/{fn-name} or just /{fn-name}
  const fnPath = toKebabCase(fn.exportName);
  const routePath = functionPrefix ? `/${functionPrefix}/${fnPath}` : `/${fnPath}`;
  
  // Build async handler
  const handlerParam = buildFunctionHandlerParam(fn);
  const handlerBody = buildFunctionHandlerBody(fn);
  const handler = b.arrowFunctionExpression(
    [handlerParam],
    b.blockStatement(handlerBody.map(cast.toStmt))
  );
  handler.async = true;
  
  // Build validation schema
  const { schemaObj, needsElysiaT } = buildFunctionValidationSchema(fn);
  
  // Build method call
  const methodArgs: n.Expression[] = [b.stringLiteral(routePath), handler];
  if (schemaObj) {
    methodArgs.push(schemaObj);
  }
  
  const callExpr = b.callExpression(b.identifier(httpMethod), methodArgs.map(cast.toExpr));
  return { callExpr, needsElysiaT };
};

// ============================================================================
// Plugin Definition
// ============================================================================

export const httpElysiaPlugin = definePlugin({
  name: "http-elysia",
  provides: ["http", "http:elysia"],
  requires: ["queries"],
  configSchema: HttpElysiaPluginConfigSchema,
  inflection: {
    outputFile: ctx => `${inflect.uncapitalize(ctx.entityName)}.ts`,
    symbolName: (entityName, _artifactKind) => `${inflect.uncapitalize(entityName)}Routes`,
  },

  run: (ctx, config) => {
    // Find any queries artifact (works with sql-queries, kysely-queries, or any future query plugin)
    const artifact = ctx.findArtifact("queries");

    if (!artifact) {
      // No query artifact available - nothing to generate
      return;
    }

    // Check if external schemas are available by looking for registered symbols
    // This works because schema plugins (zod, arktype, etc.) run before http-elysia
    // and register their symbols during execution.
    // We check for any entity's insert schema as a proxy for "schemas capability exists"
    const hasExternalSchemas = (() => {
      // Try to find any registered schema symbol
      for (const entity of ctx.ir.entities.values()) {
        if (entity.kind === "table" || entity.kind === "view") {
          const symbol = ctx.symbols.resolve({
            capability: "schemas",
            entity: entity.name,
            shape: "insert",
          });
          if (symbol) return true;
        }
      }
      return false;
    })();

    // Decode the artifact data using our expected schema
    const decodeResult = S.decodeUnknownEither(QueryArtifact)(artifact.data);
    if (Either.isLeft(decodeResult)) {
      throw new Error(
        `http-elysia: Invalid artifact data from ${artifact.capability}. Expected QueryArtifact shape.`
      );
    }

    const queryArtifact = decodeResult.right;
    const { entities } = queryArtifact;

    // Compute queries import path: use config override or derive from artifact's outputDir
    const queriesPath = config.queriesPath ?? `../${queryArtifact.outputDir}`;

    // Get path configuration with defaults
    const pathConfig: PathTemplateConfig = {
      basePath: config.paths?.basePath ?? "/api",
      findById: config.paths?.findById ?? "/{entity}/{id}",
      list: config.paths?.list ?? "/{entity}",
      create: config.paths?.create ?? "/{entity}",
      update: config.paths?.update ?? "/{entity}/{id}",
      delete: config.paths?.delete ?? "/{entity}/{id}",
      lookup: config.paths?.lookup ?? "/{entity}/by-{field}/{value}",
      functionPrefix: config.paths?.functionPrefix ?? "",
    };

    // Track generated route exports for the aggregator index
    const generatedRoutes: Array<{ fileName: string; exportName: string }> = [];

    // Generate routes for each entity
    for (const entityMethods of entities) {
      const { entityName, methods } = entityMethods;

      // Get entity-specific overrides
      const entityOverride = config.entities?.[entityName];
      const pathSegment = entityOverride?.pathSegment ?? entityToPathSegment(entityName);
      const disabledMethods = new Set(entityOverride?.disableMethods ?? []);

      // Filter out disabled methods
      const enabledMethods = methods.filter(m => !disabledMethods.has(m.name));

      if (enabledMethods.length === 0) continue;

      // Build file path
      const filePath = config.outputStyle === "single"
        ? `${config.outputDir}/index.ts`
        : `${config.outputDir}/${inflect.uncapitalize(entityName)}.ts`;

      const file = ctx.file(filePath);

      // Add header if provided
      if (config.header) {
        file.header(config.header);
      }

      // Import Elysia
      file.import({ kind: "package", names: ["Elysia"], from: "elysia" });

      // Collect all query function names to import
      const queryFunctionNames = enabledMethods.map(m => m.name);

      // Import query functions from queries path
      const queryFileName = entityName; // Queries are in files like sql-queries/User.ts
      file.import({
        kind: "relative",
        names: queryFunctionNames,
        from: `${queriesPath}/${queryFileName}.js`,
      });

      // Collect schema imports needed for validation
      const allSchemaImports: Array<{ entity: string; shape?: string }> = [];
      const allInlineSchemas: Array<{ varName: string; schema: n.Expression }> = [];
      let fileNeedsElysiaT = false;

      // Build the Elysia route chain
      // new Elysia({ prefix: '/api/users' })
      //   .get('/:id', handler, { params: schema })
      //   .post('/', handler, { body: schema })
      //   ...

      // Start with: new Elysia({ prefix: '/{pathSegment}' })
      const prefixPath = `${pathConfig.basePath}/${pathSegment}`;
      const elysiaConfig = conjure.obj()
        .prop("prefix", b.stringLiteral(prefixPath))
        .build();
      let chainExpr: n.Expression = b.newExpression(
        b.identifier("Elysia"),
        [elysiaConfig]
      );

      // Chain each route method
      for (const method of enabledMethods) {
        const { callExpr, schemaImports, needsElysiaT, inlineBodySchema } = buildRouteMethodCall(
          method,
          pathSegment,
          entityName,
          pathConfig,
          hasExternalSchemas,
          ctx.ir,
        );
        allSchemaImports.push(...schemaImports);
        if (inlineBodySchema) allInlineSchemas.push(inlineBodySchema);
        if (needsElysiaT) fileNeedsElysiaT = true;

        // Chain: expr.method(args) → becomes memberExpression + callExpression
        const httpMethod = kindToHttpMethod(method.kind);
        chainExpr = b.callExpression(
          b.memberExpression(cast.toExpr(chainExpr), b.identifier(httpMethod)),
          callExpr.arguments
        );
      }

      // Import t from elysia if any route needs params/query validation
      if (fileNeedsElysiaT) {
        file.import({ kind: "package", names: ["t"], from: "elysia" });
      }

      // Import schemas needed for body validation (when using external schemas)
      for (const schemaImport of allSchemaImports) {
        file.import({
          kind: "symbol",
          ref: {
            capability: "schemas",
            entity: schemaImport.entity,
            shape: schemaImport.shape,
          },
        });
      }

      // Emit inline TypeBox schemas (when not using external schemas)
      const inlineSchemaStmts = allInlineSchemas.map(({ varName, schema }) =>
        stmt.const(varName, schema)
      );

      // Export: export const userRoutes = new Elysia({ ... }).get(...).post(...)
      const routesVarName = `${inflect.uncapitalize(entityName)}Routes`;
      const exportStmt = conjure.export.const(routesVarName, chainExpr);

      // Emit inline schemas first, then the routes
      file.ast(conjure.program(...inlineSchemaStmts, exportStmt)).emit();

      // Track for aggregator index
      if (config.outputStyle !== "single") {
        generatedRoutes.push({
          fileName: `${inflect.uncapitalize(entityName)}.js`,
          exportName: routesVarName,
        });
      }
    }

    // Generate function routes if includeFunctions is true
    const { functions } = queryArtifact;
    if (config.includeFunctions && functions.length > 0) {
      const filePath = `${config.outputDir}/functions.ts`;
      const file = ctx.file(filePath);

      // Add header if provided
      if (config.header) {
        file.header(config.header);
      }

      // Import Elysia
      file.import({ kind: "package", names: ["Elysia"], from: "elysia" });

      // Collect function names to import from functions.ts query file
      const functionNames = functions.map(fn => fn.exportName);
      file.import({
        kind: "relative",
        names: functionNames,
        from: `${queriesPath}/functions.js`,
      });

      // Build the Elysia route chain
      const functionPrefix = pathConfig.functionPrefix;
      const basePath = pathConfig.basePath;
      const prefixPath = functionPrefix
        ? `${basePath}/${functionPrefix}`
        : basePath;

      const elysiaConfig = conjure.obj()
        .prop("prefix", b.stringLiteral(prefixPath))
        .build();
      let chainExpr: n.Expression = b.newExpression(
        b.identifier("Elysia"),
        [elysiaConfig]
      );

      let fileNeedsElysiaT = false;

      // Chain each function route
      for (const fn of functions) {
        const { callExpr, needsElysiaT } = buildFunctionRouteCall(fn, "");
        if (needsElysiaT) fileNeedsElysiaT = true;

        const httpMethod = volatilityToHttpMethod(fn.volatility);
        chainExpr = b.callExpression(
          b.memberExpression(cast.toExpr(chainExpr), b.identifier(httpMethod)),
          callExpr.arguments
        );
      }

      // Import t from elysia if any route needs validation
      if (fileNeedsElysiaT) {
        file.import({ kind: "package", names: ["t"], from: "elysia" });
      }

      // Export: export const functionRoutes = new Elysia({ ... }).get(...).post(...)
      const exportStmt = conjure.export.const("functionRoutes", chainExpr);
      file.ast(conjure.program(exportStmt)).emit();

      // Track for aggregator index
      generatedRoutes.push({
        fileName: "functions.js",
        exportName: "functionRoutes",
      });
    }

    // Generate aggregator index.ts
    if (config.generateIndex && config.outputStyle !== "single" && generatedRoutes.length > 0) {
      const indexPath = `${config.outputDir}/index.ts`;
      const indexFile = ctx.file(indexPath);

      // Add header if provided
      if (config.header) {
        indexFile.header(config.header);
      }

      // Import Elysia
      indexFile.import({ kind: "package", names: ["Elysia"], from: "elysia" });

      // Import each route module
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
          [b.identifier(route.exportName)]
        );
      }

      // Export: export const api = new Elysia().use(...)
      const aggregatorName = config.aggregatorName;
      const exportStmt = conjure.export.const(aggregatorName, chainExpr);
      indexFile.ast(conjure.program(exportStmt)).emit();
    }
  },
});

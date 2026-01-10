/**
 * HTTP tRPC Plugin - Generate tRPC routers from query plugins
 *
 * Consumes QueryArtifact from sql-queries or kysely-queries and generates
 * type-safe tRPC routers with Zod schema validation.
 *
 * Requires a "schemas" capability provider that uses Zod (the zod plugin).
 */
import { Schema as S, Either } from "effect";
import type { namedTypes as n } from "ast-types";
import { definePlugin } from "../services/plugin.js";
import { conjure, cast } from "../lib/conjure.js";
import { inflect } from "../services/inflection.js";

// ============================================================================
// Query Artifact Schema (consumer-defined)
// ============================================================================
// This schema defines what http-trpc expects from query plugins.
// We decode the artifact.data using this schema.

/** How to call a query function */
const CallSignature = S.Struct({
  style: S.Union(S.Literal("named"), S.Literal("positional")),
  bodyStyle: S.optional(S.Union(S.Literal("property"), S.Literal("spread"))),
});

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

const FunctionQueryMethod = S.Struct({
  functionName: S.String,
  exportName: S.String,
  schemaName: S.String,
  volatility: S.Union(S.Literal("immutable"), S.Literal("stable"), S.Literal("volatile")),
  params: S.Array(QueryMethodParam),
  returns: QueryMethodReturn,
  callSignature: S.optional(CallSignature),
});

const QueryArtifact = S.Struct({
  entities: S.Array(EntityQueryMethods),
  functions: S.Array(FunctionQueryMethod),
  sourcePlugin: S.String,
  outputDir: S.String,
});
type QueryArtifact = S.Schema.Type<typeof QueryArtifact>;

const { b, stmt } = conjure;

// ============================================================================
// Configuration Schema
// ============================================================================

/**
 * tRPC Plugin configuration schema.
 */
const HttpTrpcPluginConfigSchema = S.Struct({
  /** Output directory for generated router files. Default: "trpc" */
  outputDir: S.optionalWith(S.String, { default: () => "trpc" }),

  /** 
   * Path to import query functions from (relative to outputDir).
   * Auto-detected from query artifact's outputDir if not specified.
   */
  queriesPath: S.optional(S.String),

  /** Path to import tRPC context/procedure from */
  trpcPath: S.optionalWith(S.String, { default: () => "../trpc" }),

  /** Name of the base procedure to use. Default: "publicProcedure" */
  baseProcedure: S.optionalWith(S.String, { default: () => "publicProcedure" }),

  /** Per-entity configuration overrides */
  entities: S.optionalWith(S.Record({ key: S.String, value: S.Struct({
    /** Disable specific methods for this entity */
    disableMethods: S.optionalWith(S.Array(S.String), { default: () => [] }),
  }) }), {
    default: () => ({}),
  }),

  /** Custom file header comment */
  header: S.optional(S.String),
});

type HttpTrpcPluginConfig = S.Schema.Type<typeof HttpTrpcPluginConfigSchema>;

// ============================================================================
// Procedure Builders
// ============================================================================

/**
 * Map query method kind to tRPC procedure type.
 */
const kindToProcedureType = (kind: QueryMethod["kind"]): "query" | "mutation" => {
  switch (kind) {
    case "read":
    case "list":
    case "lookup":
      return "query";
    case "create":
    case "update":
    case "delete":
    case "function":
      return "mutation";
  }
};

/**
 * Build the handler function body for a procedure.
 * tRPC handlers receive { input, ctx } and return data directly.
 */
const buildProcedureBody = (method: QueryMethod): n.Statement[] => {
  const queryFnName = method.name;

  // Build the query function call
  // For body params: queryFn(input)
  // For other params: queryFn({ field: input.field, ... })
  const bodyParam = method.params.find(p => p.source === "body");
  
  let queryArg: n.Expression;
  if (bodyParam) {
    // Body is the entire input
    queryArg = b.identifier("input");
  } else if (method.params.length > 0) {
    // Build object from input fields
    let objBuilder = conjure.obj();
    for (const param of method.params) {
      objBuilder = objBuilder.prop(
        param.name,
        b.memberExpression(b.identifier("input"), b.identifier(param.name))
      );
    }
    queryArg = objBuilder.build();
  } else {
    // No params - call with empty object or no args
    queryArg = conjure.obj().build();
  }

  // Build: return await queryFn(args)
  const queryCall = b.callExpression(
    b.identifier(queryFnName),
    method.params.length > 0 ? [cast.toExpr(queryArg)] : []
  );
  const awaitExpr = b.awaitExpression(queryCall);

  // For delete, return success object
  if (method.kind === "delete") {
    return [
      b.expressionStatement(awaitExpr),
      b.returnStatement(
        conjure.obj().prop("success", b.booleanLiteral(true)).build()
      ),
    ];
  }

  return [b.returnStatement(awaitExpr)];
};

/**
 * Build a single tRPC procedure.
 * Returns: publicProcedure.input(schema).query/mutation(async ({ input }) => { ... })
 */
const buildProcedure = (
  method: QueryMethod,
  entityName: string,
  baseProcedure: string,
): { 
  procedureExpr: n.Expression; 
  schemaImports: Array<{ entity: string; shape?: string }>;
} => {
  const procedureType = kindToProcedureType(method.kind);
  const schemaImports: Array<{ entity: string; shape?: string }> = [];

  // Start with base procedure
  let chainExpr: n.Expression = b.identifier(baseProcedure);

  // Add .input(schema) if there are params
  if (method.params.length > 0) {
    const inputSchema = buildInputSchema(method, entityName, schemaImports);
    chainExpr = b.callExpression(
      b.memberExpression(cast.toExpr(chainExpr), b.identifier("input")),
      [cast.toExpr(inputSchema)]
    );
  }

  // Build the handler: async ({ input }) => { ... }
  const handlerParams: n.ObjectProperty[] = [];
  if (method.params.length > 0) {
    const inputProp = b.objectProperty(b.identifier("input"), b.identifier("input"));
    inputProp.shorthand = true;
    handlerParams.push(inputProp);
  }
  
  const handlerBody = buildProcedureBody(method);
  const handler = b.arrowFunctionExpression(
    [b.objectPattern(handlerParams)],
    b.blockStatement(handlerBody.map(cast.toStmt))
  );
  handler.async = true;

  // Add .query() or .mutation()
  chainExpr = b.callExpression(
    b.memberExpression(cast.toExpr(chainExpr), b.identifier(procedureType)),
    [handler]
  );

  return { procedureExpr: chainExpr, schemaImports };
};

/**
 * Build the input schema for a procedure.
 * For body params, import the insert/update schema.
 * For other params, build inline z.object({ ... }).
 */
const buildInputSchema = (
  method: QueryMethod,
  entityName: string,
  schemaImports: Array<{ entity: string; shape?: string }>,
): n.Expression => {
  const bodyParam = method.params.find(p => p.source === "body");
  
  if (bodyParam) {
    // Use imported schema for body
    const shape = method.kind === "create" ? "insert" : "update";
    schemaImports.push({ entity: entityName, shape });
    return b.identifier(`${entityName}${inflect.pascalCase(shape)}`);
  }

  // Build inline z.object({ field: z.type() })
  let objBuilder = conjure.obj();
  for (const param of method.params) {
    const zodType = paramToZodType(param);
    objBuilder = objBuilder.prop(param.name, zodType);
  }

  // z.object({ ... })
  return b.callExpression(
    b.memberExpression(b.identifier("z"), b.identifier("object")),
    [cast.toExpr(objBuilder.build())]
  );
};

/**
 * Convert a QueryMethodParam to a Zod type expression.
 */
const paramToZodType = (param: QueryMethodParam): n.Expression => {
  const baseType = param.type.replace(/\[\]$/, "").replace(/\?$/, "").toLowerCase();
  
  let zodCall: n.Expression;
  switch (baseType) {
    case "number":
    case "int":
    case "integer":
    case "float":
    case "double":
      // z.coerce.number() - coerce is a property, not a method
      zodCall = b.callExpression(
        b.memberExpression(
          b.memberExpression(b.identifier("z"), b.identifier("coerce")),
          b.identifier("number")
        ),
        []
      );
      break;
    case "boolean":
    case "bool":
      zodCall = b.callExpression(
        b.memberExpression(b.identifier("z"), b.identifier("boolean")),
        []
      );
      break;
    case "date":
      // z.coerce.date()
      zodCall = b.callExpression(
        b.memberExpression(
          b.memberExpression(b.identifier("z"), b.identifier("coerce")),
          b.identifier("date")
        ),
        []
      );
      break;
    case "string":
    default:
      zodCall = b.callExpression(
        b.memberExpression(b.identifier("z"), b.identifier("string")),
        []
      );
      break;
  }

  // Add .optional() if not required
  if (!param.required) {
    zodCall = b.callExpression(
      b.memberExpression(cast.toExpr(zodCall), b.identifier("optional")),
      []
    );
  }

  return zodCall;
};

// ============================================================================
// Plugin Definition
// ============================================================================

export const httpTrpcPlugin = definePlugin({
  name: "http-trpc",
  provides: ["http", "http:trpc"],
  requires: ["queries", "schemas"],
  configSchema: HttpTrpcPluginConfigSchema,
  inflection: {
    outputFile: ctx => `${ctx.entityName.toLowerCase()}.ts`,
    symbolName: (entityName, _artifactKind) => `${entityName.toLowerCase()}Router`,
  },

  run: (ctx, config) => {
    // Find any queries artifact (works with sql-queries, kysely-queries, or any future query plugin)
    const artifact = ctx.findArtifact("queries");

    if (!artifact) {
      return;
    }

    const decodeResult = S.decodeUnknownEither(QueryArtifact)(artifact.data);
    if (Either.isLeft(decodeResult)) {
      throw new Error(
        `http-trpc: Invalid artifact data from ${artifact.capability}. Expected QueryArtifact shape.`
      );
    }

    const queryArtifact = decodeResult.right;
    const { entities } = queryArtifact;

    // Compute queries import path: use config override or derive from artifact's outputDir
    const queriesPath = config.queriesPath ?? `../${queryArtifact.outputDir}`;

    // Generate router for each entity
    for (const entityMethods of entities) {
      const { entityName, methods } = entityMethods;

      // Get entity-specific config
      const entityConfig = config.entities[entityName];
      const disabledMethods = new Set(entityConfig?.disableMethods ?? []);

      // Filter to enabled methods
      const enabledMethods = methods.filter(m => !disabledMethods.has(m.name));

      if (enabledMethods.length === 0) continue;

      // Build file path
      const filePath = `${config.outputDir}/${entityName.toLowerCase()}.ts`;
      const file = ctx.file(filePath);

      // Add header if provided
      if (config.header) {
        file.header(config.header);
      }

      // Import z from zod
      file.import({ kind: "package", names: ["z"], from: "zod" });

      // Import router and procedure from trpc path
      file.import({
        kind: "relative",
        names: ["router", config.baseProcedure],
        from: `${config.trpcPath}.js`,
      });

      // Collect query function names to import
      const queryFunctionNames = enabledMethods.map(m => m.name);
      file.import({
        kind: "relative",
        names: queryFunctionNames,
        from: `${queriesPath}/${entityName}.js`,
      });

      // Collect schema imports
      const allSchemaImports: Array<{ entity: string; shape?: string }> = [];

      // Build router object: router({ findById: publicProcedure.input(...).query(...), ... })
      let routerObjBuilder = conjure.obj();

      for (const method of enabledMethods) {
        const { procedureExpr, schemaImports } = buildProcedure(
          method,
          entityName,
          config.baseProcedure,
        );
        allSchemaImports.push(...schemaImports);

        routerObjBuilder = routerObjBuilder.prop(method.name, procedureExpr);
      }

      // Import schemas for body validation
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

      // Build: export const userRouter = router({ ... })
      const routerName = `${entityName.toLowerCase()}Router`;
      const routerCall = b.callExpression(
        b.identifier("router"),
        [cast.toExpr(routerObjBuilder.build())]
      );

      const exportStmt = conjure.export.const(routerName, routerCall);
      file.ast(conjure.program(exportStmt)).emit();
    }
  },
});

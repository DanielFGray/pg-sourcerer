/**
 * HTTP oRPC Plugin - Generate oRPC routers from query plugins
 *
 * Consumes QueryArtifact from sql-queries or kysely-queries and generates
 * type-safe oRPC procedures using @orpc/server.
 *
 * Uses oRPC's `type()` utility for simple params (type-only, no runtime validation)
 * and imports body schemas from whatever plugin provides the "schemas" capability
 * (zod, arktype, effect-model, etc.) for runtime validation.
 */
import { Schema as S, Either } from "effect";
import type { namedTypes as n } from "ast-types";
import { definePlugin } from "../services/plugin.js";
import { conjure, cast } from "../lib/conjure.js";
import { inflect } from "../services/inflection.js";

// ============================================================================
// Query Artifact Schema (consumer-defined)
// ============================================================================
// This schema defines what http-orpc expects from query plugins.
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
 * oRPC Plugin configuration schema.
 */
const HttpOrpcPluginConfigSchema = S.Struct({
  /** Output directory for generated router files. Default: "orpc" */
  outputDir: S.optionalWith(S.String, { default: () => "orpc" }),

  /** 
   * Path to import query functions from (relative to outputDir).
   * Auto-detected from query artifact's outputDir if not specified.
   */
  queriesPath: S.optional(S.String),

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

type HttpOrpcPluginConfig = S.Schema.Type<typeof HttpOrpcPluginConfigSchema>;

// ============================================================================
// Procedure Name Mapping
// ============================================================================

/**
 * Map query method kind to oRPC procedure name.
 * Uses consistent short names that avoid reserved words.
 */
const kindToProcedureName = (method: QueryMethod): string => {
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
      return "remove"; // 'delete' is a reserved word
    case "lookup": {
      // For lookups, use the lookup field name: findByEmail, findBySlug, etc.
      // Differentiate unique vs non-unique lookups
      const baseName = `findBy${inflect.pascalCase(method.lookupField ?? "field")}`;
      // If it's a non-unique lookup returning an array, suffix with "Many"
      if (!method.isUniqueLookup) {
        return `${baseName}Many`;
      }
      return baseName;
    }
    case "function":
      // Suffix with "Fn" to avoid conflicts with imported query function names
      return `${method.name}Fn`;
  }
};

// ============================================================================
// Type String Builders (for oRPC type<>() utility)
// ============================================================================

/**
 * Convert a QueryMethodParam to a TypeScript type string for use in type<>().
 */
const paramToTypeString = (param: QueryMethodParam): string => {
  const baseType = param.type.replace(/\[\]$/, "").replace(/\?$/, "").toLowerCase();
  
  let tsType: string;
  switch (baseType) {
    case "number":
    case "int":
    case "integer":
    case "float":
    case "double":
      tsType = "number";
      break;
    case "boolean":
    case "bool":
      tsType = "boolean";
      break;
    case "date":
      tsType = "Date";
      break;
    case "string":
    default:
      tsType = "string";
      break;
  }
  
  // Handle arrays
  if (param.type.endsWith("[]")) {
    tsType = `${tsType}[]`;
  }
  
  // Handle optionality
  if (!param.required) {
    tsType = `${tsType} | undefined`;
  }
  
  return tsType;
};

/**
 * Build a TypeScript object type literal string for type<>().
 * Returns something like "{ id: number; name?: string }"
 */
const buildTypeObjectString = (params: readonly QueryMethodParam[]): string => {
  if (params.length === 0) return "{}";
  
  const fields = params.map(param => {
    const typeStr = paramToTypeString(param);
    const optional = !param.required ? "?" : "";
    return `${param.name}${optional}: ${typeStr.replace(" | undefined", "")}`;
  });
  
  return `{ ${fields.join("; ")} }`;
};

// ============================================================================
// Procedure Builders
// ============================================================================

/**
 * Build the handler function body for a procedure.
 * oRPC handlers receive { input, context } and return data directly.
 */
const buildProcedureBody = (method: QueryMethod): n.Statement[] => {
  const queryFnName = method.name;

  // Build the query function call
  // For body params: queryFn(input)
  // For other params: queryFn({ field: input.field, ... }) or queryFn(input)
  const bodyParam = method.params.find(p => p.source === "body");
  
  let queryArg: n.Expression;
  if (bodyParam) {
    // Body is the entire input
    queryArg = b.identifier("input");
  } else if (method.params.length > 0) {
    // For simple params, just pass input directly since it matches the shape
    queryArg = b.identifier("input");
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
 * Build a single oRPC procedure.
 * Returns: os.input(type<InputType>()).handler(async ({ input }) => { ... })
 * Or for body schemas: os.input(BodySchema).handler(...)
 */
const buildProcedure = (
  method: QueryMethod,
  entityName: string,
): { 
  procedureExpr: n.Expression; 
  schemaImports: Array<{ entity: string; shape?: string }>;
  needsType: boolean;
} => {
  const schemaImports: Array<{ entity: string; shape?: string }> = [];
  let needsType = false;

  // Start with os
  let chainExpr: n.Expression = b.identifier("os");

  // Add .input(...) if there are params
  if (method.params.length > 0) {
    const bodyParam = method.params.find(p => p.source === "body");
    
    let inputSchema: n.Expression;
    if (bodyParam) {
      // Use imported schema for body (has runtime validation)
      const shape = method.kind === "create" ? "insert" : "update";
      schemaImports.push({ entity: entityName, shape });
      inputSchema = b.identifier(`${entityName}${inflect.pascalCase(shape)}`);
    } else {
      // Use type<>() for simple params (type-only, no runtime validation)
      needsType = true;
      const typeStr = buildTypeObjectString(method.params);
      // Build: type<{ id: number }>()
      // This is a generic call, we need to use TSTypeParameterInstantiation
      const typeCall = b.callExpression(b.identifier("type"), []);
      // Add type parameter as a comment since ast-types doesn't handle generics well
      // We'll use a workaround: build as identifier with the full expression
      inputSchema = b.identifier(`type<${typeStr}>()`);
    }
    
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

  // Add .handler(...)
  chainExpr = b.callExpression(
    b.memberExpression(cast.toExpr(chainExpr), b.identifier("handler")),
    [handler]
  );

  return { procedureExpr: chainExpr, schemaImports, needsType };
};

// ============================================================================
// Plugin Definition
// ============================================================================

export const httpOrpcPlugin = definePlugin({
  name: "http-orpc",
  provides: ["http", "http:orpc"],
  requires: ["queries", "schemas"],
  configSchema: HttpOrpcPluginConfigSchema,
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
        `http-orpc: Invalid artifact data from ${artifact.capability}. Expected QueryArtifact shape.`
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

      // Collect all query function names to import
      const queryFunctionNames = enabledMethods.map(m => m.name);
      file.import({
        kind: "relative",
        names: queryFunctionNames,
        from: `${queriesPath}/${entityName}.js`,
      });

      // Collect schema imports and track if we need 'type'
      const allSchemaImports: Array<{ entity: string; shape?: string }> = [];
      let fileNeedsType = false;

      // Build individual procedure exports and router object
      // Track used names to handle duplicates
      const usedNames = new Set<string>();
      const procedureStatements: n.Statement[] = [];
      let routerObjBuilder = conjure.obj();

      for (const method of enabledMethods) {
        let procedureName = kindToProcedureName(method);
        
        // Deduplicate: if name already used, append a numeric suffix
        if (usedNames.has(procedureName)) {
          let suffix = 2;
          while (usedNames.has(`${procedureName}${suffix}`)) {
            suffix++;
          }
          procedureName = `${procedureName}${suffix}`;
        }
        usedNames.add(procedureName);
        
        const { procedureExpr, schemaImports, needsType } = buildProcedure(
          method,
          entityName,
        );
        allSchemaImports.push(...schemaImports);
        if (needsType) fileNeedsType = true;

        // Build: export const findById = os.input(...).handler(...)
        const exportStmt = conjure.export.const(procedureName, procedureExpr);
        procedureStatements.push(exportStmt);

        // Add to router object
        routerObjBuilder = routerObjBuilder.prop(procedureName, b.identifier(procedureName));
      }

      // Import os (and type if needed) from @orpc/server
      const orpcImports = ["os"];
      if (fileNeedsType) {
        orpcImports.push("type");
      }
      file.import({ kind: "package", names: orpcImports, from: "@orpc/server" });

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

      // Build: export const userRouter = { findById, list, create, ... }
      const routerName = `${entityName.toLowerCase()}Router`;
      const routerExport = conjure.export.const(routerName, routerObjBuilder.build());

      // Emit all procedure exports followed by router export
      const allStatements = [...procedureStatements, routerExport];
      file.ast(conjure.program(...allStatements)).emit();
    }
  },
});

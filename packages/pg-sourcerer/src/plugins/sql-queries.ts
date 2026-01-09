/**
 * SQL Queries Plugin - Generate raw SQL query functions using template strings
 */
import { Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";
import { definePlugin } from "../services/plugin.js";
import type { FileNameContext } from "../services/plugin.js";
import type { Field, IndexDef, TableEntity, EnumEntity, SemanticIR, Relation, FunctionEntity, FunctionArg, CompositeEntity } from "../ir/semantic-ir.js";
import { getTableEntities, getEnumEntities, getFunctionEntities, getCompositeEntities } from "../ir/semantic-ir.js";
import { conjure, cast } from "../lib/conjure.js";
import { hex, type SqlStyle, type QueryParts } from "../lib/hex.js";
import { resolveFieldType, tsTypeToAst } from "../lib/field-utils.js";
import { inflect } from "../services/inflection.js";

const { ts, b, param } = conjure;

// ============================================================================
// Configuration
// ============================================================================

const SqlQueriesPluginConfig = S.Struct({
  outputDir: S.optionalWith(S.String, { default: () => "sql-queries" }),
  /** SQL query style. Defaults to "tag" (tagged template literals) */
  sqlStyle: S.optionalWith(S.Union(S.Literal("tag"), S.Literal("string")), { default: () => "tag" as const }),
  /** Generate wrappers for PostgreSQL functions. Defaults to true. */
  generateFunctions: S.optionalWith(S.Boolean, { default: () => true }),
  /** Output file for scalar-returning functions. Defaults to "functions.ts". */
  functionsFile: S.optionalWith(S.String, { default: () => "functions.ts" }),
});

type SqlQueriesPluginConfig = S.Schema.Type<typeof SqlQueriesPluginConfig>;

// ============================================================================
// Context & Type Helpers
// ============================================================================

interface GenerationContext {
  readonly entity: TableEntity;
  readonly enums: readonly EnumEntity[];
  readonly ir: SemanticIR;
  readonly sqlStyle: SqlStyle;
}

/** Find a field in the row shape by column name */
const findRowField = (entity: TableEntity, columnName: string): Field | undefined =>
  entity.shapes.row.fields.find(f => f.columnName === columnName);

/** Get the TypeScript type AST for a field */
const getFieldTypeAst = (field: Field | undefined, ctx: GenerationContext): n.TSType => {
  if (!field) return ts.string();
  const resolved = resolveFieldType(field, ctx.enums, ctx.ir.extensions);
  return resolved.enumDef ? ts.ref(resolved.enumDef.name) : tsTypeToAst(resolved.tsType);
};

// ============================================================================
// FK Semantic Naming Helpers
// ============================================================================

/**
 * Find a belongsTo relation that uses the given column as its local FK column.
 * For single-column indexes only.
 */
const findRelationForColumn = (
  entity: TableEntity,
  columnName: string
): Relation | undefined =>
  entity.relations.find(
    r => r.kind === "belongsTo" && r.columns.length === 1 && r.columns[0]?.local === columnName
  );

/**
 * Derive semantic name for an FK-based lookup.
 * Priority: @fieldName tag → column minus _id suffix → target entity name
 */
const deriveSemanticName = (relation: Relation, columnName: string): string => {
  // 1. Check for @fieldName smart tag
  if (relation.tags.fieldName && typeof relation.tags.fieldName === "string") {
    return relation.tags.fieldName;
  }

  // 2. Strip common FK suffixes from column name
  const suffixes = ["_id", "_fk", "Id", "Fk"];
  for (const suffix of suffixes) {
    if (columnName.endsWith(suffix)) {
      const stripped = columnName.slice(0, -suffix.length);
      if (stripped.length > 0) return stripped;
    }
  }

  // 3. Fall back to target entity name (lowercased first char)
  const target = relation.targetEntity;
  return target.charAt(0).toLowerCase() + target.slice(1);
};

/**
 * Capitalize first letter for use in function names
 */
/**
 * Convert to PascalCase for use in function names.
 * Handles snake_case (created_at → CreatedAt) and regular strings.
 */
const toPascalCase = (s: string): string => inflect.pascalCase(s);

// ============================================================================
// CRUD Function Generators
// ============================================================================

/** Generate findById function if entity has a primary key and canSelect permission */
const generateFindById = (ctx: GenerationContext): n.Statement | undefined => {
  const { entity, sqlStyle } = ctx;
  if (!entity.primaryKey || !entity.permissions.canSelect) return undefined;

  const pkColName = entity.primaryKey.columns[0]!;
  const pkField = findRowField(entity, pkColName);
  if (!pkField) return undefined;

  const rowType = entity.shapes.row.name;
  const fieldName = pkField.name; // JS property name (e.g., "id")

  const parts: QueryParts = {
    templateParts: [`select * from ${entity.schemaName}.${entity.pgName} where ${pkColName} = `, ""],
    params: [b.identifier(fieldName)],
  };

  // Build query and extract first row
  const queryExpr = hex.query(sqlStyle, parts, ts.array(ts.ref(rowType)));
  const varDecl = hex.firstRowDecl(sqlStyle, "result", queryExpr);

  return conjure.export.fn(
    hex.asyncFn(`find${entity.name}ById`, [param.pick([fieldName], rowType)], [
      varDecl,
      b.returnStatement(b.identifier("result")),
    ]),
  );
};

/** Generate findMany function with pagination if entity has canSelect permission */
const generateFindMany = (ctx: GenerationContext): n.Statement | undefined => {
  const { entity, sqlStyle } = ctx;
  if (!entity.permissions.canSelect) return undefined;

  const rowType = entity.shapes.row.name;

  const parts: QueryParts = {
    templateParts: [`select * from ${entity.schemaName}.${entity.pgName} limit `, ` offset `, ""],
    params: [b.identifier("limit"), b.identifier("offset")],
  };

  return conjure.export.fn(
    hex.asyncFn(
      `findMany${entity.name}s`,
      [
        param.destructured([
          { name: "limit", type: ts.number(), optional: true, defaultValue: b.numericLiteral(50) },
          { name: "offset", type: ts.number(), optional: true, defaultValue: b.numericLiteral(0) },
        ]),
      ],
      hex.returnQuery(sqlStyle, parts, ts.array(ts.ref(rowType))),
    ),
  );
};

/** Generate delete function if entity has a primary key and canDelete permission */
const generateDelete = (ctx: GenerationContext): n.Statement | undefined => {
  const { entity, sqlStyle } = ctx;
  if (!entity.primaryKey || !entity.permissions.canDelete) return undefined;

  const pkColName = entity.primaryKey.columns[0]!;
  const pkField = findRowField(entity, pkColName);
  if (!pkField) return undefined;

  const rowType = entity.shapes.row.name;
  const fieldName = pkField.name;

  const parts: QueryParts = {
    templateParts: [`delete from ${entity.schemaName}.${entity.pgName} where ${pkColName} = `, ""],
    params: [b.identifier(fieldName)],
  };

  // Delete returns void, no type parameter needed
  const queryExpr = hex.query(sqlStyle, parts);
  return conjure.export.fn(
    hex.asyncFn(`delete${entity.name}`, [param.pick([fieldName], rowType)], [
      b.expressionStatement(queryExpr),
    ]),
  );
};

/** Generate insert function if entity has canInsert permission */
const generateInsert = (ctx: GenerationContext): n.Statement | undefined => {
  const { entity, sqlStyle } = ctx;
  if (!entity.permissions.canInsert) return undefined;

  // Use insert shape if available, otherwise fall back to row
  const insertShape = entity.shapes.insert ?? entity.shapes.row;
  const rowType = entity.shapes.row.name;
  const insertType = insertShape.name;

  // Build column list and values from insertable fields
  const insertableFields = insertShape.fields.filter(f => f.permissions.canInsert);
  if (insertableFields.length === 0) return undefined;

  const columnNames = insertableFields.map(f => f.columnName);
  const fieldNames = insertableFields.map(f => f.name);

  // Build: insert into schema.table (col1, col2) values ($data.field1, $data.field2) returning *
  const columnList = columnNames.join(", ");
  const valuePlaceholders = fieldNames.map((_, i) => (i === 0 ? "" : ", "));
  
  // Template parts: "insert into ... values (" + "" + ", " + ", " + ... + ") returning *"
  const parts: QueryParts = {
    templateParts: [
      `insert into ${entity.schemaName}.${entity.pgName} (${columnList}) values (`,
      ...valuePlaceholders.slice(1),
      `) returning *`,
    ],
    params: fieldNames.map(f => b.memberExpression(b.identifier("data"), b.identifier(f), false)),
  };

  const queryExpr = hex.query(sqlStyle, parts, ts.array(ts.ref(rowType)));
  const varDecl = hex.firstRowDecl(sqlStyle, "result", queryExpr);

  // Simple typed parameter: data: InsertType
  const dataParam = param.typed("data", ts.ref(insertType));

  return conjure.export.fn(
    hex.asyncFn(`insert${entity.name}`, [dataParam], [varDecl, b.returnStatement(b.identifier("result"))]),
  );
};

/** Generate all CRUD functions for an entity */
const generateCrudFunctions = (ctx: GenerationContext): readonly n.Statement[] =>
  [
    generateFindById(ctx),
    generateFindMany(ctx),
    generateInsert(ctx),
    generateDelete(ctx),
  ].filter((s): s is n.Statement => s != null);

// ============================================================================
// Index-based Lookup Functions
// ============================================================================

/** Check if an index should generate a lookup function */
const shouldGenerateLookup = (index: IndexDef): boolean =>
  !index.isPartial &&
  !index.hasExpressions &&
  index.columns.length === 1 &&
  index.method !== "gin" &&
  index.method !== "gist";

/**
 * Generate a function name for an index-based lookup.
 * Uses semantic naming when the column corresponds to an FK relation.
 */
const generateLookupName = (
  entity: TableEntity,
  index: IndexDef,
  relation: Relation | undefined
): string => {
  const isUnique = index.isUnique || index.isPrimary;
  const entityName = isUnique
    ? entity.name.replace(/s$/, "") // singular for unique
    : entity.name.replace(/s$/, "") + "s"; // plural for non-unique

  // Use semantic name if FK relation exists, otherwise fall back to column name
  const columnName = index.columnNames[0]!;
  const byName = relation
    ? deriveSemanticName(relation, columnName)
    : index.columns[0]!;

  return `get${entityName}By${toPascalCase(byName)}`;
};

/**
 * Generate a lookup function for a single-column index.
 * Uses semantic parameter naming when the column corresponds to an FK relation.
 */
const generateLookupFunction = (index: IndexDef, ctx: GenerationContext): n.Statement => {
  const { entity, sqlStyle } = ctx;
  const rowType = entity.shapes.row.name;
  const columnName = index.columnNames[0]!;
  const field = findRowField(entity, columnName);
  const fieldName = field?.name ?? index.columns[0]!;
  const isUnique = index.isUnique || index.isPrimary;

  // Check if this index column corresponds to an FK relation
  const relation = findRelationForColumn(entity, columnName);

  // Use semantic param name if FK relation exists, otherwise use field name
  const paramName = relation
    ? deriveSemanticName(relation, columnName)
    : fieldName;

  // For semantic naming, use indexed access type (Post["userId"])
  // For regular naming, use Pick<Post, "fieldName">
  const useSemanticNaming = relation !== undefined && paramName !== fieldName;

  const parts: QueryParts = {
    templateParts: [`select * from ${entity.schemaName}.${entity.pgName} where ${columnName} = `, ""],
    params: [b.identifier(paramName)],
  };

  const fnName = generateLookupName(entity, index, relation);

  // Build the parameter - use indexed access type for semantic naming
  const paramNode = useSemanticNaming
    ? param.typed(paramName, ts.indexedAccess(ts.ref(rowType), ts.literal(fieldName)))
    : param.pick([fieldName], rowType);

  if (isUnique) {
    // Extract first row for unique lookups
    const queryExpr = hex.query(sqlStyle, parts, ts.array(ts.ref(rowType)));
    const varDecl = hex.firstRowDecl(sqlStyle, "result", queryExpr);

    return conjure.export.fn(
      hex.asyncFn(fnName, [paramNode], [
        varDecl,
        b.returnStatement(b.identifier("result")),
      ]),
    );
  }

  // Non-unique: return all matching rows
  return conjure.export.fn(
    hex.asyncFn(fnName, [paramNode], hex.returnQuery(sqlStyle, parts, ts.array(ts.ref(rowType)))),
  );
};

/** Generate lookup functions for all eligible indexes, deduplicating by name */
const generateLookupFunctions = (ctx: GenerationContext): readonly n.Statement[] => {
  const seen = new Set<string>();

  return ctx.entity.indexes
    .filter(index => shouldGenerateLookup(index) && !index.isPrimary)
    .filter(index => {
      const columnName = index.columnNames[0]!;
      const relation = findRelationForColumn(ctx.entity, columnName);
      const name = generateLookupName(ctx.entity, index, relation);
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    })
    .map(index => generateLookupFunction(index, ctx));
};

// ============================================================================
// Function Wrapper Generation
// ============================================================================

/**
 * Map PostgreSQL type names to TypeScript types.
 * Simplified version - covers common scalar types.
 */
const pgTypeNameToTs = (typeName: string): string => {
  const typeMap: Record<string, string> = {
    // Numeric
    int2: "number",
    int4: "number",
    int8: "string", // bigint as string
    float4: "number",
    float8: "number",
    numeric: "string",
    decimal: "string",
    // Text
    text: "string",
    varchar: "string",
    char: "string",
    citext: "string",
    name: "string",
    // Boolean
    bool: "boolean",
    // Date/time
    date: "Date",
    timestamp: "Date",
    timestamptz: "Date",
    time: "string",
    timetz: "string",
    interval: "string",
    // UUID
    uuid: "string",
    // JSON
    json: "unknown",
    jsonb: "unknown",
    // Binary
    bytea: "Buffer",
    // Other
    void: "void",
  };
  return typeMap[typeName] ?? "unknown";
};

/**
 * Check if a function argument has a row type (composite type matching a table).
 * Functions with row-type arguments are computed fields, not standalone functions.
 */
const hasRowTypeArg = (arg: FunctionArg, ir: SemanticIR): boolean => {
  const tables = getTableEntities(ir);
  return tables.some(t => {
    const qualifiedName = `${t.schemaName}.${t.pgName}`;
    return arg.typeName === qualifiedName || arg.typeName === t.pgName;
  });
};

/**
 * Check if a function can be wrapped (not a trigger, computed field, etc.)
 */
const isGeneratableFunction = (fn: FunctionEntity, ir: SemanticIR): boolean => {
  if (!fn.canExecute) return false;
  if (fn.returnTypeName === "trigger") return false;
  if (fn.isFromExtension) return false;
  if (fn.tags.omit === true) return false;
  // Filter out computed field functions (have row-type args)
  if (fn.args.some(arg => hasRowTypeArg(arg, ir))) return false;
  return true;
};

/**
 * Categorize functions by volatility.
 * Volatile functions go in mutations namespace, stable/immutable in queries.
 */
const categorizeFunction = (fn: FunctionEntity): "queries" | "mutations" =>
  fn.volatility === "volatile" ? "mutations" : "queries";

/**
 * Get all generatable functions from the IR, categorized by volatility.
 */
const getGeneratableFunctions = (ir: SemanticIR): {
  queries: FunctionEntity[];
  mutations: FunctionEntity[];
} => {
  const all = getFunctionEntities(ir).filter(fn => isGeneratableFunction(fn, ir));
  return {
    queries: all.filter(fn => categorizeFunction(fn) === "queries"),
    mutations: all.filter(fn => categorizeFunction(fn) === "mutations"),
  };
};

/**
 * Resolved return type information for function wrappers.
 */
interface ResolvedReturnType {
  readonly tsType: string;
  readonly isArray: boolean;
  readonly isScalar: boolean;
  readonly needsImport?: string;
  readonly returnEntity?: TableEntity | CompositeEntity;
}

/**
 * Resolve a function's return type to TypeScript type information.
 */
const resolveReturnType = (fn: FunctionEntity, ir: SemanticIR): ResolvedReturnType => {
  const returnTypeName = fn.returnTypeName;
  const isArray = fn.returnsSet;

  // 1. Check if it's a table return type
  const tableEntities = getTableEntities(ir);
  const tableMatch = tableEntities.find(entity => {
    const qualifiedName = `${entity.schemaName}.${entity.pgName}`;
    return returnTypeName === qualifiedName || returnTypeName === entity.pgName;
  });
  if (tableMatch) {
    return {
      tsType: tableMatch.name,
      isArray,
      isScalar: false,
      needsImport: tableMatch.name,
      returnEntity: tableMatch,
    };
  }

  // 2. Check if it's a composite type return
  const compositeEntities = getCompositeEntities(ir);
  const compositeMatch = compositeEntities.find(entity => {
    const qualifiedName = `${entity.schemaName}.${entity.pgName}`;
    return returnTypeName === qualifiedName || returnTypeName === entity.pgName;
  });
  if (compositeMatch) {
    return {
      tsType: compositeMatch.name,
      isArray,
      isScalar: false,
      needsImport: compositeMatch.name,
      returnEntity: compositeMatch,
    };
  }

  // 3. It's a scalar type - map via type name
  const baseTypeName = returnTypeName.includes(".")
    ? returnTypeName.split(".").pop()!
    : returnTypeName;
  const tsType = pgTypeNameToTs(baseTypeName);

  return {
    tsType,
    isArray,
    isScalar: true,
  };
};

/**
 * Resolved argument information for function wrappers.
 */
interface ResolvedArg {
  readonly name: string;
  readonly tsType: string;
  readonly isOptional: boolean;
  readonly needsImport?: string;
}

/**
 * Resolve a function argument to TypeScript type information.
 */
const resolveArg = (arg: FunctionArg, ir: SemanticIR): ResolvedArg => {
  const typeName = arg.typeName;

  // Check if it's an array type (ends with [])
  const isArrayType = typeName.endsWith("[]");
  const baseTypeName = isArrayType ? typeName.slice(0, -2) : typeName;

  // Check enums
  const enums = getEnumEntities(ir);
  const enumMatch = enums.find(e => {
    const qualifiedName = `${e.schemaName}.${e.pgName}`;
    return baseTypeName === qualifiedName || baseTypeName === e.pgName;
  });
  if (enumMatch) {
    const tsType = isArrayType ? `${enumMatch.name}[]` : enumMatch.name;
    return {
      name: arg.name || "arg",
      tsType,
      isOptional: arg.hasDefault,
      needsImport: enumMatch.name,
    };
  }

  // Check composites
  const composites = getCompositeEntities(ir);
  const compositeMatch = composites.find(e => {
    const qualifiedName = `${e.schemaName}.${e.pgName}`;
    return baseTypeName === qualifiedName || baseTypeName === e.pgName;
  });
  if (compositeMatch) {
    const tsType = isArrayType ? `${compositeMatch.name}[]` : compositeMatch.name;
    return {
      name: arg.name || "arg",
      tsType,
      isOptional: arg.hasDefault,
      needsImport: compositeMatch.name,
    };
  }

  // Scalar type - map via type name
  const scalarBase = baseTypeName.includes(".")
    ? baseTypeName.split(".").pop()!
    : baseTypeName;
  const scalarTs = pgTypeNameToTs(scalarBase);
  const tsType = isArrayType ? `${scalarTs}[]` : scalarTs;

  return {
    name: arg.name || "arg",
    tsType,
    isOptional: arg.hasDefault,
  };
};

/**
 * Resolve all arguments for a function.
 */
const resolveArgs = (fn: FunctionEntity, ir: SemanticIR): ResolvedArg[] =>
  fn.args.map(arg => resolveArg(arg, ir));

/**
 * Get the fully qualified function name for SQL.
 */
const getFunctionQualifiedName = (fn: FunctionEntity): string =>
  `${fn.schemaName}.${fn.pgName}`;

/**
 * Generate a function wrapper for a PostgreSQL function.
 *
 * Patterns:
 * - SETOF/table return: select * from schema.fn(args)
 * - Single row return: select * from schema.fn(args) (same SQL, single result)
 * - Scalar return: select schema.fn(args)
 */
const generateFunctionWrapper = (
  fn: FunctionEntity,
  ir: SemanticIR,
  sqlStyle: SqlStyle,
): n.Statement => {
  const resolvedReturn = resolveReturnType(fn, ir);
  const resolvedArgs = resolveArgs(fn, ir);
  const qualifiedName = getFunctionQualifiedName(fn);

  // Use fn.name which is already inflected by the IR builder
  const exportName = fn.name;

  // Helper to convert resolved type string to AST
  const typeStrToAst = (typeStr: string): n.TSType => {
    if (typeStr.endsWith("[]")) {
      const elemType = typeStr.slice(0, -2);
      return ts.array(typeStrToAst(elemType));
    }
    switch (typeStr) {
      case "string": return ts.string();
      case "number": return ts.number();
      case "boolean": return ts.boolean();
      case "void": return ts.void();
      case "unknown": return ts.unknown();
      case "Date": return ts.ref("Date");
      case "Buffer": return ts.ref("Buffer");
      default: return ts.ref(typeStr);
    }
  };

  // Build parameter list for the generated function
  const params: n.Identifier[] = resolvedArgs.map(arg => {
    const p = b.identifier(arg.name);
    p.typeAnnotation = b.tsTypeAnnotation(cast.toTSType(typeStrToAst(arg.tsType)));
    if (arg.isOptional) p.optional = true;
    return p;
  });

  // Build SQL based on return type
  let sql: string;
  let resultType: n.TSType;

  if (resolvedReturn.isScalar) {
    // Scalar: select schema.fn(args)
    const argPlaceholders = resolvedArgs.map((_, i) => `$${i + 1}`).join(", ");
    sql = `select ${qualifiedName}(${argPlaceholders})`;
    // Return type is a record with the function name as key
    resultType = ts.array(ts.ref("Record", [ts.string(), typeStrToAst(resolvedReturn.tsType)]));
  } else {
    // Table/composite: select * from schema.fn(args)
    const argPlaceholders = resolvedArgs.map((_, i) => `$${i + 1}`).join(", ");
    sql = `select * from ${qualifiedName}(${argPlaceholders})`;
    resultType = ts.array(ts.ref(resolvedReturn.tsType));
  }

  const paramExprs = resolvedArgs.map(arg => b.identifier(arg.name));

  // Build template parts by splitting on $N placeholders
  let templateParts = sql.split(/\$\d+/);
  // For zero-arg functions, template is just the SQL string
  if (resolvedArgs.length === 0) {
    templateParts = [sql];
  }

  const parts: QueryParts = {
    templateParts,
    params: paramExprs,
  };

  // Build the function body
  let body: n.Statement[];

  if (resolvedReturn.isScalar) {
    // Scalar: extract the result from the first row's first column
    const queryExpr = hex.query(sqlStyle, parts, resultType);
    const varDecl = hex.firstRowDecl(sqlStyle, "row", queryExpr);
    // Use optional chaining: row?.[fn.pgName]
    const optionalReturn = b.optionalMemberExpression(
      b.identifier("row"),
      b.identifier(fn.pgName),
      false,
      true
    );
    body = [varDecl, b.returnStatement(optionalReturn)];
  } else if (resolvedReturn.isArray) {
    // SETOF: return all rows
    body = hex.returnQuery(sqlStyle, parts, resultType);
  } else {
    // Single row: extract first row
    const queryExpr = hex.query(sqlStyle, parts, resultType);
    const varDecl = hex.firstRowDecl(sqlStyle, "result", queryExpr);
    body = [varDecl, b.returnStatement(b.identifier("result"))];
  }

  return conjure.export.fn(hex.asyncFn(exportName, params, body));
};

/**
 * Collect type imports needed for function wrappers.
 */
const collectFunctionTypeImports = (
  functions: readonly FunctionEntity[],
  ir: SemanticIR
): Set<string> => {
  const imports = new Set<string>();

  for (const fn of functions) {
    const resolvedReturn = resolveReturnType(fn, ir);
    if (resolvedReturn.needsImport) {
      imports.add(resolvedReturn.needsImport);
    }

    for (const arg of resolveArgs(fn, ir)) {
      if (arg.needsImport) {
        imports.add(arg.needsImport);
      }
    }
  }

  return imports;
};

// ============================================================================
// Plugin Definition
// ============================================================================

export const sqlQueriesPlugin = definePlugin({
  name: "sql-queries",
  provides: ["queries", "queries:sql"],
  requires: ["types"],
  configSchema: SqlQueriesPluginConfig,
  inflection: {
    outputFile: ctx => `${ctx.entityName}.ts`,
    symbolName: (entityName, artifactKind) => `${entityName}${artifactKind}`,
  },

  run: (ctx, config) => {
    const enums = getEnumEntities(ctx.ir);
    const { sqlStyle, generateFunctions } = config;

    // Pre-compute function groupings by return entity name
    // Functions returning entities go in that entity's file; scalars go in functions.ts
    const functionsByEntity = new Map<string, FunctionEntity[]>();
    const scalarFunctions: FunctionEntity[] = [];

    if (generateFunctions) {
      const { queries, mutations } = getGeneratableFunctions(ctx.ir);
      const allFunctions = [...queries, ...mutations];

      for (const fn of allFunctions) {
        const resolved = resolveReturnType(fn, ctx.ir);
        if (resolved.returnEntity) {
          const entityName = resolved.returnEntity.name;
          const existing = functionsByEntity.get(entityName) ?? [];
          functionsByEntity.set(entityName, [...existing, fn]);
        } else {
          scalarFunctions.push(fn);
        }
      }
    }

    getTableEntities(ctx.ir)
      .filter(entity => entity.tags.omit !== true)
      .forEach(entity => {
        const genCtx: GenerationContext = { entity, enums, ir: ctx.ir, sqlStyle };
        const crudStatements = [...generateCrudFunctions(genCtx), ...generateLookupFunctions(genCtx)];

        // Get functions that return this entity
        const entityFunctions = functionsByEntity.get(entity.name) ?? [];

        if (crudStatements.length === 0 && entityFunctions.length === 0) return;

        const entityName = ctx.inflection.entityName(entity.pgClass, entity.tags);
        const fileNameCtx: FileNameContext = {
          entityName,
          pgName: entity.pgName,
          schema: entity.schemaName,
          inflection: ctx.inflection,
          entity,
        };
        const filePath = `${config.outputDir}/${ctx.pluginInflection.outputFile(fileNameCtx)}`;

        // All statements for the file: CRUD methods + function wrappers
        const statements: n.Statement[] = [...crudStatements];

        // Add function wrappers
        for (const fn of entityFunctions) {
          statements.push(generateFunctionWrapper(fn, ctx.ir, sqlStyle));
        }

        const file = ctx.file(filePath);

        // Import the appropriate SQL client based on style
        if (sqlStyle === "tag") {
          file.import({ kind: "relative", names: ["sql"], from: "../db" });
        } else {
          file.import({ kind: "relative", names: ["pool"], from: "../db" });
        }

        file.import({
          kind: "symbol",
          ref: { capability: "types", entity: entity.name, shape: "row" },
        });

        // Import insert type if insert function is generated
        if (entity.permissions.canInsert) {
          const insertShape = entity.shapes.insert ?? entity.shapes.row;
          // Only import if it's a different type than row
          if (insertShape !== entity.shapes.row) {
            file.import({
              kind: "symbol",
              ref: { capability: "types", entity: entity.name, shape: "insert" },
            });
          }
        }

        // Import types needed by function args (for functions grouped into this file)
        if (entityFunctions.length > 0) {
          const fnTypeImports = collectFunctionTypeImports(entityFunctions, ctx.ir);
          // Remove the entity's own type (already in scope)
          fnTypeImports.delete(entity.name);
          // TODO: Import these types when symbol registry supports it
        }

        file.ast(conjure.program(...statements)).emit();
      });

    // Generate files for composite types that have functions returning them
    if (generateFunctions) {
      const composites = getCompositeEntities(ctx.ir);
      for (const composite of composites) {
        const compositeFunctions = functionsByEntity.get(composite.name) ?? [];
        if (compositeFunctions.length === 0) continue;

        const filePath = `${config.outputDir}/${composite.name}.ts`;
        const statements = compositeFunctions.map(fn =>
          generateFunctionWrapper(fn, ctx.ir, sqlStyle)
        );

        const file = ctx.file(filePath);

        // Import the appropriate SQL client based on style
        if (sqlStyle === "tag") {
          file.import({ kind: "relative", names: ["sql"], from: "../db" });
        } else {
          file.import({ kind: "relative", names: ["pool"], from: "../db" });
        }

        // Import the composite type and any types needed by function args
        const fnTypeImports = collectFunctionTypeImports(compositeFunctions, ctx.ir);
        fnTypeImports.add(composite.name); // Always import the composite type
        // TODO: Import these types when symbol registry supports it

        file.ast(conjure.program(...statements)).emit();
      }
    }

    // Generate functions.ts for scalar-returning functions only
    if (generateFunctions && scalarFunctions.length > 0) {
      const filePath = `${config.outputDir}/${config.functionsFile}`;

      const statements = scalarFunctions.map(fn =>
        generateFunctionWrapper(fn, ctx.ir, sqlStyle)
      );

      const file = ctx.file(filePath);

      // Import the appropriate SQL client based on style
      if (sqlStyle === "tag") {
        file.import({ kind: "relative", names: ["sql"], from: "../db" });
      } else {
        file.import({ kind: "relative", names: ["pool"], from: "../db" });
      }

      // Import types needed by function args
      const fnTypeImports = collectFunctionTypeImports(scalarFunctions, ctx.ir);
      // TODO: Import these types when symbol registry supports it

      file.ast(conjure.program(...statements)).emit();
    }
  },
});

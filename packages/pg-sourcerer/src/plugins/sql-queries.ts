/**
 * SQL Queries Provider - Generate raw SQL query functions using template strings
 */
import { Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";
import { definePlugin, type PluginContext } from "../services/plugin.js";
import type {
  Field,
  IndexDef,
  TableEntity,
  EnumEntity,
  SemanticIR,
  Relation,
  FunctionEntity,
  FunctionArg,
  CompositeEntity,
} from "../ir/semantic-ir.js";
import {
  getTableEntities,
  getEnumEntities,
  getFunctionEntities,
  getCompositeEntities,
} from "../ir/semantic-ir.js";
import { conjure, cast } from "../lib/conjure.js";
import { hex, type SqlStyle, type QueryParts } from "../lib/hex.js";
import { resolveFieldType, tsTypeToAst } from "../lib/field-utils.js";
import { inflect } from "../services/inflection.js";
import {
  type QueryMethod,
} from "../ir/extensions/queries.js";

const { ts, b, param, asyncFn } = conjure;

// ============================================================================
// Configuration
// ============================================================================

/**
 * Function to generate export names for CRUD/lookup methods.
 * @param entityName - PascalCase entity name (e.g., "User", "Post")
 * @param methodName - PascalCase method name (e.g., "FindById", "Insert")
 * @returns The export name (e.g., "findUserById", "insertPost")
 */
export type ExportNameFn = (entityName: string, methodName: string) => string;

/** Default export name: camelCase of methodName + entityName (e.g., "findUserById") */
const defaultExportName: ExportNameFn = (entityName, methodName) => {
  // methodName is like "FindById", "Insert", "GetByUsername"
  // We want: findUserById, insertUser, getUserByUsername
  const camelMethod = methodName.charAt(0).toLowerCase() + methodName.slice(1);
  // Insert entity name after the verb (find, insert, get, delete)
  // Pattern: verb + Entity + rest (e.g., find + User + ById)
  const verbMatch = camelMethod.match(/^(find|insert|delete|get)(.*)$/);
  if (verbMatch) {
    const [, verb, rest] = verbMatch;
    return `${verb}${entityName}${rest}`;
  }
  // Fallback: just prepend entity
  return `${camelMethod}${entityName}`;
};

const SqlQueriesPluginConfigSchema = S.Struct({
  outputDir: S.optionalWith(S.String, { default: () => "sql-queries" }),
  /**
   * Header content to prepend to each generated file.
   * Must include the SQL client import (e.g., `import { sql } from "../db"`).
   */
  header: S.String,
  /** SQL query style. Defaults to "tag" (tagged template literals) */
  sqlStyle: S.optionalWith(S.Union(S.Literal("tag"), S.Literal("string")), {
    default: () => "tag" as const,
  }),
  /**
   * Use explicit column lists instead of SELECT *.
   * When true, generates "SELECT col1, col2" which excludes omitted fields at runtime.
   * Defaults to true.
   */
  explicitColumns: S.optionalWith(S.Boolean, { default: () => true }),
  /** Generate wrappers for PostgreSQL functions. Defaults to true. */
  generateFunctions: S.optionalWith(S.Boolean, { default: () => true }),
  /** Output file for scalar-returning functions. Defaults to "functions.ts". */
  functionsFile: S.optionalWith(S.String, { default: () => "functions.ts" }),
  /** Export name function - use S.Any for schema, properly typed after resolution */
  exportName: S.optional(S.Any),
  /**
   * Export style for generated query functions.
   * - "flat": Individual exports (e.g., `export async function findById() {...}`)
   * - "namespace": Single object export (e.g., `export const User = { findById: ... }`)
   */
  exportStyle: S.optionalWith(S.Literal("flat", "namespace"), { default: () => "flat" as const }),
});

type SqlQueriesPluginConfigBase = S.Schema.Type<typeof SqlQueriesPluginConfigSchema>;

/** Resolved config with properly typed exportName function */
interface SqlQueriesPluginConfig extends Omit<SqlQueriesPluginConfigBase, "exportName"> {
  readonly exportName: ExportNameFn;
}

// ============================================================================
// Context & Type Helpers
// ============================================================================

/**
 * A generated method definition (name + function declaration + metadata).
 * Used to support both flat exports and namespace object exports,
 * and to emit QueryArtifact for downstream plugins.
 */
interface MethodDef {
  readonly name: string;
  readonly fn: n.FunctionDeclaration;
  /** Metadata for QueryArtifact emission */
  readonly meta: QueryMethod;
}

interface GenerationContext {
  readonly entity: TableEntity;
  readonly enums: readonly EnumEntity[];
  readonly ir: SemanticIR;
  readonly sqlStyle: SqlStyle;
  /** PascalCase entity name for export naming */
  readonly entityName: string;
  /** Function to generate export names */
  readonly exportName: ExportNameFn;
  /** Use explicit column lists instead of SELECT * */
  readonly explicitColumns: boolean;
}

/** Find a field in the row shape by column name */
const findRowField = (entity: TableEntity, columnName: string): Field | undefined =>
  entity.shapes.row.fields.find(f => f.columnName === columnName);

/** Build comma-separated column list from row shape fields */
const buildColumnList = (entity: TableEntity): string =>
  entity.shapes.row.fields.map(f => f.columnName).join(", ");

/** Build SELECT clause - explicit columns or * based on config */
const buildSelectClause = (entity: TableEntity, explicitColumns: boolean): string =>
  explicitColumns ? `select ${buildColumnList(entity)}` : "select *";

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
const findRelationForColumn = (entity: TableEntity, columnName: string): Relation | undefined =>
  entity.relations.find(
    r => r.kind === "belongsTo" && r.columns.length === 1 && r.columns[0]?.local === columnName,
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

/** Get TypeScript type string for a field */
const getFieldTypeString = (field: Field | undefined, ctx: GenerationContext): string => {
  if (!field) return "string";
  const resolved = resolveFieldType(field, ctx.enums, ctx.ir.extensions);
  return resolved.enumDef ? resolved.enumDef.name : resolved.tsType;
};

/** Generate findById method if entity has a primary key and canSelect permission */
const generateFindById = (ctx: GenerationContext): MethodDef | undefined => {
  const { entity, sqlStyle, entityName, exportName, explicitColumns } = ctx;
  if (!entity.primaryKey || !entity.permissions.canSelect) return undefined;

  const pkColName = entity.primaryKey.columns[0]!;
  const pkField = findRowField(entity, pkColName);
  if (!pkField) return undefined;

  const rowType = entity.shapes.row.name;
  const fieldName = pkField.name; // JS property name (e.g., "id")
  const selectClause = buildSelectClause(entity, explicitColumns);

  const parts: QueryParts = {
    templateParts: [
      `${selectClause} from ${entity.schemaName}.${entity.pgName} where ${pkColName} = `,
      "",
    ],
    params: [b.identifier(fieldName)],
  };

  // Build query and extract first row
  const queryExpr = hex.query(sqlStyle, parts, ts.array(ts.ref(rowType)));
  const varDecl = hex.firstRowDecl(sqlStyle, "result", queryExpr);

  const name = exportName(entityName, "FindById");
  const fn = asyncFn(
    name,
    [param.pick([fieldName], rowType)],
    [varDecl, b.returnStatement(b.identifier("result"))],
  );

  const meta: QueryMethod = {
    name,
    kind: "read",
    params: [
      {
        name: fieldName,
        type: getFieldTypeString(pkField, ctx),
        required: true,
        columnName: pkColName,
        source: "pk",
      },
    ],
    returns: { type: rowType, nullable: true, isArray: false },
    callSignature: { style: "named" },
  };

  return { name, fn, meta };
};

/** Generate findMany method with pagination if entity has canSelect permission */
const generateFindMany = (ctx: GenerationContext): MethodDef | undefined => {
  const { entity, sqlStyle, entityName, exportName, explicitColumns } = ctx;
  if (!entity.permissions.canSelect) return undefined;

  const rowType = entity.shapes.row.name;
  const selectClause = buildSelectClause(entity, explicitColumns);

  const parts: QueryParts = {
    templateParts: [
      `${selectClause} from ${entity.schemaName}.${entity.pgName} limit `,
      ` offset `,
      "",
    ],
    params: [b.identifier("limit"), b.identifier("offset")],
  };

  const name = exportName(entityName, "FindManys");
  const fn = asyncFn(
    name,
    [
      param.destructured([
        { name: "limit", type: ts.number(), optional: true, defaultValue: b.numericLiteral(50) },
        { name: "offset", type: ts.number(), optional: true, defaultValue: b.numericLiteral(0) },
      ]),
    ],
    hex.returnQuery(sqlStyle, parts, ts.array(ts.ref(rowType))),
  );

  const meta: QueryMethod = {
    name,
    kind: "list",
    params: [
      { name: "limit", type: "number", required: false, source: "pagination" },
      { name: "offset", type: "number", required: false, source: "pagination" },
    ],
    returns: { type: rowType, nullable: false, isArray: true },
    callSignature: { style: "named" },
  };

  return { name, fn, meta };
};

/** Generate delete method if entity has a primary key and canDelete permission */
const generateDelete = (ctx: GenerationContext): MethodDef | undefined => {
  const { entity, sqlStyle, entityName, exportName } = ctx;
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
  const name = exportName(entityName, "Delete");
  const fn = asyncFn(name, [param.pick([fieldName], rowType)], [b.expressionStatement(queryExpr)]);

  const meta: QueryMethod = {
    name,
    kind: "delete",
    params: [
      {
        name: fieldName,
        type: getFieldTypeString(pkField, ctx),
        required: true,
        columnName: pkColName,
        source: "pk",
      },
    ],
    returns: { type: "void", nullable: false, isArray: false },
    callSignature: { style: "named" },
  };

  return { name, fn, meta };
};

/** Generate insert method if entity has canInsert permission */
const generateInsert = (ctx: GenerationContext): MethodDef | undefined => {
  const { entity, sqlStyle, entityName, exportName } = ctx;
  if (!entity.permissions.canInsert) return undefined;

  // Use insert shape if available, otherwise fall back to row
  const insertShape = entity.shapes.insert ?? entity.shapes.row;
  const rowType = entity.shapes.row.name;
  const insertType = insertShape.name;

  // Build column list and values from insertable fields
  const insertableFields = insertShape.fields.filter(f => f.permissions.canInsert);
  if (insertableFields.length === 0) return undefined;

  const columnNames = insertableFields.map(f => f.columnName);

  // Build: insert into schema.table (col1, col2) values ($field1, $field2) returning *
  const columnList = columnNames.join(", ");
  const valuePlaceholders = insertableFields.map((_, i) => (i === 0 ? "" : ", "));

  // For optional fields (nullable or has default), use DEFAULT when undefined
  // Required fields use the value directly
  const paramExprs = insertableFields.map(f => {
    const isOptional = f.optional || f.nullable;
    return isOptional ? hex.defaultIfUndefined(f.name) : b.identifier(f.name);
  });

  // Template parts: "insert into ... values (" + "" + ", " + ", " + ... + ") returning *"
  const parts: QueryParts = {
    templateParts: [
      `insert into ${entity.schemaName}.${entity.pgName} (${columnList}) values (`,
      ...valuePlaceholders.slice(1),
      `) returning *`,
    ],
    params: paramExprs,
  };

  const queryExpr = hex.query(sqlStyle, parts, ts.array(ts.ref(rowType)));
  const varDecl = hex.firstRowDecl(sqlStyle, "result", queryExpr);

  // Destructured parameter - use Pick from insert type
  const fieldNames = insertableFields.map(f => f.name);
  const dataParam = param.pick(fieldNames, insertType);

  const name = exportName(entityName, "Insert");
  const fn = asyncFn(name, [dataParam], [varDecl, b.returnStatement(b.identifier("result"))]);

  const meta: QueryMethod = {
    name,
    kind: "create",
    params: [
      {
        name: "data",
        type: insertType,
        required: true,
        source: "body",
      },
    ],
    returns: { type: rowType, nullable: false, isArray: false },
    callSignature: { style: "named", bodyStyle: "spread" },
  };

  return { name, fn, meta };
};

/** Generate all CRUD methods for an entity */
const generateCrudMethods = (ctx: GenerationContext): readonly MethodDef[] =>
  [generateFindById(ctx), generateFindMany(ctx), generateInsert(ctx), generateDelete(ctx)].filter(
    (m): m is MethodDef => m != null,
  );

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
 * Generate the method name portion for an index-based lookup.
 * Returns PascalCase like "GetByUsername" or "GetsByUser" for use with exportName.
 */
const generateLookupMethodName = (
  index: IndexDef,
  relation: Relation | undefined,
  columnName: string,
): string => {
  const isUnique = index.isUnique || index.isPrimary;
  const prefix = isUnique ? "GetBy" : "GetsBy";

  // Use semantic name if FK relation exists, otherwise fall back to column name
  const byName = relation ? deriveSemanticName(relation, columnName) : index.columns[0]!;

  return `${prefix}${toPascalCase(byName)}`;
};

/**
 * Generate a lookup method for a single-column index.
 * Uses semantic parameter naming when the column corresponds to an FK relation.
 */
const generateLookupMethod = (index: IndexDef, ctx: GenerationContext): MethodDef => {
  const { entity, sqlStyle, entityName, exportName, explicitColumns } = ctx;
  const rowType = entity.shapes.row.name;
  const columnName = index.columnNames[0]!;
  const field = findRowField(entity, columnName);
  const fieldName = field?.name ?? index.columns[0]!;
  const isUnique = index.isUnique || index.isPrimary;

  // Check if this index column corresponds to an FK relation
  const relation = findRelationForColumn(entity, columnName);

  // Use semantic param name if FK relation exists, otherwise use field name
  const paramName = relation ? deriveSemanticName(relation, columnName) : fieldName;

  // For semantic naming, use indexed access type (Post["userId"])
  // For regular naming, use Pick<Post, "fieldName">
  const useSemanticNaming = relation !== undefined && paramName !== fieldName;
  const selectClause = buildSelectClause(entity, explicitColumns);

  const parts: QueryParts = {
    templateParts: [
      `${selectClause} from ${entity.schemaName}.${entity.pgName} where ${columnName} = `,
      "",
    ],
    params: [b.identifier(paramName)],
  };

  const methodName = generateLookupMethodName(index, relation, columnName);
  const name = exportName(entityName, methodName);

  // Build the parameter - use destructured style for both cases
  // Lookup params must be non-nullable (you're searching FOR a value, not handling null)
  // Semantic naming: { user }: { user: NonNullable<Post["user_id"]> }
  // Regular naming: { fieldName }: { fieldName: NonNullable<Post["fieldName"]> }
  const indexedType = ts.indexedAccess(ts.ref(rowType), ts.literal(fieldName));
  const paramType = ts.ref("NonNullable", [indexedType]);
  const paramNode = param.destructured([{ name: paramName, type: paramType }]);

  // Build metadata for the lookup method
  const meta: QueryMethod = {
    name,
    kind: "lookup",
    params: [
      {
        name: paramName,
        type: getFieldTypeString(field, ctx),
        required: true,
        columnName,
        source: relation ? "fk" : "lookup",
      },
    ],
    returns: {
      type: rowType,
      nullable: isUnique,
      isArray: !isUnique,
    },
    lookupField: fieldName,
    isUniqueLookup: isUnique,
    callSignature: { style: "named" },
  };

  if (isUnique) {
    // Extract first row for unique lookups
    const queryExpr = hex.query(sqlStyle, parts, ts.array(ts.ref(rowType)));
    const varDecl = hex.firstRowDecl(sqlStyle, "result", queryExpr);

    const fn = asyncFn(name, [paramNode], [varDecl, b.returnStatement(b.identifier("result"))]);

    return { name, fn, meta };
  }

  // Non-unique: return all matching rows
  const fn = asyncFn(
    name,
    [paramNode],
    hex.returnQuery(sqlStyle, parts, ts.array(ts.ref(rowType))),
  );

  return { name, fn, meta };
};

/** Generate lookup methods for all eligible indexes, deduplicating by name */
const generateLookupMethods = (ctx: GenerationContext): readonly MethodDef[] => {
  const seen = new Set<string>();

  return ctx.entity.indexes
    .filter(index => shouldGenerateLookup(index) && !index.isPrimary)
    .filter(index => {
      const columnName = index.columnNames[0]!;
      const relation = findRelationForColumn(ctx.entity, columnName);
      const methodName = generateLookupMethodName(index, relation, columnName);
      const name = ctx.exportName(ctx.entityName, methodName);
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    })
    .map(index => generateLookupMethod(index, ctx));
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
const getGeneratableFunctions = (
  ir: SemanticIR,
): {
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
  const scalarBase = baseTypeName.includes(".") ? baseTypeName.split(".").pop()! : baseTypeName;
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
const getFunctionQualifiedName = (fn: FunctionEntity): string => `${fn.schemaName}.${fn.pgName}`;

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
): MethodDef => {
  const resolvedReturn = resolveReturnType(fn, ir);
  const resolvedArgs = resolveArgs(fn, ir);
  const qualifiedName = getFunctionQualifiedName(fn);

  // Use fn.name which is already inflected by the IR builder
  const name = fn.name;

  // Helper to convert resolved type string to AST
  const typeStrToAst = (typeStr: string): n.TSType => {
    if (typeStr.endsWith("[]")) {
      const elemType = typeStr.slice(0, -2);
      return ts.array(typeStrToAst(elemType));
    }
    switch (typeStr) {
      case "string":
        return ts.string();
      case "number":
        return ts.number();
      case "boolean":
        return ts.boolean();
      case "void":
        return ts.void();
      case "unknown":
        return ts.unknown();
      case "Date":
        return ts.ref("Date");
      case "Buffer":
        return ts.ref("Buffer");
      default:
        return ts.ref(typeStr);
    }
  };

  // Build parameter: destructured object for named style (zero-arg functions have no params)
  const params: (n.Identifier | n.ObjectPattern)[] =
    resolvedArgs.length === 0
      ? []
      : [
          param.destructured(
            resolvedArgs.map(arg => ({
              name: arg.name,
              type: typeStrToAst(arg.tsType),
              optional: arg.isOptional,
            })),
          ),
        ];

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
      true,
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

  const fnDecl = asyncFn(name, params, body);

  // Build metadata for the function wrapper
  const meta: QueryMethod = {
    name,
    kind: "function",
    params: resolvedArgs.map(arg => ({
      name: arg.name,
      type: arg.tsType,
      required: !arg.isOptional,
    })),
    returns: {
      type: resolvedReturn.tsType,
      nullable: resolvedReturn.isScalar || !resolvedReturn.isArray, // Scalars and single rows can be null
      isArray: resolvedReturn.isArray,
    },
    callSignature: { style: "named" },
  };

  return { name, fn: fnDecl, meta };
};

/**
 * Collect type imports needed for function wrappers.
 */
const collectFunctionTypeImports = (
  functions: readonly FunctionEntity[],
  ir: SemanticIR,
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
// Export Style Helpers
// ============================================================================

/**
 * Convert MethodDef array to flat export statements.
 * Each method becomes: export function methodName(...) { ... }
 */
const toFlatExports = (methods: readonly MethodDef[]): n.Statement[] =>
  methods.map(m => conjure.export.fn(m.fn));

/**
 * Convert a FunctionDeclaration to a FunctionExpression for object property use.
 */
const fnDeclToExpr = (fn: n.FunctionDeclaration): n.FunctionExpression => {
  const expr = b.functionExpression(null, fn.params, fn.body as n.BlockStatement);
  expr.async = fn.async;
  expr.generator = fn.generator;
  return expr;
};

/**
 * Convert MethodDef array to a single namespace object export.
 * All methods become: export const EntityName = { methodName: async function(...) { ... }, ... }
 */
const toNamespaceExport = (entityName: string, methods: readonly MethodDef[]): n.Statement => {
  const properties = methods.map(m => b.objectProperty(b.identifier(m.name), fnDeclToExpr(m.fn)));
  const obj = b.objectExpression(properties);
  return conjure.export.const(entityName, obj);
};

/**
 * Convert MethodDef array to statements based on export style.
 */
const toStatements = (
  methods: readonly MethodDef[],
  exportStyle: "flat" | "namespace",
  entityName: string,
): n.Statement[] => {
  if (methods.length === 0) return [];
  return exportStyle === "namespace"
    ? [toNamespaceExport(entityName, methods)]
    : toFlatExports(methods);
};

// ============================================================================
// Provider Definition
// ============================================================================

/**
 * Configuration for the SQL queries provider
 */
export interface SqlQueriesConfig {
  readonly outputDir?: string;
  /**
   * Header content to prepend to each generated file.
   * Must include the SQL client import (e.g., `import { sql } from "../db"`).
   */
  readonly header: string;
  /** SQL query style. Defaults to "tag" (tagged template literals) */
  readonly sqlStyle?: "tag" | "string";
  /**
   * Use explicit column lists instead of SELECT *.
   * When true, generates "SELECT col1, col2" which excludes omitted fields at runtime.
   * Defaults to true.
   */
  readonly explicitColumns?: boolean;
  /** Generate wrappers for PostgreSQL functions. Defaults to true. */
  readonly generateFunctions?: boolean;
  /** Output file for scalar-returning functions. Defaults to "functions.ts". */
  readonly functionsFile?: string;
  /** Export name function */
  readonly exportName?: ExportNameFn;
  /**
   * Export style for generated query functions.
   * - "flat": Individual exports (e.g., `export async function findById() {...}`)
   * - "namespace": Single object export (e.g., `export const User = { findById: ... }`)
   */
  readonly exportStyle?: "flat" | "namespace";
}

/**
 * Create a SQL queries provider that generates raw SQL query functions.
 *
 * @example
 * ```typescript
 * import { sqlQueries } from "pg-sourcerer"
 *
 * export default defineConfig({
 *   plugins: [
 *     types(),
 *     sqlQueries({ header: 'import { sql } from "../db"' }),
 *   ],
 * })
 * ```
 */
export function sqlQueries(config: SqlQueriesConfig): ReturnType<typeof definePlugin> {
  const parsed = S.decodeUnknownSync(SqlQueriesPluginConfigSchema)(config);

  // Resolve config with properly typed exportName
  const resolvedConfig: SqlQueriesPluginConfig = {
    ...parsed,
    exportName: config.exportName ?? defaultExportName,
  };

  return definePlugin({
    name: "sql-queries",
    kind: "queries",
    singleton: true,

    canProvide: () => true,

    provide: (_params: unknown, _deps: readonly unknown[], ctx: PluginContext): void => {
      const { ir, inflection } = ctx;
      const enums = getEnumEntities(ir);
      const {
        sqlStyle,
        generateFunctions,
        exportName,
        exportStyle,
        outputDir,
        header,
        functionsFile,
        explicitColumns,
      } = resolvedConfig;

      // Pre-compute function groupings by return entity name
      // Functions returning entities go in that entity's file; scalars go in functions.ts
      const functionsByEntity = new Map<string, FunctionEntity[]>();
      const scalarFunctions: FunctionEntity[] = [];

      if (generateFunctions) {
        const { queries, mutations } = getGeneratableFunctions(ir);
        const allFunctions = [...queries, ...mutations];

        for (const fn of allFunctions) {
          const resolved = resolveReturnType(fn, ir);
          if (resolved.returnEntity) {
            const entityName = resolved.returnEntity.name;
            const existing = functionsByEntity.get(entityName) ?? [];
            functionsByEntity.set(entityName, [...existing, fn]);
          } else {
            scalarFunctions.push(fn);
          }
        }
      }

      getTableEntities(ir)
        .filter(entity => entity.tags.omit !== true)
        .forEach(entity => {
          const entityName = inflection.entityName(entity.pgClass, entity.tags);
          const genCtx: GenerationContext = {
            entity,
            enums,
            ir,
            sqlStyle,
            entityName,
            exportName,
            explicitColumns,
          };

          // Generate CRUD and lookup methods
          const crudMethods = [...generateCrudMethods(genCtx), ...generateLookupMethods(genCtx)];

          // Get functions that return this entity
          const entityFunctions = functionsByEntity.get(entity.name) ?? [];

          if (crudMethods.length === 0 && entityFunctions.length === 0) return;

          const filePath = `${outputDir}/${entityName}.ts`;

          // Convert methods to statements based on export style
          const statements: n.Statement[] = toStatements(crudMethods, exportStyle, entityName);

          // Add function wrappers (these are always flat exports for now)
          for (const fn of entityFunctions) {
            const wrapper = generateFunctionWrapper(fn, ir, sqlStyle);
            statements.push(conjure.export.fn(wrapper.fn));
          }

          const file = ctx.file(filePath);

          // Add user-provided header (must include SQL client import)
          file.header(header);

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
            const fnTypeImports = collectFunctionTypeImports(entityFunctions, ir);
            // Remove the entity's own type (already in scope)
            fnTypeImports.delete(entity.name);
            for (const typeName of fnTypeImports) {
              file.import({
                kind: "symbol",
                ref: { capability: "types", entity: typeName },
              });
            }
          }

          file.ast(conjure.program(...statements)).emit();

          // Collect metadata for QueryArtifact
          const pkField = entity.primaryKey?.columns[0]
            ? findRowField(entity, entity.primaryKey.columns[0])
            : undefined;
          const pkType = pkField ? getFieldTypeString(pkField, genCtx) : undefined;

          // Combine CRUD method metadata with entity-function metadata
          const allMethodMetas = [
            ...crudMethods.map(m => m.meta),
            ...entityFunctions.map(fn => generateFunctionWrapper(fn, ir, sqlStyle).meta),
          ];

          // Register entity methods to symbol registry for HTTP providers
          ctx.symbols.registerEntityMethods(
            {
              entity: entityName,
              importPath: filePath,
              pkType,
              hasCompositePk: (entity.primaryKey?.columns.length ?? 0) > 1,
              methods: allMethodMetas.map(m => ({
                name: m.name,
                file: filePath,
                entity: entityName,
                kind: m.kind,
                params: m.params,
                returns: m.returns,
                lookupField: m.lookupField,
                isUniqueLookup: m.isUniqueLookup,
                callSignature: m.callSignature,
              })),
            },
            "sql-queries",
          );
        });

      // Generate files for composite types that have functions returning them
      if (generateFunctions) {
        const composites = getCompositeEntities(ir);
        for (const composite of composites) {
          const compositeFunctions = functionsByEntity.get(composite.name) ?? [];
          if (compositeFunctions.length === 0) continue;

          const filePath = `${outputDir}/${composite.name}.ts`;
          const methods = compositeFunctions.map(fn => generateFunctionWrapper(fn, ir, sqlStyle));
          // Function wrappers are always flat exports
          const statements = methods.map(m => conjure.export.fn(m.fn));

          const file = ctx.file(filePath);

          // Add user-provided header (must include SQL client import)
          file.header(header);

          // Import the composite type and any types needed by function args
          const fnTypeImports = collectFunctionTypeImports(compositeFunctions, ir);
          fnTypeImports.add(composite.name); // Always import the composite type
          for (const typeName of fnTypeImports) {
            file.import({
              kind: "symbol",
              ref: { capability: "types", entity: typeName },
            });
          }

          file.ast(conjure.program(...statements)).emit();
        }
      }

      // Generate functions.ts for scalar-returning functions only
      if (generateFunctions && scalarFunctions.length > 0) {
        const filePath = `${outputDir}/${functionsFile}`;

        const methods = scalarFunctions.map(fn => generateFunctionWrapper(fn, ir, sqlStyle));
        // Function wrappers are always flat exports
        const statements = methods.map(m => conjure.export.fn(m.fn));

        const file = ctx.file(filePath);

        // Add user-provided header (must include SQL client import)
        file.header(header);

        // Import types needed by function args
        const fnTypeImports = collectFunctionTypeImports(scalarFunctions, ir);
        for (const typeName of fnTypeImports) {
          file.import({
            kind: "symbol",
            ref: { capability: "types", entity: typeName },
          });
        }

        file.ast(conjure.program(...statements)).emit();

        // TODO: Register standalone functions to symbol registry when HTTP plugins need them
        // For now, standalone functions are not exposed via routes
      }
    },
  });
}

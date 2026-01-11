// @ts-nocheck - TODO: migrate to new plugin API
/**
 * Kysely Queries Generation
 *
 * Generates permission-aware CRUD query functions using Kysely's query builder.
 * Uses object namespace style with explicit `db: Kysely<DB>` first parameter.
 */
import { Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";
import type { SimplePluginContext } from "../../services/plugin.js";
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
} from "../../ir/semantic-ir.js";
import {
  getTableEntities,
  getEnumEntities,
  getFunctionEntities,
  getCompositeEntities,
} from "../../ir/semantic-ir.js";

import { conjure, cast } from "../../lib/conjure.js";
import { resolveFieldType, tsTypeToAst } from "../../lib/field-utils.js";
import { inflect } from "../../services/inflection.js";
import { pgTypeNameToTs } from "./shared.js";

const { ts, b, param, str } = conjure;
const { toExpr } = cast;

// ============================================================================
// Query Artifact Schema (plugin-defined)
// ============================================================================
// This schema defines what kysely-queries emits as its artifact.
// HTTP plugins consuming "queries:kysely" should decode using a compatible schema.

/** How to call a query function */
const CallSignature = S.Struct({
  /** "named" = fn({ a, b }), "positional" = fn(a, b) */
  style: S.Union(S.Literal("named"), S.Literal("positional")),
  /** For named + body: "property" = { data: body }, "spread" = { field1, field2 } */
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
// Configuration
// ============================================================================

/**
 * Function to generate export names for CRUD/lookup methods.
 * @param entityName - PascalCase entity name (e.g., "User", "Post")
 * @param methodName - PascalCase method name (e.g., "FindById", "Create")
 * @returns The export name (e.g., "UserFindById", "userCreate", "findById")
 */
export type ExportNameFn = (entityName: string, methodName: string) => string;

/** Default export name: camelCase method name (e.g., "findById") */
const defaultExportName: ExportNameFn = (_entityName, methodName) =>
  methodName.charAt(0).toLowerCase() + methodName.slice(1);

/**
 * Schema for serializable config options (JSON/YAML compatible).
 * Function options are typed separately in KyselyQueriesConfigInput.
 */
const KyselyQueriesPluginConfigSchema = S.Struct({
  outputDir: S.optionalWith(S.String, { default: () => "kysely-queries" }),
  /**
   * Path to import DB type from (relative to outputDir).
   * Defaults to "../db.js" which works with kysely-types plugin output.
   * For node16/nodenext module resolution, use ".js" extension even for .ts files.
   */
  dbTypesPath: S.optionalWith(S.String, { default: () => "../db.js" }),
  /**
   * Whether to call .execute() / .executeTakeFirst() on queries.
   * When true (default), methods return Promise<Row> or Promise<Row[]>.
   * When false, methods return the query builder for further customization.
   */
  executeQueries: S.optionalWith(S.Boolean, { default: () => true }),
  /**
   * Whether to generate listMany() method for unfiltered table scans.
   * Disabled by default since unfiltered scans don't use indexes.
   * When enabled, generates: listMany(db, limit = 50, offset = 0)
   */
  generateListMany: S.optionalWith(S.Boolean, { default: () => false }),
  /**
   * Whether to generate function wrappers for stored functions.
   * When true (default), generates queries/mutations namespaces in functions.ts.
   */
  generateFunctions: S.optionalWith(S.Boolean, { default: () => true }),
  /**
   * Output file name for function wrappers (relative to outputDir).
   */
  functionsFile: S.optionalWith(S.String, { default: () => "functions.ts" }),
  /**
   * Export name function (validated as Any, properly typed in KyselyQueriesConfigInput)
   */
  exportName: S.optional(S.Any),
  /**
   * Export style for generated query functions.
   * - "flat": Individual exports (e.g., `export const findById = ...`)
   * - "namespace": Single object export (e.g., `export const User = { findById: ... }`)
   */
  exportStyle: S.optionalWith(S.Literal("flat", "namespace"), { default: () => "flat" as const }),
  /**
   * Use explicit column lists instead of .selectAll().
   * When true, generates .select(['col1', 'col2']) which excludes omitted fields at runtime.
   * Defaults to true.
   */
  explicitColumns: S.optionalWith(S.Boolean, { default: () => true }),
  /**
   * Whether to pass db as first parameter to each function.
   * When true (default), functions take `db: Kysely<DB>` as first arg.
   * When false, functions use a module-level `db` variable - use `header`
   * to provide the import statement.
   */
  dbAsParameter: S.optionalWith(S.Boolean, { default: () => true }),
  /**
   * Header content to prepend to each generated file.
   * Use this to provide imports when dbAsParameter is false.
   * Example: `import { db } from "../db.js"`
   */
  header: S.optional(S.String),
  /**
   * Default limit for listMany queries.
   * @default 50
   */
  defaultLimit: S.optionalWith(S.Number, { default: () => 50 }),
});

type KyselyQueriesPluginConfigSchema = S.Schema.Type<typeof KyselyQueriesPluginConfigSchema>;

/**
 * User-facing config input with properly typed function options.
 */
export interface KyselyQueriesConfigInput {
  readonly outputDir?: string;
  readonly dbTypesPath?: string;
  readonly executeQueries?: boolean;
  readonly generateListMany?: boolean;
  readonly generateFunctions?: boolean;
  readonly functionsFile?: string;
  /**
   * Custom export name function for CRUD/lookup methods.
   * @default (_entityName, methodName) => camelCase(methodName)
   * @example
   * // PascalCase prefix: "UserFindById", "UserCreate"
   * exportName: (entity, method) => entity + method
   *
   * // camelCase prefix: "userFindById", "userCreate"
   * exportName: (entity, method) => entity.toLowerCase() + method
   */
  readonly exportName?: ExportNameFn;
  /**
   * Export style for generated query functions.
   * - "flat": Individual exports (e.g., `export const findById = ...`)
   * - "namespace": Single object export (e.g., `export const User = { findById: ... }`)
   * @default "flat"
   */
  readonly exportStyle?: "flat" | "namespace";
  /**
   * Use explicit column lists instead of .selectAll().
   * When true, generates .select(['col1', 'col2']) which excludes omitted fields at runtime.
   * @default true
   */
  readonly explicitColumns?: boolean;
  /**
   * Whether to pass db as first parameter to each function.
   * When true (default), functions take `db: Kysely<DB>` as first arg.
   * When false, functions use a module-level `db` variable - use `header`
   * to provide the import statement.
   * @default true
   */
  readonly dbAsParameter?: boolean;
  /**
   * Header content to prepend to each generated file.
   * Use this to provide imports when dbAsParameter is false.
   * Example: `import { db } from "../db.js"`
   */
  readonly header?: string;
  /**
   * Default limit for listMany queries.
   * @default 50
   */
  readonly defaultLimit?: number;
}

/**
 * Resolved config with defaults applied
 */
interface KyselyQueriesPluginConfig extends KyselyQueriesPluginConfigSchema {
  readonly exportName: ExportNameFn;
}

/**
 * Configuration for Kysely queries generation (exported for unified plugin).
 * All fields are required; the caller applies defaults.
 */
export interface KyselyQueriesConfig {
  readonly outputDir: string;
  readonly dbTypesPath: string;
  readonly executeQueries: boolean;
  readonly generateListMany: boolean;
  readonly generateFunctions: boolean;
  readonly functionsFile: string;
  readonly exportName: ExportNameFn;
  readonly exportStyle: "flat" | "namespace";
  readonly explicitColumns: boolean;
  readonly dbAsParameter: boolean;
  readonly header?: string;
  readonly defaultLimit: number;
}

/** Default config values for queries */
const defaultQueriesConfig: Omit<KyselyQueriesConfig, "exportName" | "header"> = {
  outputDir: "kysely-queries",
  dbTypesPath: "../db.js",
  executeQueries: true,
  generateListMany: false,
  generateFunctions: true,
  functionsFile: "functions.ts",
  exportStyle: "flat",
  explicitColumns: true,
  dbAsParameter: true,
  defaultLimit: 50,
};

// ============================================================================
// Context & Type Helpers
// ============================================================================

interface GenerationContext {
  readonly entity: TableEntity;
  readonly enums: readonly EnumEntity[];
  readonly ir: SemanticIR;
  readonly defaultSchemas: readonly string[];
  readonly dbTypesPath: string;
  readonly executeQueries: boolean;
  readonly generateListMany: boolean;
  /** PascalCase entity name for export naming */
  readonly entityName: string;
  /** Function to generate export names */
  readonly exportName: ExportNameFn;
  /** Use explicit column lists instead of .selectAll() */
  readonly explicitColumns: boolean;
  /** Whether to include db as first parameter */
  readonly dbAsParameter: boolean;
  /** Default limit for listMany queries */
  readonly defaultLimit: number;
}

/**
 * A generated method definition (name + arrow function + metadata).
 * Used to support both flat exports and namespace object exports,
 * and to emit QueryArtifact for downstream plugins.
 */
interface MethodDef {
  readonly name: string;
  readonly fn: n.ArrowFunctionExpression;
  /** Metadata for QueryArtifact emission */
  readonly meta: QueryMethod;
}

/**
 * Get the Kysely table interface name from the entity.
 * Uses entity.name which is already PascalCase from inflection (e.g., Users).
 */
const getTableTypeName = (entity: TableEntity): string => entity.name;

/**
 * Get the table reference for Kysely queries.
 * Uses schema-qualified name only if the schema is NOT in defaultSchemas.
 * This matches the keys in the DB interface from kysely-types plugin.
 */
const getTableRef = (entity: TableEntity, defaultSchemas: readonly string[]): string =>
  defaultSchemas.includes(entity.schemaName)
    ? entity.pgName
    : `${entity.schemaName}.${entity.pgName}`;

/** Find a field in the row shape by column name */
const findRowField = (entity: TableEntity, columnName: string): Field | undefined =>
  entity.shapes.row.fields.find(f => f.columnName === columnName);

/** Get the TypeScript type AST for a field */
const getFieldTypeAst = (field: Field | undefined, ctx: GenerationContext): n.TSType => {
  if (!field) return ts.string();
  const resolved = resolveFieldType(field, ctx.enums, ctx.ir.extensions);
  return resolved.enumDef ? ts.ref(resolved.enumDef.name) : tsTypeToAst(resolved.tsType);
};

/** Get TypeScript type string for a field */
const getFieldTypeString = (field: Field | undefined, ctx: GenerationContext): string => {
  if (!field) return "string";
  const resolved = resolveFieldType(field, ctx.enums, ctx.ir.extensions);
  return resolved.enumDef ? resolved.enumDef.name : resolved.tsType;
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
 * Convert to PascalCase for use in method names.
 * Handles snake_case (created_at → CreatedAt) and regular strings.
 */
const toPascalCase = (s: string): string => inflect.pascalCase(s);

// ============================================================================
// AST Building Helpers
// ============================================================================

/** Create identifier */
const id = (name: string): n.Identifier => b.identifier(name);

/** Create method call: obj.method(args) */
const call = (obj: n.Expression, method: string, args: n.Expression[] = []): n.CallExpression =>
  b.callExpression(b.memberExpression(toExpr(obj), id(method)), args.map(toExpr));

/**
 * Build Kysely query chain starting with db.selectFrom('table')
 */
const selectFrom = (tableRef: string): n.CallExpression =>
  call(id("db"), "selectFrom", [str(tableRef)]);

/**
 * Build column selection: .selectAll() or .select(['col1', 'col2'])
 * When explicitColumns is true, uses explicit column list from row shape.
 */
const selectColumns = (
  base: n.Expression,
  entity: TableEntity,
  explicitColumns: boolean,
): n.CallExpression =>
  explicitColumns
    ? call(base, "select", [
        b.arrayExpression(entity.shapes.row.fields.map(f => str(f.columnName))),
      ])
    : call(base, "selectAll");

/**
 * Build Kysely query chain: db.insertInto('table')
 */
const insertInto = (tableRef: string): n.CallExpression =>
  call(id("db"), "insertInto", [str(tableRef)]);

/**
 * Build Kysely query chain: db.updateTable('table')
 */
const updateTable = (tableRef: string): n.CallExpression =>
  call(id("db"), "updateTable", [str(tableRef)]);

/**
 * Build Kysely query chain: db.deleteFrom('table')
 */
const deleteFrom = (tableRef: string): n.CallExpression =>
  call(id("db"), "deleteFrom", [str(tableRef)]);

/**
 * Chain method call onto existing expression
 */
const chain = (expr: n.Expression, method: string, args: n.Expression[] = []): n.CallExpression =>
  call(expr, method, args);

/** Arrow function parameter - identifier, assignment pattern (for defaults), or object pattern (destructuring) */
type ArrowParam = n.Identifier | n.AssignmentPattern | n.ObjectPattern;

/**
 * Build arrow function expression: (params) => body
 */
const arrowFn = (params: ArrowParam[], body: n.Expression): n.ArrowFunctionExpression => {
  const fn = b.arrowFunctionExpression(
    params.map(p => p as Parameters<typeof b.arrowFunctionExpression>[0][0]),
    toExpr(body),
  );
  return fn;
};

/**
 * Build object property: key: value
 */
const objProp = (key: string, value: n.Expression): n.ObjectProperty => {
  const prop = b.objectProperty(id(key), toExpr(value));
  return prop;
};

// ============================================================================
// PostgreSQL Type Name to TypeScript Mapping
// ============================================================================

// ============================================================================
// Function Filtering & Categorization
// ============================================================================

/**
 * Context for function generation - extends the table context with function-specific data
 */
interface FunctionGenContext {
  readonly ir: SemanticIR;
  readonly enums: readonly EnumEntity[];
  readonly defaultSchemas: readonly string[];
  readonly dbTypesPath: string;
  readonly executeQueries: boolean;
}

/**
 * Check if a function argument type matches a table/view entity (row type argument).
 * Functions with row-type arguments are computed fields (e.g., posts_short_body(posts))
 * and should be excluded from function wrapper generation.
 */
const hasRowTypeArg = (arg: FunctionArg, ir: SemanticIR): boolean => {
  const tableEntities = getTableEntities(ir);
  // Check if arg.typeName matches a table entity's qualified name
  // Format: "schema.tablename" or just "tablename" for public schema
  return tableEntities.some(entity => {
    const qualifiedName = `${entity.schemaName}.${entity.pgName}`;
    return arg.typeName === qualifiedName || arg.typeName === entity.pgName;
  });
};

/**
 * Check if a function should be included in generated wrappers.
 *
 * Includes functions that:
 * - Have canExecute permission
 * - Are not trigger functions
 * - Are not from extensions
 * - Are not @omit tagged
 * - Don't have row-type arguments (computed fields)
 */
const isGeneratableFunction = (fn: FunctionEntity, ir: SemanticIR): boolean => {
  if (!fn.canExecute) return false;
  if (fn.returnTypeName === "trigger") return false;
  if (fn.isFromExtension) return false;
  if (fn.tags.omit === true) return false;
  // Check for row-type args (computed field pattern)
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

// ============================================================================
// Function Return Type Resolution
// ============================================================================

/**
 * Resolved return type information for function wrappers.
 */
interface ResolvedReturnType {
  /** TypeScript type string (e.g., "string", "boolean", "Users", "TagSearchResult") */
  readonly tsType: string;
  /** True for SETOF returns (returns multiple rows) */
  readonly isArray: boolean;
  /** True for scalar types (primitives like string, number, boolean) */
  readonly isScalar: boolean;
  /** Type name to import from DB types file, if needed */
  readonly needsImport?: string;
  /** The entity this return type references (for grouping into entity files) */
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
  // Handle "schema.typename" format by extracting just the type name
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

// ============================================================================
// Function Argument Type Resolution
// ============================================================================

/**
 * Resolved argument information for function wrappers.
 */
interface ResolvedArg {
  /** Parameter name (camelCase) */
  readonly name: string;
  /** TypeScript type string */
  readonly tsType: string;
  /** True if argument has a default value */
  readonly isOptional: boolean;
  /** Type name to import from DB types file, if needed */
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
  // Handle "schema.typename" format
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

// ============================================================================
// Function Wrapper AST Generation
// ============================================================================

/**
 * Generate a typed parameter with explicit type annotation from type string.
 */
const typedParamFromString = (name: string, typeStr: string): n.Identifier =>
  param.typed(name, ts.fromString(typeStr));

/**
 * Get the fully qualified function name for use in eb.fn call.
 */
const getFunctionQualifiedName = (fn: FunctionEntity): string => `${fn.schemaName}.${fn.pgName}`;

/**
 * Generate a function wrapper method.
 *
 * Patterns:
 * - SETOF/table return: db.selectFrom(eb => eb.fn<Type>(...).as('f')).selectAll().execute()
 * - Single row return: db.selectFrom(eb => eb.fn<Type>(...).as('f')).selectAll().executeTakeFirst()
 * - Scalar return: db.selectNoFrom(eb => eb.fn<Type>(...).as('result')).executeTakeFirst().then(r => r?.result)
 */
const generateFunctionWrapper = (
  fn: FunctionEntity,
  ir: SemanticIR,
  executeQueries: boolean,
  dbAsParameter: boolean,
): MethodDef => {
  const resolvedReturn = resolveReturnType(fn, ir);
  const resolvedArgs = resolveArgs(fn, ir);
  const qualifiedName = getFunctionQualifiedName(fn);

  // Build eb.val(arg) for each argument
  const fnArgs = resolvedArgs.map(arg => call(id("eb"), "val", [id(arg.name)]));

  // Build eb.fn<Type>('schema.fn_name', [args]).as('alias')
  // The type parameter is the return type
  const returnTypeAst = resolvedReturn.isScalar
    ? (typedParamFromString("_", resolvedReturn.tsType).typeAnnotation!.typeAnnotation as n.TSType)
    : ts.ref(resolvedReturn.tsType);

  // Create eb.fn with type parameter: eb.fn<Type>
  const fnMember = b.memberExpression(id("eb"), id("fn"));
  const fnWithType = b.tsInstantiationExpression(
    fnMember,
    b.tsTypeParameterInstantiation([cast.toTSType(returnTypeAst)]),
  );

  // Call it: eb.fn<Type>(name, args)
  const fnCallBase = b.callExpression(fnWithType, [
    str(qualifiedName),
    b.arrayExpression(fnArgs.map(toExpr)),
  ]);

  // .as('f') or .as('result') for scalar
  const alias = resolvedReturn.isScalar ? "result" : "f";
  const fnCallWithAlias = call(fnCallBase, "as", [str(alias)]);

  // Arrow function for selectFrom callback: eb => eb.fn<...>(...).as('f')
  const selectCallback = arrowFn([id("eb")], fnCallWithAlias);

  // Build the query chain
  let query: n.Expression;

  if (resolvedReturn.isScalar) {
    // Scalar: db.selectNoFrom(eb => ...).executeTakeFirst()
    // Returns { result: T } | undefined - caller accesses .result
    query = call(id("db"), "selectNoFrom", [selectCallback]);

    if (executeQueries) {
      query = chain(query, "executeTakeFirst");
    }
  } else {
    // Table/composite: db.selectFrom(eb => ...).selectAll()
    query = chain(call(id("db"), "selectFrom", [selectCallback]), "selectAll");

    if (executeQueries) {
      // SETOF → .execute(), single row → .executeTakeFirst()
      query = chain(query, resolvedReturn.isArray ? "execute" : "executeTakeFirst");
    }
  }

  // Build the parameters using destructured object pattern
  // When dbAsParameter is true: ({ arg1, arg2 }: { arg1: Type1; arg2?: Type2 }, db: Kysely<DB>) => ...
  // When dbAsParameter is false: ({ arg1, arg2 }: { arg1: Type1; arg2?: Type2 }) => ...
  const params: ArrowParam[] = [];

  // Add destructured options param if there are any args
  if (resolvedArgs.length > 0) {
    const optionsParam = param.destructured(
      resolvedArgs.map(arg => ({
        name: arg.name,
        type: ts.fromString(arg.tsType),
        optional: arg.isOptional,
      })),
    );
    params.push(optionsParam);
  }

  // Add db param last if enabled
  if (dbAsParameter) {
    params.push(param.typed("db", ts.ref("Kysely", [ts.ref("DB")])));
  }

  const wrapperFn = arrowFn(params, query);

  // Build metadata for QueryArtifact
  const meta: QueryMethod = {
    name: fn.name,
    kind: "function",
    params: resolvedArgs.map(arg => ({
      name: arg.name,
      type: arg.tsType,
      required: !arg.isOptional,
    })),
    returns: {
      type: resolvedReturn.tsType,
      nullable: resolvedReturn.isScalar || !resolvedReturn.isArray,
      isArray: resolvedReturn.isArray,
    },
    callSignature: { style: "named" },
  };

  return { name: fn.name, fn: wrapperFn, meta };
};

/**
 * Collect all type imports needed for function wrappers.
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
// CRUD Method Generators
// ============================================================================

/**
 * Generate findById method if entity has a primary key and canSelect permission:
 * export const findById = ({ id }: { id: number }, db: Kysely<DB>) => db.selectFrom('table').select([...]).where('id', '=', id).executeTakeFirst()
 */
const generateFindById = (ctx: GenerationContext): MethodDef | undefined => {
  const {
    entity,
    executeQueries,
    defaultSchemas,
    entityName,
    exportName,
    explicitColumns,
    dbAsParameter,
  } = ctx;
  if (!entity.primaryKey || !entity.permissions.canSelect) return undefined;

  const pkColName = entity.primaryKey.columns[0]!;
  const pkField = findRowField(entity, pkColName);
  if (!pkField) return undefined;

  const tableRef = getTableRef(entity, defaultSchemas);
  const fieldName = pkField.name;
  const fieldType = getFieldTypeAst(pkField, ctx);

  // db.selectFrom('table').select([...]).where('col', '=', id)
  let query: n.Expression = chain(
    selectColumns(selectFrom(tableRef), entity, explicitColumns),
    "where",
    [str(pkColName), str("="), id(fieldName)],
  );

  if (executeQueries) {
    query = chain(query, "executeTakeFirst");
  }

  // Destructured param: { id }: { id: number }
  const optionsParam = param.destructured([{ name: fieldName, type: fieldType }]);
  const dbParam = param.typed("db", ts.ref("Kysely", [ts.ref("DB")]));

  // Options first, db last
  const params = dbAsParameter ? [optionsParam, dbParam] : [optionsParam];

  const fn = arrowFn(params, query);

  const name = exportName(entityName, "FindById");
  const rowType = entity.shapes.row.name;
  const meta: QueryMethod = {
    name,
    kind: "read",
    params: [{
      name: fieldName,
      type: getFieldTypeString(pkField, ctx),
      required: true,
      columnName: pkColName,
      source: "pk",
    }],
    returns: { type: rowType, nullable: true, isArray: false },
    callSignature: { style: "named" },
  };

  return { name, fn, meta };
};

/** Default offset for findMany queries */
const DEFAULT_OFFSET = 0;

/**
 * Generate listMany method with pagination defaults:
 * export const listMany = ({ limit = 50, offset = 0 }: { limit?: number; offset?: number }, db: Kysely<DB>) => ...
 */
const generateListMany = (ctx: GenerationContext): MethodDef | undefined => {
  const {
    entity,
    executeQueries,
    defaultSchemas,
    entityName,
    exportName,
    explicitColumns,
    dbAsParameter,
    defaultLimit,
  } = ctx;
  if (!entity.permissions.canSelect) return undefined;

  const tableRef = getTableRef(entity, defaultSchemas);

  // Build query: db.selectFrom('table').select([...]).limit(limit).offset(offset)
  let query: n.Expression = chain(
    chain(selectColumns(selectFrom(tableRef), entity, explicitColumns), "limit", [id("limit")]),
    "offset",
    [id("offset")],
  );

  // Add .execute() if executeQueries is true
  if (executeQueries) {
    query = chain(query, "execute");
  }

  // Destructured param with defaults: { limit = 50, offset = 0 }: { limit?: number; offset?: number }
  const optionsParam = param.destructured([
    {
      name: "limit",
      type: ts.number(),
      optional: true,
      defaultValue: b.numericLiteral(defaultLimit),
    },
    {
      name: "offset",
      type: ts.number(),
      optional: true,
      defaultValue: b.numericLiteral(DEFAULT_OFFSET),
    },
  ]);
  const dbParam = param.typed("db", ts.ref("Kysely", [ts.ref("DB")]));

  const params = dbAsParameter ? [optionsParam, dbParam] : [optionsParam];

  const fn = arrowFn(params, query);

  const name = exportName(entityName, "ListMany");
  const rowType = entity.shapes.row.name;
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

/**
 * Generate create method:
 * export const create = ({ data }: { data: Insertable<Users> }, db: Kysely<DB>) => ...
 */
const generateCreate = (ctx: GenerationContext): MethodDef | undefined => {
  const { entity, executeQueries, defaultSchemas, entityName, exportName, dbAsParameter } = ctx;
  if (!entity.permissions.canInsert) return undefined;

  const tableRef = getTableRef(entity, defaultSchemas);
  const tableTypeName = getTableTypeName(entity);

  // db.insertInto('table').values(data).returningAll()
  let query: n.Expression = chain(
    chain(insertInto(tableRef), "values", [id("data")]),
    "returningAll",
  );

  if (executeQueries) {
    query = chain(query, "executeTakeFirstOrThrow");
  }

  // Destructured param: { data }: { data: Insertable<Users> }
  const optionsParam = param.destructured([
    { name: "data", type: ts.ref("Insertable", [ts.ref(tableTypeName)]) },
  ]);
  const dbParam = param.typed("db", ts.ref("Kysely", [ts.ref("DB")]));

  const params = dbAsParameter ? [optionsParam, dbParam] : [optionsParam];

  const fn = arrowFn(params, query);

  const name = exportName(entityName, "Create");
  const rowType = entity.shapes.row.name;
  const insertType = `Insertable<${tableTypeName}>`;
  const meta: QueryMethod = {
    name,
    kind: "create",
    params: [{
      name: "data",
      type: insertType,
      required: true,
      source: "body",
    }],
    returns: { type: rowType, nullable: false, isArray: false },
    callSignature: { style: "named", bodyStyle: "property" },
  };

  return { name, fn, meta };
};

/**
 * Generate update method:
 * export const update = ({ id, data }: { id: number; data: Updateable<Users> }, db: Kysely<DB>) => ...
 */
const generateUpdate = (ctx: GenerationContext): MethodDef | undefined => {
  const { entity, executeQueries, defaultSchemas, entityName, exportName, dbAsParameter } = ctx;
  if (!entity.primaryKey || !entity.permissions.canUpdate) return undefined;

  const pkColName = entity.primaryKey.columns[0]!;
  const pkField = findRowField(entity, pkColName);
  if (!pkField) return undefined;

  const tableRef = getTableRef(entity, defaultSchemas);
  const fieldName = pkField.name;
  const fieldType = getFieldTypeAst(pkField, ctx);
  const tableTypeName = getTableTypeName(entity);

  // db.updateTable('table').set(data).where('id', '=', id).returningAll()
  let query: n.Expression = chain(
    chain(chain(updateTable(tableRef), "set", [id("data")]), "where", [
      str(pkColName),
      str("="),
      id(fieldName),
    ]),
    "returningAll",
  );

  if (executeQueries) {
    query = chain(query, "executeTakeFirstOrThrow");
  }

  // Destructured param: { id, data }: { id: number; data: Updateable<Users> }
  const optionsParam = param.destructured([
    { name: fieldName, type: fieldType },
    { name: "data", type: ts.ref("Updateable", [ts.ref(tableTypeName)]) },
  ]);
  const dbParam = param.typed("db", ts.ref("Kysely", [ts.ref("DB")]));

  const params = dbAsParameter ? [optionsParam, dbParam] : [optionsParam];

  const fn = arrowFn(params, query);

  const name = exportName(entityName, "Update");
  const rowType = entity.shapes.row.name;
  const updateType = `Updateable<${tableTypeName}>`;
  const meta: QueryMethod = {
    name,
    kind: "update",
    params: [
      {
        name: fieldName,
        type: getFieldTypeString(pkField, ctx),
        required: true,
        columnName: pkColName,
        source: "pk",
      },
      {
        name: "data",
        type: updateType,
        required: true,
        source: "body",
      },
    ],
    returns: { type: rowType, nullable: false, isArray: false },
    callSignature: { style: "named", bodyStyle: "property" },
  };

  return { name, fn, meta };
};

/**
 * Generate delete method:
 * export const remove = ({ id }: { id: number }, db: Kysely<DB>) => ...
 */
const generateDelete = (ctx: GenerationContext): MethodDef | undefined => {
  const { entity, executeQueries, defaultSchemas, entityName, exportName, dbAsParameter } = ctx;
  if (!entity.primaryKey || !entity.permissions.canDelete) return undefined;

  const pkColName = entity.primaryKey.columns[0]!;
  const pkField = findRowField(entity, pkColName);
  if (!pkField) return undefined;

  const tableRef = getTableRef(entity, defaultSchemas);
  const fieldName = pkField.name;
  const fieldType = getFieldTypeAst(pkField, ctx);

  // db.deleteFrom('table').where('id', '=', id)
  let query: n.Expression = chain(deleteFrom(tableRef), "where", [
    str(pkColName),
    str("="),
    id(fieldName),
  ]);

  if (executeQueries) {
    query = chain(query, "execute");
  }

  // Destructured param: { id }: { id: number }
  const optionsParam = param.destructured([{ name: fieldName, type: fieldType }]);
  const dbParam = param.typed("db", ts.ref("Kysely", [ts.ref("DB")]));

  const params = dbAsParameter ? [optionsParam, dbParam] : [optionsParam];

  const fn = arrowFn(params, query);

  const name = exportName(entityName, "Remove");
  const meta: QueryMethod = {
    name,
    kind: "delete",
    params: [{
      name: fieldName,
      type: getFieldTypeString(pkField, ctx),
      required: true,
      columnName: pkColName,
      source: "pk",
    }],
    returns: { type: "void", nullable: false, isArray: false },
    callSignature: { style: "named" },
  };

  return { name, fn, meta };
};

/** Generate all CRUD methods for an entity */
const generateCrudMethods = (ctx: GenerationContext): readonly MethodDef[] =>
  [
    generateFindById(ctx),
    ctx.generateListMany ? generateListMany(ctx) : undefined,
    generateCreate(ctx),
    generateUpdate(ctx),
    generateDelete(ctx),
  ].filter((p): p is MethodDef => p != null);

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
 * Uses semantic naming when the column corresponds to an FK relation.
 */
const generateLookupMethodName = (
  entity: TableEntity,
  index: IndexDef,
  relation: Relation | undefined,
): string => {
  // Use semantic name if FK relation exists, otherwise fall back to column name
  const columnName = index.columnNames[0]!;
  const byName = relation ? deriveSemanticName(relation, columnName) : index.columns[0]!;

  return `FindBy${toPascalCase(byName)}`;
};

/**
 * Generate a lookup method for a single-column index.
 * Uses semantic parameter naming when the column corresponds to an FK relation.
 */
const generateLookupMethod = (index: IndexDef, ctx: GenerationContext): MethodDef => {
  const {
    entity,
    executeQueries,
    defaultSchemas,
    entityName,
    exportName,
    explicitColumns,
    dbAsParameter,
  } = ctx;
  const tableRef = getTableRef(entity, defaultSchemas);
  const columnName = index.columnNames[0]!;
  const field = findRowField(entity, columnName);
  const fieldName = field?.name ?? index.columns[0]!;
  const isUnique = isUniqueLookup(entity, index);

  // Check if this index column corresponds to an FK relation
  const relation = findRelationForColumn(entity, columnName);

  // Use semantic param name if FK relation exists, otherwise use field name
  const paramName = relation ? deriveSemanticName(relation, columnName) : fieldName;

  // For FK columns, use indexed access on Selectable<TableType> to get the unwrapped type
  // (Kysely's Generated<T> types need Selectable to unwrap for use in where clauses)
  // For regular columns, use the field's type directly
  // Both cases wrap in NonNullable since lookups require a concrete value
  const useSemanticNaming = relation !== undefined && paramName !== fieldName;
  const tableTypeName = getTableTypeName(entity);
  const selectableType = ts.ref("Selectable", [ts.ref(tableTypeName)]);
  const indexedType = ts.indexedAccess(selectableType, ts.literal(fieldName));
  // Lookup params must be non-nullable (you're searching FOR a value, not handling null)
  const paramType = ts.ref("NonNullable", [
    useSemanticNaming ? indexedType : getFieldTypeAst(field, ctx),
  ]);

  // db.selectFrom('table').select([...]).where('col', '=', value)
  let query: n.Expression = chain(
    selectColumns(selectFrom(tableRef), entity, explicitColumns),
    "where",
    [str(columnName), str("="), id(paramName)],
  );

  if (executeQueries) {
    query = chain(query, isUnique ? "executeTakeFirst" : "execute");
  }

  // Destructured param: { author }: { author: Selectable<Posts>["authorId"] }
  const optionsParam = param.destructured([{ name: paramName, type: paramType }]);
  const dbParam = param.typed("db", ts.ref("Kysely", [ts.ref("DB")]));

  const params = dbAsParameter ? [optionsParam, dbParam] : [optionsParam];

  const fn = arrowFn(params, query);

  const methodName = generateLookupMethodName(entity, index, relation);
  const name = exportName(entityName, methodName);
  const rowType = entity.shapes.row.name;

  const meta: QueryMethod = {
    name,
    kind: "lookup",
    params: [{
      name: paramName,
      type: getFieldTypeString(field, ctx),
      required: true,
      columnName,
      source: relation ? "fk" : "lookup",
    }],
    returns: {
      type: rowType,
      nullable: isUnique,
      isArray: !isUnique,
    },
    lookupField: fieldName,
    isUniqueLookup: isUnique,
    callSignature: { style: "named" },
  };

  return { name, fn, meta };
};

/**
 * Check if a column is covered by a unique constraint (not just unique index).
 * This helps determine if a non-unique B-tree index on the column still
 * returns at most one row.
 */
const columnHasUniqueConstraint = (entity: TableEntity, columnName: string): boolean => {
  const constraints = entity.pgClass.getConstraints();
  return constraints.some(c => {
    // 'u' = unique constraint, 'p' = primary key
    if (c.contype !== "u" && c.contype !== "p") return false;
    // Single-column constraint on our column?
    const conkey = c.conkey ?? [];
    if (conkey.length !== 1) return false;
    // Find the attribute with this attnum
    const attrs = entity.pgClass.getAttributes();
    const attr = attrs.find(a => a.attnum === conkey[0]);
    return attr?.attname === columnName;
  });
};

/**
 * Determine if a lookup should be treated as unique (returns one row).
 * True if: index is unique, index is primary, OR column has unique constraint.
 */
const isUniqueLookup = (entity: TableEntity, index: IndexDef): boolean => {
  if (index.isUnique || index.isPrimary) return true;
  // Check if the single column has a unique constraint
  const columnName = index.columnNames[0];
  return columnName ? columnHasUniqueConstraint(entity, columnName) : false;
};

/** Generate lookup methods for all eligible indexes, deduplicating by column */
const generateLookupMethods = (ctx: GenerationContext): readonly MethodDef[] => {
  const eligibleIndexes = ctx.entity.indexes.filter(
    index => shouldGenerateLookup(index) && !index.isPrimary && ctx.entity.permissions.canSelect,
  );

  // Group by column name, keeping only one index per column
  // Prefer unique indexes, but also consider columns with unique constraints
  const byColumn = new Map<string, IndexDef>();
  for (const index of eligibleIndexes) {
    const columnName = index.columnNames[0]!;
    const existing = byColumn.get(columnName);
    if (!existing) {
      byColumn.set(columnName, index);
    } else {
      // Prefer explicitly unique index over non-unique
      if (index.isUnique && !existing.isUnique) {
        byColumn.set(columnName, index);
      }
    }
  }

  return Array.from(byColumn.values()).map(index => generateLookupMethod(index, ctx));
};

// ============================================================================
// Export Style Helpers
// ============================================================================

/**
 * Convert MethodDef array to flat export statements.
 * Each method becomes: export const methodName = (db, ...) => ...
 */
const toFlatExports = (methods: readonly MethodDef[]): n.Statement[] =>
  methods.map(m => conjure.export.const(m.name, m.fn));

/**
 * Convert MethodDef array to a single namespace object export.
 * All methods become: export const EntityName = { methodName: (db, ...) => ..., ... }
 */
const toNamespaceExport = (entityName: string, methods: readonly MethodDef[]): n.Statement => {
  const properties = methods.map(m => b.objectProperty(id(m.name), m.fn));
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
// Core Generation Function
// ============================================================================

/**
 * Generate Kysely query functions from the IR.
 *
 * This is the core generation logic, extracted for use by both:
 * - The standalone kyselyQueriesPlugin
 * - The unified kyselyPlugin
 *
 * @param ctx - Plugin context for file emission and services
 * @param config - Queries configuration (with defaults applied)
 */
export function generateKyselyQueries(
  ctx: SimplePluginContext,
  config: Partial<KyselyQueriesConfig> = {}
): void {
  // Apply defaults
  const resolvedConfig: KyselyQueriesConfig = {
    ...defaultQueriesConfig,
    exportName: defaultExportName,
    ...config,
  };

  const enums = getEnumEntities(ctx.ir);
  const defaultSchemas = ctx.ir.schemas;
  const {
    outputDir,
    dbTypesPath,
    executeQueries,
    generateListMany,
    generateFunctions,
    functionsFile,
    exportName,
    exportStyle,
    explicitColumns,
    dbAsParameter,
    header,
    defaultLimit,
  } = resolvedConfig;

  // Collectors for QueryArtifact emission
  const entityMethodsCollector: EntityQueryMethods[] = [];
  const functionMethodsCollector: FunctionQueryMethod[] = [];

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
      const entityName = ctx.inflection.entityName(entity.pgClass, entity.tags);
      const genCtx: GenerationContext = {
        entity,
        enums,
        ir: ctx.ir,
        defaultSchemas,
        dbTypesPath,
        executeQueries,
        generateListMany,
        entityName,
        exportName,
        explicitColumns,
        dbAsParameter,
        defaultLimit,
      };

      // Collect all methods for this entity
      const methods: MethodDef[] = [
        ...generateCrudMethods(genCtx),
        ...generateLookupMethods(genCtx),
      ];

      // Get functions that return this entity
      const entityFunctions = functionsByEntity.get(entity.name) ?? [];
      for (const fn of entityFunctions) {
        methods.push(generateFunctionWrapper(fn, ctx.ir, executeQueries, dbAsParameter));
      }

      if (methods.length === 0) return;

      // Use inline file naming: ${entityName}.ts
      const filePath = `${outputDir}/${entityName}.ts`;

      // Convert methods to statements based on export style
      const statements = toStatements(methods, exportStyle, entityName);

      const file = ctx.file(filePath);

      // Add user-provided header if specified
      if (header) {
        file.header(header);
      }

      // Import Kysely type only when db is passed as parameter
      if (dbAsParameter) {
        file.import({ kind: "package", types: ["Kysely"], from: "kysely" });
        file.import({ kind: "relative", types: ["DB"], from: dbTypesPath });
      }

      // Import Insertable/Updateable helper types and table type if we generate create/update
      const tableTypeName = getTableTypeName(entity);

      // Check if any lookup methods use semantic naming (FK with Selectable indexed access)
      const hasSemanticLookups = entity.indexes.some(index => {
        if (!shouldGenerateLookup(index) || index.isPrimary) return false;
        const columnName = index.columnNames[0]!;
        const relation = findRelationForColumn(entity, columnName);
        if (!relation) return false;
        const paramName = deriveSemanticName(relation, columnName);
        const field = findRowField(entity, columnName);
        const fieldName = field?.name ?? index.columns[0]!;
        return paramName !== fieldName;
      });

      // Import table type if needed for Insertable/Updateable or semantic lookups
      const needsTableType =
        entity.permissions.canInsert || entity.permissions.canUpdate || hasSemanticLookups;
      if (needsTableType) {
        file.import({ kind: "relative", types: [tableTypeName], from: dbTypesPath });
      }

      // Import Selectable if we have semantic lookups (for unwrapping Generated<T>)
      if (hasSemanticLookups) {
        file.import({ kind: "package", types: ["Selectable"], from: "kysely" });
      }

      if (entity.permissions.canInsert) {
        file.import({ kind: "package", types: ["Insertable"], from: "kysely" });
      }
      if (entity.permissions.canUpdate) {
        file.import({ kind: "package", types: ["Updateable"], from: "kysely" });
      }

      // Import types needed by function args (for functions grouped into this file)
      if (entityFunctions.length > 0) {
        const fnTypeImports = collectFunctionTypeImports(entityFunctions, ctx.ir);
        // Remove the entity's own type (already in scope or self-referential)
        fnTypeImports.delete(entity.name);
        if (fnTypeImports.size > 0) {
          file.import({ kind: "relative", types: [...fnTypeImports], from: dbTypesPath });
        }
      }

      file.ast(conjure.program(...statements)).emit();

      // Collect metadata for QueryArtifact
      const pkField = entity.primaryKey?.columns[0]
        ? findRowField(entity, entity.primaryKey.columns[0])
        : undefined;
      const pkType = pkField ? getFieldTypeString(pkField, genCtx) : undefined;

      entityMethodsCollector.push({
        entityName,
        tableName: entity.pgName,
        schemaName: entity.schemaName,
        pkType,
        hasCompositePk: (entity.primaryKey?.columns.length ?? 0) > 1,
        methods: methods.map(m => m.meta),
      });
    });

  // Generate files for composite types that have functions returning them
  if (generateFunctions) {
    const composites = getCompositeEntities(ctx.ir);
    for (const composite of composites) {
      const compositeFunctions = functionsByEntity.get(composite.name) ?? [];
      if (compositeFunctions.length === 0) continue;

      const filePath = `${outputDir}/${composite.name}.ts`;
      const methods = compositeFunctions.map(fn =>
        generateFunctionWrapper(fn, ctx.ir, executeQueries, dbAsParameter),
      );
      const statements = toStatements(methods, exportStyle, composite.name);

      const file = ctx.file(filePath);

      // Add user-provided header if specified
      if (header) {
        file.header(header);
      }

      // Import Kysely type only when db is passed as parameter
      if (dbAsParameter) {
        file.import({ kind: "package", types: ["Kysely"], from: "kysely" });
        file.import({ kind: "relative", types: ["DB"], from: dbTypesPath });
      }

      // Import the composite type and any types needed by function args
      const fnTypeImports = collectFunctionTypeImports(compositeFunctions, ctx.ir);
      fnTypeImports.add(composite.name); // Always import the composite type
      file.import({ kind: "relative", types: [...fnTypeImports], from: dbTypesPath });

      file.ast(conjure.program(...statements)).emit();
    }
  }

  // Generate functions.ts for scalar-returning functions only
  if (generateFunctions && scalarFunctions.length > 0) {
    const filePath = `${outputDir}/${functionsFile}`;

    const methods = scalarFunctions.map(fn =>
      generateFunctionWrapper(fn, ctx.ir, executeQueries, dbAsParameter),
    );
    // For scalar functions, use "functions" as the namespace name
    const statements = toStatements(methods, exportStyle, "functions");

    const file = ctx.file(filePath);

    // Add user-provided header if specified
    if (header) {
      file.header(header);
    }

    // Import Kysely type only when db is passed as parameter
    if (dbAsParameter) {
      file.import({ kind: "package", types: ["Kysely"], from: "kysely" });
      file.import({ kind: "relative", types: ["DB"], from: dbTypesPath });
    }

    // Import any types needed for function args (scalars don't need return type imports)
    const typeImports = collectFunctionTypeImports(scalarFunctions, ctx.ir);
    if (typeImports.size > 0) {
      file.import({ kind: "relative", types: [...typeImports], from: dbTypesPath });
    }

    file.ast(conjure.program(...statements)).emit();

    // Collect scalar function metadata for QueryArtifact
    for (const fn of scalarFunctions) {
      const resolvedArgs = resolveArgs(fn, ctx.ir);
      const resolvedReturn = resolveReturnType(fn, ctx.ir);

      functionMethodsCollector.push({
        functionName: fn.pgName,
        exportName: fn.name,
        schemaName: fn.schemaName,
        volatility: fn.volatility,
        params: resolvedArgs.map(arg => ({
          name: arg.name,
          type: arg.tsType,
          required: !arg.isOptional,
        })),
        returns: {
          type: resolvedReturn.tsType,
          nullable: resolvedReturn.isScalar || !resolvedReturn.isArray,
          isArray: resolvedReturn.isArray,
        },
        callSignature: { style: "named" },
      });
    }
  }

  // Emit the QueryArtifact for downstream plugins (e.g., http-elysia)
  const artifact: QueryArtifact = {
    entities: entityMethodsCollector,
    functions: functionMethodsCollector,
    sourcePlugin: "kysely-queries",
    outputDir,
  };
  ctx.setArtifact("queries:kysely", artifact);
}


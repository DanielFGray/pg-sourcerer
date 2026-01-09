/**
 * Kysely Queries Plugin - Generate type-safe Kysely query functions
 *
 * Generates permission-aware CRUD query functions using Kysely's query builder.
 * Uses object namespace style with explicit `db: Kysely<DB>` first parameter.
 */
import { Schema as S } from "effect"
import type { namedTypes as n } from "ast-types"
import { definePlugin } from "../services/plugin.js"
import type { FileNameContext } from "../services/plugin.js"
import type { Field, IndexDef, TableEntity, EnumEntity, SemanticIR, Relation, FunctionEntity, FunctionArg, CompositeEntity } from "../ir/semantic-ir.js"
import { getTableEntities, getEnumEntities, getFunctionEntities, getCompositeEntities } from "../ir/semantic-ir.js"

import { conjure, cast } from "../lib/conjure.js"
import { resolveFieldType, tsTypeToAst } from "../lib/field-utils.js"
import { inflect } from "../services/inflection.js"

const { ts, b } = conjure
const { toExpr } = cast

// ============================================================================
// Configuration
// ============================================================================

/**
 * Function to generate export names for CRUD/lookup methods.
 * @param entityName - PascalCase entity name (e.g., "User", "Post")
 * @param methodName - PascalCase method name (e.g., "FindById", "Create")
 * @returns The export name (e.g., "UserFindById", "userCreate", "findById")
 */
export type ExportNameFn = (entityName: string, methodName: string) => string

/** Default export name: camelCase method name (e.g., "findById") */
const defaultExportName: ExportNameFn = (_entityName, methodName) => 
  methodName.charAt(0).toLowerCase() + methodName.slice(1)

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
})

type KyselyQueriesPluginConfigSchema = S.Schema.Type<typeof KyselyQueriesPluginConfigSchema>

/**
 * User-facing config input with properly typed function options.
 */
export interface KyselyQueriesConfigInput {
  readonly outputDir?: string
  readonly dbTypesPath?: string
  readonly executeQueries?: boolean
  readonly generateListMany?: boolean
  readonly generateFunctions?: boolean
  readonly functionsFile?: string
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
  readonly exportName?: ExportNameFn
  /**
   * Export style for generated query functions.
   * - "flat": Individual exports (e.g., `export const findById = ...`)
   * - "namespace": Single object export (e.g., `export const User = { findById: ... }`)
   * @default "flat"
   */
  readonly exportStyle?: "flat" | "namespace"
}

/**
 * Resolved config with defaults applied
 */
interface KyselyQueriesPluginConfig extends KyselyQueriesPluginConfigSchema {
  readonly exportName: ExportNameFn
}

// ============================================================================
// Context & Type Helpers
// ============================================================================

interface GenerationContext {
  readonly entity: TableEntity
  readonly enums: readonly EnumEntity[]
  readonly ir: SemanticIR
  readonly defaultSchemas: readonly string[]
  readonly dbTypesPath: string
  readonly executeQueries: boolean
  readonly generateListMany: boolean
  /** PascalCase entity name for export naming */
  readonly entityName: string
  /** Function to generate export names */
  readonly exportName: ExportNameFn
}

/**
 * A generated method definition (name + arrow function).
 * Used to support both flat exports and namespace object exports.
 */
interface MethodDef {
  readonly name: string
  readonly fn: n.ArrowFunctionExpression
}

/**
 * Get the Kysely table interface name from the entity.
 * Uses entity.name which is already PascalCase from inflection (e.g., Users).
 */
const getTableTypeName = (entity: TableEntity): string => entity.name

/** 
 * Get the table reference for Kysely queries.
 * Uses schema-qualified name only if the schema is NOT in defaultSchemas.
 * This matches the keys in the DB interface from kysely-types plugin.
 */
const getTableRef = (entity: TableEntity, defaultSchemas: readonly string[]): string =>
  defaultSchemas.includes(entity.schemaName)
    ? entity.pgName
    : `${entity.schemaName}.${entity.pgName}`

/** Find a field in the row shape by column name */
const findRowField = (entity: TableEntity, columnName: string): Field | undefined =>
  entity.shapes.row.fields.find(f => f.columnName === columnName)

/** Get the TypeScript type AST for a field */
const getFieldTypeAst = (field: Field | undefined, ctx: GenerationContext): n.TSType => {
  if (!field) return ts.string()
  const resolved = resolveFieldType(field, ctx.enums, ctx.ir.extensions)
  return resolved.enumDef ? ts.ref(resolved.enumDef.name) : tsTypeToAst(resolved.tsType)
}

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
  )

/**
 * Derive semantic name for an FK-based lookup.
 * Priority: @fieldName tag → column minus _id suffix → target entity name
 */
const deriveSemanticName = (relation: Relation, columnName: string): string => {
  // 1. Check for @fieldName smart tag
  if (relation.tags.fieldName && typeof relation.tags.fieldName === "string") {
    return relation.tags.fieldName
  }

  // 2. Strip common FK suffixes from column name
  const suffixes = ["_id", "_fk", "Id", "Fk"]
  for (const suffix of suffixes) {
    if (columnName.endsWith(suffix)) {
      const stripped = columnName.slice(0, -suffix.length)
      if (stripped.length > 0) return stripped
    }
  }

  // 3. Fall back to target entity name (lowercased first char)
  const target = relation.targetEntity
  return target.charAt(0).toLowerCase() + target.slice(1)
}

/**
 * Convert to PascalCase for use in method names.
 * Handles snake_case (created_at → CreatedAt) and regular strings.
 */
const toPascalCase = (s: string): string => inflect.pascalCase(s)

// ============================================================================
// AST Building Helpers
// ============================================================================

/** Create identifier */
const id = (name: string): n.Identifier => b.identifier(name)

/** Create member expression: obj.prop */
const member = (obj: n.Expression, prop: string): n.MemberExpression =>
  b.memberExpression(toExpr(obj), id(prop))

/** Create method call: obj.method(args) */
const call = (obj: n.Expression, method: string, args: n.Expression[] = []): n.CallExpression =>
  b.callExpression(member(obj, method), args.map(toExpr))

/** Create string literal */
const str = (value: string): n.StringLiteral => b.stringLiteral(value)

/** Create typed parameter: name: Type */
const typedParam = (name: string, type: n.TSType): n.Identifier => {
  const param = id(name)
  param.typeAnnotation = b.tsTypeAnnotation(cast.toTSType(type))
  return param
}

/** Create optional typed parameter: name?: Type */
const optionalTypedParam = (name: string, type: n.TSType): n.Identifier => {
  const param = typedParam(name, type)
  param.optional = true
  return param
}

/**
 * Build Kysely query chain starting with db.selectFrom('table')
 */
const selectFrom = (tableRef: string): n.CallExpression =>
  call(id("db"), "selectFrom", [str(tableRef)])

/**
 * Build Kysely query chain: db.insertInto('table')
 */
const insertInto = (tableRef: string): n.CallExpression =>
  call(id("db"), "insertInto", [str(tableRef)])

/**
 * Build Kysely query chain: db.updateTable('table')
 */
const updateTable = (tableRef: string): n.CallExpression =>
  call(id("db"), "updateTable", [str(tableRef)])

/**
 * Build Kysely query chain: db.deleteFrom('table')
 */
const deleteFrom = (tableRef: string): n.CallExpression =>
  call(id("db"), "deleteFrom", [str(tableRef)])

/**
 * Chain method call onto existing expression
 */
const chain = (expr: n.Expression, method: string, args: n.Expression[] = []): n.CallExpression =>
  call(expr, method, args)

/** Arrow function parameter - identifier or assignment pattern (for defaults) */
type ArrowParam = n.Identifier | n.AssignmentPattern

/**
 * Build arrow function expression: (params) => body
 */
const arrowFn = (
  params: ArrowParam[],
  body: n.Expression,
): n.ArrowFunctionExpression => {
  const fn = b.arrowFunctionExpression(
    params.map(p => p as Parameters<typeof b.arrowFunctionExpression>[0][0]),
    toExpr(body)
  )
  return fn
}

/**
 * Build object property: key: value
 */
const objProp = (key: string, value: n.Expression): n.ObjectProperty => {
  const prop = b.objectProperty(id(key), toExpr(value))
  return prop
}

// ============================================================================
// PostgreSQL Type Name to TypeScript Mapping
// ============================================================================

/**
 * Map PostgreSQL type name to TypeScript type string.
 * Used for function argument and return type resolution.
 */
const pgTypeNameToTs = (typeName: string): string => {
  // Normalize: strip schema prefix if present
  const baseName = typeName.includes(".") ? typeName.split(".").pop()! : typeName

  switch (baseName) {
    // Boolean
    case "bool":
    case "boolean":
      return "boolean"

    // Integer types → number
    case "int2":
    case "smallint":
    case "int4":
    case "integer":
    case "int":
    case "oid":
    case "float4":
    case "real":
    case "float8":
    case "double precision":
      return "number"

    // Big integers/numeric → string (to avoid precision loss)
    case "int8":
    case "bigint":
    case "numeric":
    case "decimal":
    case "money":
      return "string"

    // Text types → string
    case "text":
    case "varchar":
    case "character varying":
    case "char":
    case "character":
    case "bpchar":
    case "name":
    case "xml":
    case "bit":
    case "varbit":
    case "bit varying":
    case "uuid":
    case "inet":
    case "cidr":
    case "macaddr":
    case "macaddr8":
    case "time":
    case "timetz":
    case "time with time zone":
    case "time without time zone":
    case "interval":
      return "string"

    // Date/Time with date component → Date
    case "date":
    case "timestamp":
    case "timestamptz":
    case "timestamp with time zone":
    case "timestamp without time zone":
      return "Date"

    // JSON → unknown
    case "json":
    case "jsonb":
    case "jsonpath":
      return "unknown"

    // Binary → Buffer
    case "bytea":
      return "Buffer"

    // Void
    case "void":
      return "void"

    // Default to unknown
    default:
      return "unknown"
  }
}

// ============================================================================
// Function Filtering & Categorization
// ============================================================================

/**
 * Context for function generation - extends the table context with function-specific data
 */
interface FunctionGenContext {
  readonly ir: SemanticIR
  readonly enums: readonly EnumEntity[]
  readonly defaultSchemas: readonly string[]
  readonly dbTypesPath: string
  readonly executeQueries: boolean
}

/**
 * Check if a function argument type matches a table/view entity (row type argument).
 * Functions with row-type arguments are computed fields (e.g., posts_short_body(posts))
 * and should be excluded from function wrapper generation.
 */
const hasRowTypeArg = (arg: FunctionArg, ir: SemanticIR): boolean => {
  const tableEntities = getTableEntities(ir)
  // Check if arg.typeName matches a table entity's qualified name
  // Format: "schema.tablename" or just "tablename" for public schema
  return tableEntities.some(entity => {
    const qualifiedName = `${entity.schemaName}.${entity.pgName}`
    return arg.typeName === qualifiedName || arg.typeName === entity.pgName
  })
}

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
  if (!fn.canExecute) return false
  if (fn.returnTypeName === "trigger") return false
  if (fn.isFromExtension) return false
  if (fn.tags.omit === true) return false
  // Check for row-type args (computed field pattern)
  if (fn.args.some(arg => hasRowTypeArg(arg, ir))) return false
  return true
}

/**
 * Categorize functions by volatility.
 * Volatile functions go in mutations namespace, stable/immutable in queries.
 */
const categorizeFunction = (fn: FunctionEntity): "queries" | "mutations" =>
  fn.volatility === "volatile" ? "mutations" : "queries"

/**
 * Get all generatable functions from the IR, categorized by volatility.
 */
const getGeneratableFunctions = (ir: SemanticIR): {
  queries: FunctionEntity[]
  mutations: FunctionEntity[]
} => {
  const all = getFunctionEntities(ir).filter(fn => isGeneratableFunction(fn, ir))
  return {
    queries: all.filter(fn => categorizeFunction(fn) === "queries"),
    mutations: all.filter(fn => categorizeFunction(fn) === "mutations"),
  }
}

// ============================================================================
// Function Return Type Resolution
// ============================================================================

/**
 * Resolved return type information for function wrappers.
 */
interface ResolvedReturnType {
  /** TypeScript type string (e.g., "string", "boolean", "Users", "TagSearchResult") */
  readonly tsType: string
  /** True for SETOF returns (returns multiple rows) */
  readonly isArray: boolean
  /** True for scalar types (primitives like string, number, boolean) */
  readonly isScalar: boolean
  /** Type name to import from DB types file, if needed */
  readonly needsImport?: string
  /** The entity this return type references (for grouping into entity files) */
  readonly returnEntity?: TableEntity | CompositeEntity
}

/**
 * Resolve a function's return type to TypeScript type information.
 */
const resolveReturnType = (fn: FunctionEntity, ir: SemanticIR): ResolvedReturnType => {
  const returnTypeName = fn.returnTypeName
  const isArray = fn.returnsSet

  // 1. Check if it's a table return type
  const tableEntities = getTableEntities(ir)
  const tableMatch = tableEntities.find(entity => {
    const qualifiedName = `${entity.schemaName}.${entity.pgName}`
    return returnTypeName === qualifiedName || returnTypeName === entity.pgName
  })
  if (tableMatch) {
    return {
      tsType: tableMatch.name,
      isArray,
      isScalar: false,
      needsImport: tableMatch.name,
      returnEntity: tableMatch,
    }
  }

  // 2. Check if it's a composite type return
  const compositeEntities = getCompositeEntities(ir)
  const compositeMatch = compositeEntities.find(entity => {
    const qualifiedName = `${entity.schemaName}.${entity.pgName}`
    return returnTypeName === qualifiedName || returnTypeName === entity.pgName
  })
  if (compositeMatch) {
    return {
      tsType: compositeMatch.name,
      isArray,
      isScalar: false,
      needsImport: compositeMatch.name,
      returnEntity: compositeMatch,
    }
  }

  // 3. It's a scalar type - map via type name
  // Handle "schema.typename" format by extracting just the type name
  const baseTypeName = returnTypeName.includes(".")
    ? returnTypeName.split(".").pop()!
    : returnTypeName
  const tsType = pgTypeNameToTs(baseTypeName)

  return {
    tsType,
    isArray,
    isScalar: true,
  }
}

// ============================================================================
// Function Argument Type Resolution
// ============================================================================

/**
 * Resolved argument information for function wrappers.
 */
interface ResolvedArg {
  /** Parameter name (camelCase) */
  readonly name: string
  /** TypeScript type string */
  readonly tsType: string
  /** True if argument has a default value */
  readonly isOptional: boolean
  /** Type name to import from DB types file, if needed */
  readonly needsImport?: string
}

/**
 * Resolve a function argument to TypeScript type information.
 */
const resolveArg = (arg: FunctionArg, ir: SemanticIR): ResolvedArg => {
  const typeName = arg.typeName

  // Check if it's an array type (ends with [])
  const isArrayType = typeName.endsWith("[]")
  const baseTypeName = isArrayType ? typeName.slice(0, -2) : typeName

  // Check enums
  const enums = getEnumEntities(ir)
  const enumMatch = enums.find(e => {
    const qualifiedName = `${e.schemaName}.${e.pgName}`
    return baseTypeName === qualifiedName || baseTypeName === e.pgName
  })
  if (enumMatch) {
    const tsType = isArrayType ? `${enumMatch.name}[]` : enumMatch.name
    return {
      name: arg.name || "arg",
      tsType,
      isOptional: arg.hasDefault,
      needsImport: enumMatch.name,
    }
  }

  // Check composites
  const composites = getCompositeEntities(ir)
  const compositeMatch = composites.find(e => {
    const qualifiedName = `${e.schemaName}.${e.pgName}`
    return baseTypeName === qualifiedName || baseTypeName === e.pgName
  })
  if (compositeMatch) {
    const tsType = isArrayType ? `${compositeMatch.name}[]` : compositeMatch.name
    return {
      name: arg.name || "arg",
      tsType,
      isOptional: arg.hasDefault,
      needsImport: compositeMatch.name,
    }
  }

  // Scalar type - map via type name
  // Handle "schema.typename" format
  const scalarBase = baseTypeName.includes(".")
    ? baseTypeName.split(".").pop()!
    : baseTypeName
  const scalarTs = pgTypeNameToTs(scalarBase)
  const tsType = isArrayType ? `${scalarTs}[]` : scalarTs

  return {
    name: arg.name || "arg",
    tsType,
    isOptional: arg.hasDefault,
  }
}

/**
 * Resolve all arguments for a function.
 */
const resolveArgs = (fn: FunctionEntity, ir: SemanticIR): ResolvedArg[] =>
  fn.args.map(arg => resolveArg(arg, ir))

// ============================================================================
// Function Wrapper AST Generation
// ============================================================================

/**
 * Generate a typed parameter with explicit type annotation from type string.
 */
const typedParamFromString = (name: string, typeStr: string): n.Identifier => {
  const param = id(name)
  // Map type string to AST
  let typeAst: n.TSType
  switch (typeStr) {
    case "string":
      typeAst = ts.string()
      break
    case "number":
      typeAst = ts.number()
      break
    case "boolean":
      typeAst = ts.boolean()
      break
    case "Date":
      typeAst = ts.ref("Date")
      break
    case "Buffer":
      typeAst = ts.ref("Buffer")
      break
    case "unknown":
      typeAst = ts.unknown()
      break
    case "void":
      typeAst = ts.void()
      break
    default:
      // Handle array types like "string[]"
      if (typeStr.endsWith("[]")) {
        const elemType = typeStr.slice(0, -2)
        const elemAst = elemType === "string" ? ts.string()
          : elemType === "number" ? ts.number()
          : elemType === "boolean" ? ts.boolean()
          : ts.ref(elemType)
        typeAst = ts.array(elemAst)
      } else {
        // Assume it's a type reference (composite, enum, etc.)
        typeAst = ts.ref(typeStr)
      }
  }
  param.typeAnnotation = b.tsTypeAnnotation(cast.toTSType(typeAst))
  return param
}

/**
 * Generate an optional typed parameter with explicit type annotation.
 */
const optionalTypedParamFromString = (name: string, typeStr: string): n.Identifier => {
  const param = typedParamFromString(name, typeStr)
  param.optional = true
  return param
}

/**
 * Get the fully qualified function name for use in eb.fn call.
 */
const getFunctionQualifiedName = (fn: FunctionEntity): string =>
  `${fn.schemaName}.${fn.pgName}`

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
): MethodDef => {
  const resolvedReturn = resolveReturnType(fn, ir)
  const resolvedArgs = resolveArgs(fn, ir)
  const qualifiedName = getFunctionQualifiedName(fn)

  // Build eb.val(arg) for each argument
  const fnArgs = resolvedArgs.map(arg =>
    call(id("eb"), "val", [id(arg.name)])
  )

  // Build eb.fn<Type>('schema.fn_name', [args]).as('alias')
  // The type parameter is the return type
  const returnTypeAst = resolvedReturn.isScalar
    ? typedParamFromString("_", resolvedReturn.tsType).typeAnnotation!.typeAnnotation as n.TSType
    : ts.ref(resolvedReturn.tsType)

  // Create eb.fn with type parameter: eb.fn<Type>
  const fnMember = b.memberExpression(id("eb"), id("fn"))
  const fnWithType = b.tsInstantiationExpression(
    fnMember,
    b.tsTypeParameterInstantiation([cast.toTSType(returnTypeAst)])
  )

  // Call it: eb.fn<Type>(name, args)
  const fnCallBase = b.callExpression(
    fnWithType,
    [str(qualifiedName), b.arrayExpression(fnArgs.map(toExpr))]
  )

  // .as('f') or .as('result') for scalar
  const alias = resolvedReturn.isScalar ? "result" : "f"
  const fnCallWithAlias = call(fnCallBase, "as", [str(alias)])

  // Arrow function for selectFrom callback: eb => eb.fn<...>(...).as('f')
  const selectCallback = arrowFn([id("eb")], fnCallWithAlias)

  // Build the query chain
  let query: n.Expression

  if (resolvedReturn.isScalar) {
    // Scalar: db.selectNoFrom(eb => ...).executeTakeFirst()
    // Returns { result: T } | undefined - caller accesses .result
    query = call(id("db"), "selectNoFrom", [selectCallback])

    if (executeQueries) {
      query = chain(query, "executeTakeFirst")
    }
  } else {
    // Table/composite: db.selectFrom(eb => ...).selectAll()
    query = chain(
      call(id("db"), "selectFrom", [selectCallback]),
      "selectAll"
    )

    if (executeQueries) {
      // SETOF → .execute(), single row → .executeTakeFirst()
      query = chain(query, resolvedReturn.isArray ? "execute" : "executeTakeFirst")
    }
  }

  // Build the parameters: (db: Kysely<DB>, arg1: Type1, arg2?: Type2, ...)
  const params: ArrowParam[] = [
    typedParam("db", ts.ref("Kysely", [ts.ref("DB")])),
    ...resolvedArgs.map(arg =>
      arg.isOptional
        ? optionalTypedParamFromString(arg.name, arg.tsType)
        : typedParamFromString(arg.name, arg.tsType)
    )
  ]

  const wrapperFn = arrowFn(params, query)

  return { name: fn.name, fn: wrapperFn }
}

/**
 * Collect all type imports needed for function wrappers.
 */
const collectFunctionTypeImports = (
  functions: readonly FunctionEntity[],
  ir: SemanticIR
): Set<string> => {
  const imports = new Set<string>()

  for (const fn of functions) {
    const resolvedReturn = resolveReturnType(fn, ir)
    if (resolvedReturn.needsImport) {
      imports.add(resolvedReturn.needsImport)
    }

    for (const arg of resolveArgs(fn, ir)) {
      if (arg.needsImport) {
        imports.add(arg.needsImport)
      }
    }
  }

  return imports
}

// ============================================================================
// CRUD Method Generators
// ============================================================================

/**
 * Generate findById method:
 * export const findById = (db, id) => db.selectFrom('table').selectAll().where('id', '=', id).executeTakeFirst()
 */
const generateFindById = (ctx: GenerationContext): MethodDef | undefined => {
  const { entity, executeQueries, defaultSchemas, entityName, exportName } = ctx
  if (!entity.primaryKey || !entity.permissions.canSelect) return undefined

  const pkColName = entity.primaryKey.columns[0]!
  const pkField = findRowField(entity, pkColName)
  if (!pkField) return undefined

  const tableRef = getTableRef(entity, defaultSchemas)
  const fieldName = pkField.name
  const fieldType = getFieldTypeAst(pkField, ctx)

  // db.selectFrom('table').selectAll().where('col', '=', id)
  let query: n.Expression = chain(
    chain(selectFrom(tableRef), "selectAll"),
    "where",
    [str(pkColName), str("="), id(fieldName)]
  )

  if (executeQueries) {
    query = chain(query, "executeTakeFirst")
  }

  const fn = arrowFn(
    [typedParam("db", ts.ref("Kysely", [ts.ref("DB")])), typedParam(fieldName, fieldType)],
    query
  )

  return { name: exportName(entityName, "FindById"), fn }
}

/** Default limit for findMany queries */
const DEFAULT_LIMIT = 50

/** Default offset for findMany queries */
const DEFAULT_OFFSET = 0

/**
 * Create a parameter with a default value: name = defaultValue
 * Type is inferred from the default value, no explicit annotation.
 */
const paramWithDefault = (name: string, defaultValue: n.Expression): n.AssignmentPattern =>
  b.assignmentPattern(id(name), toExpr(defaultValue))

/**
 * Generate listMany method with pagination defaults:
 * export const listMany = (db, limit = 50, offset = 0) => db.selectFrom('table').selectAll()
 *   .limit(limit).offset(offset).execute()
 */
const generateListMany = (ctx: GenerationContext): MethodDef | undefined => {
  const { entity, executeQueries, defaultSchemas, entityName, exportName } = ctx
  if (!entity.permissions.canSelect) return undefined

  const tableRef = getTableRef(entity, defaultSchemas)

  // Build query: db.selectFrom('table').selectAll().limit(limit).offset(offset)
  let query: n.Expression = chain(
    chain(
      chain(selectFrom(tableRef), "selectAll"),
      "limit",
      [id("limit")]
    ),
    "offset",
    [id("offset")]
  )

  // Add .execute() if executeQueries is true
  if (executeQueries) {
    query = chain(query, "execute")
  }

  const fn = arrowFn(
    [
      typedParam("db", ts.ref("Kysely", [ts.ref("DB")])),
      paramWithDefault("limit", b.numericLiteral(DEFAULT_LIMIT)),
      paramWithDefault("offset", b.numericLiteral(DEFAULT_OFFSET)),
    ],
    query
  )

  return { name: exportName(entityName, "ListMany"), fn }
}

/**
 * Generate create method:
 * export const create = (db, data) => db.insertInto('table').values(data).returningAll().executeTakeFirstOrThrow()
 */
const generateCreate = (ctx: GenerationContext): MethodDef | undefined => {
  const { entity, executeQueries, defaultSchemas, entityName, exportName } = ctx
  if (!entity.permissions.canInsert) return undefined

  const tableRef = getTableRef(entity, defaultSchemas)
  const tableTypeName = getTableTypeName(entity)

  // db.insertInto('table').values(data).returningAll()
  let query: n.Expression = chain(
    chain(insertInto(tableRef), "values", [id("data")]),
    "returningAll"
  )

  if (executeQueries) {
    query = chain(query, "executeTakeFirstOrThrow")
  }

  // Use Insertable<TableTypeName> for the data parameter
  const fn = arrowFn(
    [
      typedParam("db", ts.ref("Kysely", [ts.ref("DB")])),
      typedParam("data", ts.ref("Insertable", [ts.ref(tableTypeName)])),
    ],
    query
  )

  return { name: exportName(entityName, "Create"), fn }
}

/**
 * Generate update method:
 * export const update = (db, id, data) => db.updateTable('table').set(data).where('id', '=', id).returningAll().executeTakeFirstOrThrow()
 */
const generateUpdate = (ctx: GenerationContext): MethodDef | undefined => {
  const { entity, executeQueries, defaultSchemas, entityName, exportName } = ctx
  if (!entity.primaryKey || !entity.permissions.canUpdate) return undefined

  const pkColName = entity.primaryKey.columns[0]!
  const pkField = findRowField(entity, pkColName)
  if (!pkField) return undefined

  const tableRef = getTableRef(entity, defaultSchemas)
  const fieldName = pkField.name
  const fieldType = getFieldTypeAst(pkField, ctx)
  const tableTypeName = getTableTypeName(entity)

  // db.updateTable('table').set(data).where('id', '=', id).returningAll()
  let query: n.Expression = chain(
    chain(
      chain(updateTable(tableRef), "set", [id("data")]),
      "where",
      [str(pkColName), str("="), id(fieldName)]
    ),
    "returningAll"
  )

  if (executeQueries) {
    query = chain(query, "executeTakeFirstOrThrow")
  }

  // Use Updateable<TableTypeName> for the data parameter
  const fn = arrowFn(
    [
      typedParam("db", ts.ref("Kysely", [ts.ref("DB")])),
      typedParam(fieldName, fieldType),
      typedParam("data", ts.ref("Updateable", [ts.ref(tableTypeName)])),
    ],
    query
  )

  return { name: exportName(entityName, "Update"), fn }
}

/**
 * Generate delete method:
 * export const remove = (db, id) => db.deleteFrom('table').where('id', '=', id).execute()
 */
const generateDelete = (ctx: GenerationContext): MethodDef | undefined => {
  const { entity, executeQueries, defaultSchemas, entityName, exportName } = ctx
  if (!entity.primaryKey || !entity.permissions.canDelete) return undefined

  const pkColName = entity.primaryKey.columns[0]!
  const pkField = findRowField(entity, pkColName)
  if (!pkField) return undefined

  const tableRef = getTableRef(entity, defaultSchemas)
  const fieldName = pkField.name
  const fieldType = getFieldTypeAst(pkField, ctx)

  // db.deleteFrom('table').where('id', '=', id)
  let query: n.Expression = chain(
    deleteFrom(tableRef),
    "where",
    [str(pkColName), str("="), id(fieldName)]
  )

  if (executeQueries) {
    query = chain(query, "execute")
  }

  const fn = arrowFn(
    [typedParam("db", ts.ref("Kysely", [ts.ref("DB")])), typedParam(fieldName, fieldType)],
    query
  )

  return { name: exportName(entityName, "Remove"), fn }
}

/** Generate all CRUD methods for an entity */
const generateCrudMethods = (ctx: GenerationContext): readonly MethodDef[] =>
  [
    generateFindById(ctx),
    ctx.generateListMany ? generateListMany(ctx) : undefined,
    generateCreate(ctx),
    generateUpdate(ctx),
    generateDelete(ctx),
  ].filter((p): p is MethodDef => p != null)

// ============================================================================
// Index-based Lookup Functions
// ============================================================================

/** Check if an index should generate a lookup function */
const shouldGenerateLookup = (index: IndexDef): boolean =>
  !index.isPartial &&
  !index.hasExpressions &&
  index.columns.length === 1 &&
  index.method !== "gin" &&
  index.method !== "gist"

/**
 * Generate the method name portion for an index-based lookup.
 * Uses semantic naming when the column corresponds to an FK relation.
 */
const generateLookupMethodName = (
  entity: TableEntity,
  index: IndexDef,
  relation: Relation | undefined
): string => {
  const isUnique = isUniqueLookup(entity, index)
  // Uses "FindOneBy" or "FindManyBy" suffix
  const suffix = isUnique ? "FindOneBy" : "FindManyBy"

  // Use semantic name if FK relation exists, otherwise fall back to column name
  const columnName = index.columnNames[0]!
  const byName = relation
    ? deriveSemanticName(relation, columnName)
    : index.columns[0]!

  return `${suffix}${toPascalCase(byName)}`
}

/**
 * Generate a lookup method for a single-column index.
 * Uses semantic parameter naming when the column corresponds to an FK relation.
 */
const generateLookupMethod = (index: IndexDef, ctx: GenerationContext): MethodDef => {
  const { entity, executeQueries, defaultSchemas, entityName, exportName } = ctx
  const tableRef = getTableRef(entity, defaultSchemas)
  const columnName = index.columnNames[0]!
  const field = findRowField(entity, columnName)
  const fieldName = field?.name ?? index.columns[0]!
  const isUnique = isUniqueLookup(entity, index)

  // Check if this index column corresponds to an FK relation
  const relation = findRelationForColumn(entity, columnName)

  // Use semantic param name if FK relation exists, otherwise use field name
  const paramName = relation
    ? deriveSemanticName(relation, columnName)
    : fieldName

  // For FK columns, use indexed access on Selectable<TableType> to get the unwrapped type
  // (Kysely's Generated<T> types need Selectable to unwrap for use in where clauses)
  // For regular columns, use the field's type directly
  const useSemanticNaming = relation !== undefined && paramName !== fieldName
  const tableTypeName = getTableTypeName(entity)
  const paramType = useSemanticNaming
    ? ts.indexedAccess(
        ts.ref("Selectable", [ts.ref(tableTypeName)]),
        ts.literal(fieldName)
      )
    : getFieldTypeAst(field, ctx)

  // db.selectFrom('table').selectAll().where('col', '=', value)
  let query: n.Expression = chain(
    chain(selectFrom(tableRef), "selectAll"),
    "where",
    [str(columnName), str("="), id(paramName)]
  )

  if (executeQueries) {
    query = chain(query, isUnique ? "executeTakeFirst" : "execute")
  }

  const fn = arrowFn(
    [typedParam("db", ts.ref("Kysely", [ts.ref("DB")])), typedParam(paramName, paramType)],
    query
  )

  const methodName = generateLookupMethodName(entity, index, relation)
  return { name: exportName(entityName, methodName), fn }
}

/**
 * Check if a column is covered by a unique constraint (not just unique index).
 * This helps determine if a non-unique B-tree index on the column still
 * returns at most one row.
 */
const columnHasUniqueConstraint = (entity: TableEntity, columnName: string): boolean => {
  const constraints = entity.pgClass.getConstraints()
  return constraints.some(c => {
    // 'u' = unique constraint, 'p' = primary key
    if (c.contype !== "u" && c.contype !== "p") return false
    // Single-column constraint on our column?
    const conkey = c.conkey ?? []
    if (conkey.length !== 1) return false
    // Find the attribute with this attnum
    const attrs = entity.pgClass.getAttributes()
    const attr = attrs.find(a => a.attnum === conkey[0])
    return attr?.attname === columnName
  })
}

/**
 * Determine if a lookup should be treated as unique (returns one row).
 * True if: index is unique, index is primary, OR column has unique constraint.
 */
const isUniqueLookup = (entity: TableEntity, index: IndexDef): boolean => {
  if (index.isUnique || index.isPrimary) return true
  // Check if the single column has a unique constraint
  const columnName = index.columnNames[0]
  return columnName ? columnHasUniqueConstraint(entity, columnName) : false
}

/** Generate lookup methods for all eligible indexes, deduplicating by column */
const generateLookupMethods = (ctx: GenerationContext): readonly MethodDef[] => {
  const eligibleIndexes = ctx.entity.indexes
    .filter(index => shouldGenerateLookup(index) && !index.isPrimary && ctx.entity.permissions.canSelect)

  // Group by column name, keeping only one index per column
  // Prefer unique indexes, but also consider columns with unique constraints
  const byColumn = new Map<string, IndexDef>()
  for (const index of eligibleIndexes) {
    const columnName = index.columnNames[0]!
    const existing = byColumn.get(columnName)
    if (!existing) {
      byColumn.set(columnName, index)
    } else {
      // Prefer explicitly unique index over non-unique
      if (index.isUnique && !existing.isUnique) {
        byColumn.set(columnName, index)
      }
    }
  }

  return Array.from(byColumn.values()).map(index => generateLookupMethod(index, ctx))
}

// ============================================================================
// Export Style Helpers
// ============================================================================

/**
 * Convert MethodDef array to flat export statements.
 * Each method becomes: export const methodName = (db, ...) => ...
 */
const toFlatExports = (methods: readonly MethodDef[]): n.Statement[] =>
  methods.map(m => conjure.export.const(m.name, m.fn))

/**
 * Convert MethodDef array to a single namespace object export.
 * All methods become: export const EntityName = { methodName: (db, ...) => ..., ... }
 */
const toNamespaceExport = (entityName: string, methods: readonly MethodDef[]): n.Statement => {
  const properties = methods.map(m =>
    b.objectProperty(id(m.name), m.fn)
  )
  const obj = b.objectExpression(properties)
  return conjure.export.const(entityName, obj)
}

/**
 * Convert MethodDef array to statements based on export style.
 */
const toStatements = (
  methods: readonly MethodDef[],
  exportStyle: "flat" | "namespace",
  entityName: string
): n.Statement[] => {
  if (methods.length === 0) return []
  return exportStyle === "namespace"
    ? [toNamespaceExport(entityName, methods)]
    : toFlatExports(methods)
}

// ============================================================================
// Plugin Definition
// ============================================================================

export const kyselyQueriesPlugin = definePlugin({
  name: "kysely-queries",
  provides: ["queries", "queries:kysely"],
  requires: [],  // No dependency on types:kysely for now - uses external kysely-codegen types
  configSchema: KyselyQueriesPluginConfigSchema,
  inflection: {
    outputFile: ctx => `${ctx.entityName}.ts`,
    symbolName: (entityName, artifactKind) => `${entityName}${artifactKind}`,
  },

  run: (ctx, rawConfig) => {
    // Resolve config with function defaults
    const config: KyselyQueriesPluginConfig = {
      ...rawConfig,
      exportName: rawConfig.exportName ?? defaultExportName,
    }

    const enums = getEnumEntities(ctx.ir)
    const defaultSchemas = ctx.ir.schemas
    const { dbTypesPath, executeQueries, generateListMany, exportName } = config

    // Pre-compute function groupings by return entity name
    // Functions returning entities go in that entity's file; scalars go in functions.ts
    const functionsByEntity = new Map<string, FunctionEntity[]>()
    const scalarFunctions: FunctionEntity[] = []

    if (config.generateFunctions) {
      const { queries, mutations } = getGeneratableFunctions(ctx.ir)
      const allFunctions = [...queries, ...mutations]

      for (const fn of allFunctions) {
        const resolved = resolveReturnType(fn, ctx.ir)
        if (resolved.returnEntity) {
          const entityName = resolved.returnEntity.name
          const existing = functionsByEntity.get(entityName) ?? []
          functionsByEntity.set(entityName, [...existing, fn])
        } else {
          scalarFunctions.push(fn)
        }
      }
    }

    getTableEntities(ctx.ir)
      .filter(entity => entity.tags.omit !== true)
      .forEach(entity => {
        const entityName = ctx.inflection.entityName(entity.pgClass, entity.tags)
        const genCtx: GenerationContext = { entity, enums, ir: ctx.ir, defaultSchemas, dbTypesPath, executeQueries, generateListMany, entityName, exportName }
        
        // Collect all methods for this entity
        const methods: MethodDef[] = [
          ...generateCrudMethods(genCtx),
          ...generateLookupMethods(genCtx),
        ]

        // Get functions that return this entity
        const entityFunctions = functionsByEntity.get(entity.name) ?? []
        for (const fn of entityFunctions) {
          methods.push(generateFunctionWrapper(fn, ctx.ir, executeQueries))
        }

        if (methods.length === 0) return

        const fileNameCtx: FileNameContext = {
          entityName,
          pgName: entity.pgName,
          schema: entity.schemaName,
          inflection: ctx.inflection,
          entity,
        }
        const filePath = `${config.outputDir}/${ctx.pluginInflection.outputFile(fileNameCtx)}`

        // Convert methods to statements based on export style
        const statements = toStatements(methods, config.exportStyle, entityName)

        const file = ctx
          .file(filePath)

        // Import Kysely type and DB from kysely-codegen output
        file.import({ kind: "package", types: ["Kysely"], from: "kysely" })
        file.import({ kind: "relative", types: ["DB"], from: dbTypesPath })

        // Import Insertable/Updateable helper types and table type if we generate create/update
        const tableTypeName = getTableTypeName(entity)
        
        // Check if any lookup methods use semantic naming (FK with Selectable indexed access)
        const hasSemanticLookups = entity.indexes.some(index => {
          if (!shouldGenerateLookup(index) || index.isPrimary) return false
          const columnName = index.columnNames[0]!
          const relation = findRelationForColumn(entity, columnName)
          if (!relation) return false
          const paramName = deriveSemanticName(relation, columnName)
          const field = findRowField(entity, columnName)
          const fieldName = field?.name ?? index.columns[0]!
          return paramName !== fieldName
        })
        
        // Import table type if needed for Insertable/Updateable or semantic lookups
        const needsTableType = entity.permissions.canInsert || entity.permissions.canUpdate || hasSemanticLookups
        if (needsTableType) {
          file.import({ kind: "relative", types: [tableTypeName], from: dbTypesPath })
        }
        
        // Import Selectable if we have semantic lookups (for unwrapping Generated<T>)
        if (hasSemanticLookups) {
          file.import({ kind: "package", types: ["Selectable"], from: "kysely" })
        }
        
        if (entity.permissions.canInsert) {
          file.import({ kind: "package", types: ["Insertable"], from: "kysely" })
        }
        if (entity.permissions.canUpdate) {
          file.import({ kind: "package", types: ["Updateable"], from: "kysely" })
        }

        // Import types needed by function args (for functions grouped into this file)
        if (entityFunctions.length > 0) {
          const fnTypeImports = collectFunctionTypeImports(entityFunctions, ctx.ir)
          // Remove the entity's own type (already in scope or self-referential)
          fnTypeImports.delete(entity.name)
          if (fnTypeImports.size > 0) {
            file.import({ kind: "relative", types: [...fnTypeImports], from: dbTypesPath })
          }
        }

        file.ast(conjure.program(...statements)).emit()
      })

    // Generate files for composite types that have functions returning them
    if (config.generateFunctions) {
      const composites = getCompositeEntities(ctx.ir)
      for (const composite of composites) {
        const compositeFunctions = functionsByEntity.get(composite.name) ?? []
        if (compositeFunctions.length === 0) continue

        const filePath = `${config.outputDir}/${composite.name}.ts`
        const methods = compositeFunctions.map(fn =>
          generateFunctionWrapper(fn, ctx.ir, executeQueries)
        )
        const statements = toStatements(methods, config.exportStyle, composite.name)

        const file = ctx.file(filePath)
        file.import({ kind: "package", types: ["Kysely"], from: "kysely" })
        file.import({ kind: "relative", types: ["DB"], from: dbTypesPath })

        // Import the composite type and any types needed by function args
        const fnTypeImports = collectFunctionTypeImports(compositeFunctions, ctx.ir)
        fnTypeImports.add(composite.name) // Always import the composite type
        file.import({ kind: "relative", types: [...fnTypeImports], from: dbTypesPath })

        file.ast(conjure.program(...statements)).emit()
      }
    }

    // Generate functions.ts for scalar-returning functions only
    if (config.generateFunctions && scalarFunctions.length > 0) {
      const filePath = `${config.outputDir}/${config.functionsFile}`

      const methods = scalarFunctions.map(fn =>
        generateFunctionWrapper(fn, ctx.ir, executeQueries)
      )
      // For scalar functions, use "functions" as the namespace name
      const statements = toStatements(methods, config.exportStyle, "functions")

      const file = ctx.file(filePath)

      // Import Kysely type and DB
      file.import({ kind: "package", types: ["Kysely"], from: "kysely" })
      file.import({ kind: "relative", types: ["DB"], from: dbTypesPath })

      // Import any types needed for function args (scalars don't need return type imports)
      const typeImports = collectFunctionTypeImports(scalarFunctions, ctx.ir)
      if (typeImports.size > 0) {
        file.import({ kind: "relative", types: [...typeImports], from: dbTypesPath })
      }

      file.ast(conjure.program(...statements)).emit()
    }
  },
})

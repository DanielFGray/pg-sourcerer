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
import type { Field, IndexDef, TableEntity, EnumEntity, SemanticIR, Relation } from "../ir/semantic-ir.js"
import { getTableEntities, getEnumEntities } from "../ir/semantic-ir.js"
import { conjure, cast } from "../lib/conjure.js"
import { resolveFieldType, tsTypeToAst } from "../lib/field-utils.js"
import { inflect } from "../services/inflection.js"

const { ts, b } = conjure
const { toExpr } = cast

// ============================================================================
// Configuration
// ============================================================================

const KyselyQueriesPluginConfig = S.Struct({
  outputDir: S.String,
  header: S.optional(S.String),
  /** 
   * Path to import DB type from (relative to outputDir). 
   * Defaults to "../DB.js" which works with kysely-codegen's DB.d.ts output.
   * For node16/nodenext module resolution, use ".js" extension even for .d.ts files.
   */
  dbTypesPath: S.optional(S.String),
  /**
   * Whether to call .execute() / .executeTakeFirst() on queries.
   * When true (default), methods return Promise<Row> or Promise<Row[]>.
   * When false, methods return the query builder for further customization.
   */
  executeQueries: S.optional(S.Boolean),
  /**
   * Whether to generate listMany() method for unfiltered table scans.
   * Disabled by default since unfiltered scans don't use indexes.
   * When enabled, generates: listMany(db, limit = 50, offset = 0)
   */
  generateListMany: S.optional(S.Boolean),
})

type KyselyQueriesPluginConfig = S.Schema.Type<typeof KyselyQueriesPluginConfig>

// ============================================================================
// Context & Type Helpers
// ============================================================================

interface GenerationContext {
  readonly entity: TableEntity
  readonly enums: readonly EnumEntity[]
  readonly ir: SemanticIR
  readonly dbTypesPath: string
  readonly executeQueries: boolean
  readonly generateListMany: boolean
}

/**
 * Get the Kysely table interface name from the entity.
 * Converts schema.table to PascalCase: app_public.users -> AppPublicUsers
 * Uses the inflection utility to match kysely-codegen's naming convention.
 */
const getTableTypeName = (entity: TableEntity): string =>
  `${inflect.pascalCase(entity.schemaName)}${inflect.pascalCase(entity.pgName)}`

/** Get the schema-qualified table name for Kysely */
const getTableRef = (entity: TableEntity): string =>
  `${entity.schemaName}.${entity.pgName}`

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
// CRUD Method Generators
// ============================================================================

/**
 * Generate findById method:
 * findById: (db, id) => db.selectFrom('table').selectAll().where('id', '=', id).executeTakeFirst()
 */
const generateFindById = (ctx: GenerationContext): n.ObjectProperty | undefined => {
  const { entity, executeQueries } = ctx
  if (!entity.primaryKey || !entity.permissions.canSelect) return undefined

  const pkColName = entity.primaryKey.columns[0]!
  const pkField = findRowField(entity, pkColName)
  if (!pkField) return undefined

  const tableRef = getTableRef(entity)
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

  return objProp("findById", fn)
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
 * listMany: (db, limit = 50, offset = 0) => db.selectFrom('table').selectAll()
 *   .limit(limit).offset(offset).execute()
 */
const generateListMany = (ctx: GenerationContext): n.ObjectProperty | undefined => {
  const { entity, executeQueries } = ctx
  if (!entity.permissions.canSelect) return undefined

  const tableRef = getTableRef(entity)

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

  return objProp("listMany", fn)
}

/**
 * Generate create method:
 * create: (db, data) => db.insertInto('table').values(data).returningAll().executeTakeFirstOrThrow()
 */
const generateCreate = (ctx: GenerationContext): n.ObjectProperty | undefined => {
  const { entity, executeQueries } = ctx
  if (!entity.permissions.canInsert) return undefined

  const tableRef = getTableRef(entity)
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

  return objProp("create", fn)
}

/**
 * Generate update method:
 * update: (db, id, data) => db.updateTable('table').set(data).where('id', '=', id).returningAll().executeTakeFirstOrThrow()
 */
const generateUpdate = (ctx: GenerationContext): n.ObjectProperty | undefined => {
  const { entity, executeQueries } = ctx
  if (!entity.primaryKey || !entity.permissions.canUpdate) return undefined

  const pkColName = entity.primaryKey.columns[0]!
  const pkField = findRowField(entity, pkColName)
  if (!pkField) return undefined

  const tableRef = getTableRef(entity)
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

  return objProp("update", fn)
}

/**
 * Generate delete method:
 * delete: (db, id) => db.deleteFrom('table').where('id', '=', id).execute()
 */
const generateDelete = (ctx: GenerationContext): n.ObjectProperty | undefined => {
  const { entity, executeQueries } = ctx
  if (!entity.primaryKey || !entity.permissions.canDelete) return undefined

  const pkColName = entity.primaryKey.columns[0]!
  const pkField = findRowField(entity, pkColName)
  if (!pkField) return undefined

  const tableRef = getTableRef(entity)
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

  // Use 'remove' since 'delete' is a reserved word
  return objProp("remove", fn)
}

/** Generate all CRUD methods for an entity */
const generateCrudMethods = (ctx: GenerationContext): readonly n.ObjectProperty[] =>
  [
    generateFindById(ctx),
    ctx.generateListMany ? generateListMany(ctx) : undefined,
    generateCreate(ctx),
    generateUpdate(ctx),
    generateDelete(ctx),
  ].filter((p): p is n.ObjectProperty => p != null)

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
 * Generate a method name for an index-based lookup.
 * Uses semantic naming when the column corresponds to an FK relation.
 */
const generateLookupName = (
  entity: TableEntity,
  index: IndexDef,
  relation: Relation | undefined
): string => {
  const isUnique = isUniqueLookup(entity, index)
  // Kysely uses "findBy" prefix consistently, with "One" or "Many" suffix
  const prefix = isUnique ? "findOneBy" : "findManyBy"

  // Use semantic name if FK relation exists, otherwise fall back to column name
  const columnName = index.columnNames[0]!
  const byName = relation
    ? deriveSemanticName(relation, columnName)
    : index.columns[0]!

  return `${prefix}${toPascalCase(byName)}`
}

/**
 * Generate a lookup method for a single-column index.
 * Uses semantic parameter naming when the column corresponds to an FK relation.
 */
const generateLookupMethod = (index: IndexDef, ctx: GenerationContext): n.ObjectProperty => {
  const { entity, executeQueries } = ctx
  const tableRef = getTableRef(entity)
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

  const methodName = generateLookupName(entity, index, relation)
  return objProp(methodName, fn)
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
const generateLookupMethods = (ctx: GenerationContext): readonly n.ObjectProperty[] => {
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
// Plugin Definition
// ============================================================================

export const kyselyQueriesPlugin = definePlugin({
  name: "kysely-queries",
  provides: ["queries", "queries:kysely"],
  requires: [],  // No dependency on types:kysely for now - uses external kysely-codegen types
  configSchema: KyselyQueriesPluginConfig,
  inflection: {
    outputFile: ctx => `${ctx.entityName}.ts`,
    symbolName: (entityName, artifactKind) => `${entityName}${artifactKind}`,
  },

  run: (ctx, config) => {
    const enums = getEnumEntities(ctx.ir)
    const dbTypesPath = config.dbTypesPath ?? "../DB.js"
    const executeQueries = config.executeQueries ?? true
    const generateListMany = config.generateListMany ?? false

    getTableEntities(ctx.ir)
      .filter(entity => entity.tags.omit !== true)
      .forEach(entity => {
        const genCtx: GenerationContext = { entity, enums, ir: ctx.ir, dbTypesPath, executeQueries, generateListMany }
        
        const methods = [...generateCrudMethods(genCtx), ...generateLookupMethods(genCtx)]

        if (methods.length === 0) return

        const entityName = ctx.inflection.entityName(entity.pgClass, entity.tags)
        const fileNameCtx: FileNameContext = {
          entityName,
          pgName: entity.pgName,
          schema: entity.schemaName,
          inflection: ctx.inflection,
          entity,
        }
        const filePath = `${config.outputDir}/${ctx.pluginInflection.outputFile(fileNameCtx)}`

        // Build the namespace object: export const users = { findById, findMany, ... }
        const namespaceObj = b.objectExpression(
          methods.map(m => m as Parameters<typeof b.objectExpression>[0][0])
        )

        // Lowercase entity name for the namespace variable
        const namespaceName = entity.pgName

        const constDecl = b.variableDeclaration("const", [
          b.variableDeclarator(id(namespaceName), namespaceObj)
        ])
        const exportDecl = b.exportNamedDeclaration(constDecl, []) as n.Statement

        const file = ctx
          .file(filePath)
          .header(
            config.header ? `${config.header}\n` : "// This file is auto-generated. Do not edit.\n"
          )

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

        file.ast(conjure.program(exportDecl)).emit()
      })
  },
})

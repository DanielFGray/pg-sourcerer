/**
 * Query Artifact Builder
 *
 * Builds QueryArtifact data structures for entities.
 * This is the shared core logic that both sql-queries and effect plugins consume.
 *
 * The artifact contains:
 * - SQL template parts (strings + parameter names)
 * - Query metadata (kind, params, returns)
 *
 * Consumers render these to their specific output format:
 * - sql-queries: async functions with await sql`...`
 * - effect: Effect services with sql`...` (no await)
 */
import type { TableEntity, IndexDef, Relation, Field, EnumEntity, SemanticIR, Shape } from "../ir/semantic-ir.js"
import type { QueryArtifact, QueryImplementation, SqlTemplate, QueryMethod, QueryMethodParam, MutationFieldInfo } from "../ir/extensions/queries.js"
import { resolveFieldType } from "../lib/field-utils.js"

// ============================================================================
// Types
// ============================================================================

export interface BuildContext {
  readonly entity: TableEntity
  readonly enums: readonly EnumEntity[]
  readonly ir: SemanticIR
  readonly entityName: string
  /** Use explicit column lists instead of SELECT * */
  readonly explicitColumns: boolean
}

// ============================================================================
// Helpers
// ============================================================================

/** Find a field in the row shape by column name */
const findRowField = (entity: TableEntity, columnName: string): Field | undefined =>
  entity.shapes.row.fields.find(f => f.columnName === columnName)

/** Build SELECT clause - either explicit columns or * */
const buildSelectClause = (entity: TableEntity, explicitColumns: boolean): string => {
  if (!explicitColumns) return "select *"

  const columns = entity.shapes.row.fields
    .map(f => f.columnName)
    .join(", ")

  return `select ${columns}`
}

/** Get TypeScript type string for a field */
const getFieldTypeString = (field: Field | undefined, ctx: BuildContext): string => {
  if (!field) return "unknown"
  const resolved = resolveFieldType(field, ctx.enums, ctx.ir.extensions)
  return resolved.enumDef ? resolved.enumDef.name : resolved.tsType
}

/** Convert camelCase to PascalCase */
const toPascalCase = (s: string): string =>
  s.charAt(0).toUpperCase() + s.slice(1)

/** Find relation for a column (for semantic naming) */
const findRelationForColumn = (entity: TableEntity, columnName: string): Relation | undefined =>
  entity.relations.find(
    r => r.kind === "belongsTo" && r.columns.length === 1 && r.columns[0]?.local === columnName
  )

/** Derive semantic name from relation */
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
 * Build MutationFieldInfo array from a shape's insertable/updatable fields.
 * Used for $insert/$update marker expansion.
 */
const buildMutationFields = (
  shape: Shape,
  mode: "insert" | "update"
): MutationFieldInfo[] => {
  const fields = mode === "insert"
    ? shape.fields.filter(f => f.permissions.canInsert)
    : shape.fields.filter(f => f.permissions.canUpdate)

  return fields.map(f => ({
    name: f.name,
    columnName: f.columnName,
    optional: f.optional || f.nullable,
  }))
}

// ============================================================================
// Query Builders
// ============================================================================

/** Build findById query */
const buildFindById = (ctx: BuildContext): QueryImplementation | undefined => {
  const { entity, entityName, explicitColumns } = ctx
  if (!entity.primaryKey || !entity.permissions.canSelect) return undefined

  const pkColName = entity.primaryKey.columns[0]!
  const pkField = findRowField(entity, pkColName)
  if (!pkField) return undefined

  const rowType = entity.shapes.row.name
  const fieldName = pkField.name
  const selectClause = buildSelectClause(entity, explicitColumns)

  const sql: SqlTemplate = {
    templateParts: [
      `${selectClause} from ${entity.schemaName}.${entity.pgName} where ${pkColName} = `,
      "",
    ],
    paramNames: [fieldName],
  }

  const method: QueryMethod = {
    name: `find${entityName}ById`,
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
  }

  return { method, sql }
}

/** Build findMany query with pagination */
const buildFindMany = (ctx: BuildContext): QueryImplementation | undefined => {
  const { entity, entityName, explicitColumns } = ctx
  if (!entity.permissions.canSelect) return undefined

  const rowType = entity.shapes.row.name
  const selectClause = buildSelectClause(entity, explicitColumns)

  const sql: SqlTemplate = {
    templateParts: [
      `${selectClause} from ${entity.schemaName}.${entity.pgName} limit `,
      ` offset `,
      "",
    ],
    paramNames: ["limit", "offset"],
  }

  const method: QueryMethod = {
    name: `find${entityName}s`,
    kind: "list",
    params: [
      { name: "limit", type: "number", required: false, source: "pagination" },
      { name: "offset", type: "number", required: false, source: "pagination" },
    ],
    returns: { type: rowType, nullable: false, isArray: true },
    callSignature: { style: "named" },
  }

  return { method, sql }
}

/** Build insert query */
const buildInsert = (ctx: BuildContext): QueryImplementation | undefined => {
  const { entity, entityName } = ctx
  if (!entity.permissions.canInsert) return undefined

  const rowType = entity.shapes.row.name
  const insertShape = entity.shapes.insert ?? entity.shapes.row
  const insertType = insertShape.name

  // Build field info for adapters that expand $insert to field-by-field
  const insertFields = buildMutationFields(insertShape, "insert")
  if (insertFields.length === 0) return undefined

  // For insert, we use sql.insert() helper OR field expansion
  // Template: INSERT INTO table ${sql.insert(data)} RETURNING *
  const sql: SqlTemplate = {
    templateParts: [
      `insert into ${entity.schemaName}.${entity.pgName} `,
      " returning *",
    ],
    paramNames: ["$insert"], // Special marker for sql.insert(data)
    insertFields,
  }

  const method: QueryMethod = {
    name: `insert${entityName}`,
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
    callSignature: { style: "named", bodyStyle: "property" },
  }

  return { method, sql }
}

/** Build update query */
const buildUpdate = (ctx: BuildContext): QueryImplementation | undefined => {
  const { entity, entityName } = ctx
  if (!entity.primaryKey || !entity.permissions.canUpdate) return undefined

  const pkColName = entity.primaryKey.columns[0]!
  const pkField = findRowField(entity, pkColName)
  if (!pkField) return undefined

  const rowType = entity.shapes.row.name
  const updateShape = entity.shapes.update ?? entity.shapes.row
  const updateType = updateShape.name
  const fieldName = pkField.name

  // Build field info for adapters that expand $update to field-by-field
  const updateFields = buildMutationFields(updateShape, "update")

  // Template: UPDATE table SET ${sql.update(data)} WHERE pk = ${id} RETURNING *
  const sql: SqlTemplate = {
    templateParts: [
      `update ${entity.schemaName}.${entity.pgName} set `,
      ` where ${pkColName} = `,
      " returning *",
    ],
    paramNames: ["$update", fieldName], // $update is special marker for sql.update(data)
    updateFields,
  }

  const method: QueryMethod = {
    name: `update${entityName}`,
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
    returns: { type: rowType, nullable: true, isArray: false },
    callSignature: { style: "named", bodyStyle: "spread" },
  }

  return { method, sql }
}

/** Build delete query */
const buildDelete = (ctx: BuildContext): QueryImplementation | undefined => {
  const { entity, entityName } = ctx
  if (!entity.primaryKey || !entity.permissions.canDelete) return undefined

  const pkColName = entity.primaryKey.columns[0]!
  const pkField = findRowField(entity, pkColName)
  if (!pkField) return undefined

  const rowType = entity.shapes.row.name
  const fieldName = pkField.name

  const sql: SqlTemplate = {
    templateParts: [
      `delete from ${entity.schemaName}.${entity.pgName} where ${pkColName} = `,
      " returning *",
    ],
    paramNames: [fieldName],
  }

  const method: QueryMethod = {
    name: `delete${entityName}`,
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
    returns: { type: rowType, nullable: true, isArray: false },
    callSignature: { style: "named" },
  }

  return { method, sql }
}

/** Check if an index should generate a lookup query */
const shouldGenerateLookup = (index: IndexDef): boolean =>
  !index.isPartial &&
  !index.hasExpressions &&
  index.columns.length === 1 &&
  index.method !== "gin" &&
  index.method !== "gist"

/** Build a lookup query for an index */
const buildLookup = (index: IndexDef, ctx: BuildContext): QueryImplementation | undefined => {
  const { entity, entityName, explicitColumns } = ctx
  const columnName = index.columnNames[0]!
  const field = findRowField(entity, columnName)
  const fieldName = field?.name ?? index.columns[0]!
  const isUnique = index.isUnique || index.isPrimary

  const relation = findRelationForColumn(entity, columnName)
  const paramName = relation ? deriveSemanticName(relation, columnName) : fieldName

  const rowType = entity.shapes.row.name
  const selectClause = buildSelectClause(entity, explicitColumns)

  const sql: SqlTemplate = {
    templateParts: [
      `${selectClause} from ${entity.schemaName}.${entity.pgName} where ${columnName} = `,
      "",
    ],
    paramNames: [paramName],
  }

  const prefix = isUnique ? "get" : "gets"
  const byName = relation ? deriveSemanticName(relation, columnName) : fieldName

  const method: QueryMethod = {
    name: `${prefix}${entityName}By${toPascalCase(byName)}`,
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
  }

  return { method, sql }
}

/** Build lookup queries for all eligible indexes */
const buildLookups = (ctx: BuildContext): readonly QueryImplementation[] => {
  const seen = new Set<string>()

  return ctx.entity.indexes
    .filter(index => shouldGenerateLookup(index) && !index.isPrimary)
    .map(index => buildLookup(index, ctx))
    .filter((q): q is QueryImplementation => {
      if (!q) return false
      if (seen.has(q.method.name)) return false
      seen.add(q.method.name)
      return true
    })
}

// ============================================================================
// Main Builder
// ============================================================================

/**
 * Build a QueryArtifact for an entity.
 *
 * This contains all the query implementations (SQL templates + metadata)
 * that can be rendered by sql-queries, effect, or other plugins.
 *
 * Note: No unbounded SELECT queries - all list queries require pagination.
 */
export function buildQueryArtifact(ctx: BuildContext): QueryArtifact {
  const { entity, entityName } = ctx

  const queries: QueryImplementation[] = [
    buildFindById(ctx),
    buildFindMany(ctx),
    buildInsert(ctx),
    buildUpdate(ctx),
    buildDelete(ctx),
    ...buildLookups(ctx),
  ].filter((q): q is QueryImplementation => q != null)

  const insertShape = entity.shapes.insert ?? entity.shapes.row
  const updateShape = entity.shapes.update ?? entity.shapes.row

  return {
    entityName,
    tableName: entity.pgName,
    schemaName: entity.schemaName,
    pkColumn: entity.primaryKey?.columns[0],
    rowType: entity.shapes.row.name,
    insertType: insertShape !== entity.shapes.row ? insertShape.name : undefined,
    updateType: updateShape !== entity.shapes.row ? updateShape.name : undefined,
    queries,
  }
}

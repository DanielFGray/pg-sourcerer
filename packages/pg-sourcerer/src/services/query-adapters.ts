/**
 * Query Adapters
 *
 * Adapters that transform QueryArtifact/SqlTemplate into plugin-specific formats.
 *
 * sql-queries adapter: Expands $insert/$update to field-by-field SQL
 * effect adapter: Converts $insert/$update to sql.insert()/sql.update() helpers
 */
import type { namedTypes as n } from "ast-types"
import type { SqlTemplate, MutationFieldInfo } from "../ir/extensions/queries.js"
import type { QueryParts } from "../lib/hex.js"
import { hex } from "../lib/hex.js"
import { conjure } from "../lib/conjure.js"

const { b } = conjure

// ============================================================================
// sql-queries Adapter (Field Expansion)
// ============================================================================

/**
 * Expand $insert marker to field-by-field INSERT SQL.
 *
 * Input template:  ["insert into table ", " returning *"]
 * Input paramNames: ["$insert"]
 *
 * Output: {
 *   templateParts: ["insert into table (col1, col2) values (", ", ", ") returning *"],
 *   params: [field1Expr, field2Expr]
 * }
 */
function expandInsertMarker(
  template: SqlTemplate,
  tablePart: string,
): QueryParts {
  const fields = template.insertFields ?? []
  if (fields.length === 0) {
    throw new Error("Cannot expand $insert: no insertFields provided")
  }

  // Build column list: (col1, col2, col3)
  const columnList = fields.map(f => f.columnName).join(", ")

  // Build value placeholders and params
  // For optional fields, use hex.defaultIfUndefined
  const paramExprs: n.Expression[] = fields.map(f =>
    f.optional ? hex.defaultIfUndefined(f.name) : b.identifier(f.name)
  )

  // Build template parts: "... (cols) values (" + "" + ", " + ", " + ... + ") returning *"
  const valueSeparators = fields.map((_, i) => (i === 0 ? "" : ", "))
  const templateParts = [
    `${tablePart}(${columnList}) values (`,
    ...valueSeparators.slice(1),
    `) returning *`,
  ]

  return { templateParts, params: paramExprs }
}

/**
 * Expand $update marker to field-by-field UPDATE SQL.
 *
 * Note: sql-queries currently doesn't generate update methods,
 * but this is here for future use.
 *
 * Input template:  ["update table set ", " where id = ", " returning *"]
 * Input paramNames: ["$update", "id"]
 *
 * Output: UPDATE table SET col1 = $1, col2 = $2 WHERE id = $3 RETURNING *
 */
function expandUpdateMarker(
  template: SqlTemplate,
  setPart: string,
  afterParts: readonly string[],
  afterParams: readonly string[],
): QueryParts {
  const fields = template.updateFields ?? []
  if (fields.length === 0) {
    throw new Error("Cannot expand $update: no updateFields provided")
  }

  // Build SET clause: col1 = ${field1}, col2 = ${field2}
  // Each field becomes a template part + param
  const setClauseParts: string[] = []
  const setParams: n.Expression[] = []

  fields.forEach((f, i) => {
    if (i === 0) {
      setClauseParts.push(`${setPart}${f.columnName} = `)
    } else {
      setClauseParts.push(`, ${f.columnName} = `)
    }
    setParams.push(b.identifier(f.name))
  })

  // Append remaining template parts and params (WHERE clause, etc.)
  const templateParts = [...setClauseParts, ...afterParts]
  const params = [...setParams, ...afterParams.map(p => b.identifier(p))]

  return { templateParts, params }
}

/**
 * Convert SqlTemplate to QueryParts for sql-queries style output.
 *
 * Handles:
 * - $insert marker: Expands to field-by-field INSERT with hex.defaultIfUndefined
 * - $update marker: Expands to field-by-field UPDATE
 * - Regular params: Converts to b.identifier(name)
 */
export function sqlTemplateToQueryParts(template: SqlTemplate): QueryParts {
  const { templateParts, paramNames } = template

  // Check for $insert marker
  const insertIdx = paramNames.indexOf("$insert")
  if (insertIdx !== -1) {
    // For insert: templateParts[0] is "insert into schema.table "
    return expandInsertMarker(template, templateParts[0]!)
  }

  // Check for $update marker
  const updateIdx = paramNames.indexOf("$update")
  if (updateIdx !== -1) {
    // templateParts[0] is "update schema.table set "
    // templateParts[1+] and paramNames[1+] are the WHERE clause parts
    const afterParts = templateParts.slice(1)
    const afterParams = paramNames.slice(1)
    return expandUpdateMarker(template, templateParts[0]!, afterParts, afterParams)
  }

  // No special markers - simple conversion
  return {
    templateParts,
    params: paramNames.map(name => b.identifier(name)),
  }
}

// ============================================================================
// Effect Adapter (sql.insert/sql.update helpers)
// ============================================================================

/**
 * Convert SqlTemplate to QueryParts for Effect style output.
 *
 * Handles:
 * - $insert marker: Converts to sql.insert(data) call
 * - $update marker: Converts to sql.update(data) call
 * - Regular params: Converts to b.identifier(name)
 */
export function sqlTemplateToEffectParts(template: SqlTemplate): QueryParts {
  const params: n.Expression[] = template.paramNames.map(name => {
    if (name === "$insert") {
      // sql.insert(data)
      return b.callExpression(
        b.memberExpression(b.identifier("sql"), b.identifier("insert")),
        [b.identifier("data")]
      )
    }
    if (name === "$update") {
      // sql.update(data)
      return b.callExpression(
        b.memberExpression(b.identifier("sql"), b.identifier("update")),
        [b.identifier("data")]
      )
    }
    return b.identifier(name)
  })

  return {
    templateParts: template.templateParts,
    params,
  }
}

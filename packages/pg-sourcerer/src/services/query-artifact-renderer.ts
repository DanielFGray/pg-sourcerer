/**
 * Query Artifact Renderer
 *
 * Converts QueryArtifact/QueryImplementation to AST for sql-queries plugin.
 * Bridges the gap between data-only SqlTemplate and AST-based QueryParts.
 */
import type { namedTypes as n } from "ast-types"
import type { QueryImplementation, SqlTemplate, QueryMethod } from "../ir/extensions/queries.js"
import { conjure } from "../lib/conjure.js"
import { hex, type SqlStyle, type QueryParts } from "../lib/hex.js"

const { ts, b, param, asyncFn } = conjure

// ============================================================================
// Types
// ============================================================================

/**
 * A rendered query method ready for code generation.
 * Matches the MethodDef type used in sql-queries.
 */
export interface RenderedMethod {
  /** Export name */
  readonly name: string
  /** AST for the async function */
  readonly fn: n.FunctionDeclaration
  /** Query metadata for HTTP consumers */
  readonly meta: QueryMethod
}

export interface RenderContext {
  /** SQL style for code generation */
  readonly sqlStyle: SqlStyle
  /** Row type name for this entity */
  readonly rowType: string
  /** Insert type name (if different from row) */
  readonly insertType?: string
  /** Update type name (if different from row) */
  readonly updateType?: string
}

// ============================================================================
// SqlTemplate -> QueryParts Conversion
// ============================================================================

/**
 * Convert SqlTemplate (data) to QueryParts (AST).
 *
 * Handles special parameter markers:
 * - $insert: sql.insert(data)
 * - $update: sql.update(data)
 * - Regular params: b.identifier(name)
 */
export function sqlTemplateToQueryParts(template: SqlTemplate): QueryParts {
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

// ============================================================================
// Query Method Renderers
// ============================================================================

/**
 * Render a read/lookup query that returns a single row (nullable).
 * Pattern: extract first row, return it
 */
function renderSingleRowQuery(
  impl: QueryImplementation,
  ctx: RenderContext
): RenderedMethod {
  const { method, sql } = impl
  const { sqlStyle, rowType } = ctx

  const parts = sqlTemplateToQueryParts(sql)
  const queryExpr = hex.query(sqlStyle, parts, ts.array(ts.ref(rowType)))
  const varDecl = hex.firstRowDecl(sqlStyle, "result", queryExpr)

  // Build parameter from method.params
  const paramNode = buildParamNode(method)

  const fn = asyncFn(
    method.name,
    paramNode ? [paramNode] : [],
    [varDecl, b.returnStatement(b.identifier("result"))]
  )

  return { name: method.name, fn, meta: method }
}

/**
 * Render a list query that returns an array of rows.
 * Pattern: return query result directly
 */
function renderArrayQuery(
  impl: QueryImplementation,
  ctx: RenderContext
): RenderedMethod {
  const { method, sql } = impl
  const { sqlStyle, rowType } = ctx

  const parts = sqlTemplateToQueryParts(sql)
  const paramNode = buildParamNode(method)

  const fn = asyncFn(
    method.name,
    paramNode ? [paramNode] : [],
    hex.returnQuery(sqlStyle, parts, ts.array(ts.ref(rowType)))
  )

  return { name: method.name, fn, meta: method }
}

/**
 * Render a create query that inserts and returns the new row.
 * Pattern: insert with RETURNING *, return first row
 */
function renderCreateQuery(
  impl: QueryImplementation,
  ctx: RenderContext
): RenderedMethod {
  const { method, sql } = impl
  const { sqlStyle, rowType, insertType } = ctx

  const parts = sqlTemplateToQueryParts(sql)
  const queryExpr = hex.query(sqlStyle, parts, ts.array(ts.ref(rowType)))
  const varDecl = hex.firstRowDecl(sqlStyle, "result", queryExpr)

  // Use insertType for the data parameter type
  const dataType = insertType ?? rowType
  const paramNode = param.destructured([{ name: "data", type: ts.ref(dataType) }])

  const fn = asyncFn(
    method.name,
    [paramNode],
    [varDecl, b.returnStatement(b.identifier("result"))]
  )

  return { name: method.name, fn, meta: method }
}

/**
 * Render an update query.
 * Pattern: update with RETURNING *, return first row
 */
function renderUpdateQuery(
  impl: QueryImplementation,
  ctx: RenderContext
): RenderedMethod {
  const { method, sql } = impl
  const { sqlStyle, rowType, updateType } = ctx

  const parts = sqlTemplateToQueryParts(sql)
  const queryExpr = hex.query(sqlStyle, parts, ts.array(ts.ref(rowType)))
  const varDecl = hex.firstRowDecl(sqlStyle, "result", queryExpr)

  // Find the PK param and data param
  const pkParam = method.params.find(p => p.source === "pk")
  const dataParam = method.params.find(p => p.source === "body")

  const paramFields: { name: string; type: n.TSType }[] = []
  if (pkParam) {
    paramFields.push({ name: pkParam.name, type: ts.ref(pkParam.type) })
  }
  if (dataParam) {
    const dataType = updateType ?? rowType
    paramFields.push({ name: "data", type: ts.ref(dataType) })
  }

  const paramNode = param.destructured(paramFields)

  const fn = asyncFn(
    method.name,
    [paramNode],
    [varDecl, b.returnStatement(b.identifier("result"))]
  )

  return { name: method.name, fn, meta: method }
}

/**
 * Render a delete query.
 * Pattern: delete with RETURNING *, return first row (or undefined)
 */
function renderDeleteQuery(
  impl: QueryImplementation,
  ctx: RenderContext
): RenderedMethod {
  const { method, sql } = impl
  const { sqlStyle, rowType } = ctx

  const parts = sqlTemplateToQueryParts(sql)
  const queryExpr = hex.query(sqlStyle, parts, ts.array(ts.ref(rowType)))
  const varDecl = hex.firstRowDecl(sqlStyle, "result", queryExpr)

  const paramNode = buildParamNode(method)

  const fn = asyncFn(
    method.name,
    paramNode ? [paramNode] : [],
    [varDecl, b.returnStatement(b.identifier("result"))]
  )

  return { name: method.name, fn, meta: method }
}

// ============================================================================
// Parameter Building
// ============================================================================

/**
 * Build a parameter node from QueryMethod.params.
 * Uses destructured style for named parameters.
 */
function buildParamNode(method: QueryMethod): n.ObjectPattern | undefined {
  const params = method.params.filter(p => p.source !== "body")
  if (params.length === 0) return undefined

  const fields = params.map(p => ({
    name: p.name,
    type: ts.ref(p.type),
    optional: !p.required,
    // Add default values for pagination params
    defaultValue: p.source === "pagination"
      ? (p.name === "limit" ? b.numericLiteral(50) : b.numericLiteral(0))
      : undefined,
  }))

  return param.destructured(fields)
}

// ============================================================================
// Main Renderer
// ============================================================================

/**
 * Render a QueryImplementation to an AST function.
 */
export function renderQueryImplementation(
  impl: QueryImplementation,
  ctx: RenderContext
): RenderedMethod {
  const { method } = impl

  switch (method.kind) {
    case "read":
      return renderSingleRowQuery(impl, ctx)
    case "list":
      return method.returns.isArray
        ? renderArrayQuery(impl, ctx)
        : renderSingleRowQuery(impl, ctx)
    case "create":
      return renderCreateQuery(impl, ctx)
    case "update":
      return renderUpdateQuery(impl, ctx)
    case "delete":
      return renderDeleteQuery(impl, ctx)
    case "lookup":
      return method.isUniqueLookup
        ? renderSingleRowQuery(impl, ctx)
        : renderArrayQuery(impl, ctx)
    case "function":
      // Functions are handled separately
      return renderArrayQuery(impl, ctx)
    default:
      return renderArrayQuery(impl, ctx)
  }
}

/**
 * Render all queries from a QueryArtifact.
 */
export function renderQueryArtifact(
  queries: readonly QueryImplementation[],
  ctx: RenderContext
): readonly RenderedMethod[] {
  return queries.map(impl => renderQueryImplementation(impl, ctx))
}

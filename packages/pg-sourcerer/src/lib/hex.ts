/**
 * Hex - SQL Query Building Primitives
 *
 * Provides AST builders for generating SQL query code in two styles:
 * - "tag": Tagged template literals (postgres.js, @effect/sql style)
 * - "string": Parameterized queries (node-postgres, mysql2 style)
 *
 * @example
 * ```typescript
 * import { hex } from "../lib/hex.js"
 *
 * // Tag style: sql<User[]>`select * from users where id = ${id}`
 * const query = hex.query("tag", {
 *   templateParts: ["select * from users where id = ", ""],
 *   params: [b.identifier("id")],
 * }, ts.array(ts.ref("User")))
 *
 * // String style: pool.query<User[]>("select * from users where id = $1", [id])
 * const query = hex.query("string", { ... })
 * ```
 */
import type { namedTypes as n } from "ast-types"
import { conjure, cast } from "./conjure.js"

const { ts, b } = conjure
const { toExpr, toTSType } = cast

// =============================================================================
// Types
// =============================================================================

/**
 * SQL query style:
 * - "tag": Tagged template literals (e.g., postgres.js, @effect/sql)
 *   Generates: sql<Type[]>`select * from users where id = ${id}`
 * - "string": Parameterized query strings (e.g., pg, mysql2, better-sqlite3)
 *   Generates: pool.query<Type[]>("select * from users where id = $1", [id])
 */
export type SqlStyle = "tag" | "string"

/**
 * Query template parts and parameters.
 */
export interface QueryParts {
  /** SQL template parts (for tag) or joined with $N placeholders (for string) */
  readonly templateParts: readonly string[]
  /** Parameter expressions to interpolate */
  readonly params: readonly n.Expression[]
}

// =============================================================================
// Template Literal Builders
// =============================================================================

/**
 * Build a template literal AST node from parts and expressions.
 *
 * @example
 * buildTemplateLiteral(["select * from users where id = ", ""], [idExpr])
 * // `select * from users where id = ${id}`
 */
export function buildTemplateLiteral(
  parts: readonly string[],
  exprs: readonly n.Expression[]
): n.TemplateLiteral {
  return b.templateLiteral(
    parts.map((raw, i) =>
      b.templateElement({ raw, cooked: raw }, i === parts.length - 1)
    ),
    exprs.map(toExpr)
  )
}

// =============================================================================
// Tag Style (sql`...`)
// =============================================================================

/**
 * Build await expression for sql tagged template with optional type parameter.
 *
 * Generates: await sql<Type[]>`select * from users`
 */
export function buildAwaitSqlTag(
  sqlTemplate: n.TemplateLiteral,
  typeParam?: n.TSType
): n.AwaitExpression {
  const sqlId = b.identifier("sql")
  // If type parameter provided, wrap in TSInstantiationExpression: sql<Type>
  const tag = typeParam
    ? b.tsInstantiationExpression(
        sqlId,
        b.tsTypeParameterInstantiation([toTSType(typeParam)])
      )
    : sqlId
  return b.awaitExpression(b.taggedTemplateExpression(tag, sqlTemplate))
}

// =============================================================================
// String Style (pool.query(...))
// =============================================================================

/**
 * Build await expression for pool.query() with parameterized query.
 *
 * Generates: await pool.query<Type>("SELECT ... WHERE id = $1", [id])
 */
export function buildAwaitSqlString(
  sqlText: string,
  params: readonly n.Expression[],
  typeParam?: n.TSType
): n.AwaitExpression {
  const poolQuery = b.memberExpression(b.identifier("pool"), b.identifier("query"))

  // Add type parameter if provided: pool.query<Type>
  const callee = typeParam
    ? b.tsInstantiationExpression(
        poolQuery,
        b.tsTypeParameterInstantiation([toTSType(typeParam)])
      )
    : poolQuery

  // Build arguments: ('sql text', [param1, param2])
  const args: n.Expression[] = [b.stringLiteral(sqlText)]
  if (params.length > 0) {
    args.push(b.arrayExpression(params.map(toExpr)))
  }

  return b.awaitExpression(b.callExpression(callee, args.map(toExpr)))
}

// =============================================================================
// Unified Query Builder
// =============================================================================

/**
 * Build a SQL query expression for the given style.
 *
 * For tag style: uses template literals with interpolated values
 * For string style: uses parameterized queries with $1, $2, ... placeholders
 */
export function buildQuery(
  sqlStyle: SqlStyle,
  parts: QueryParts,
  typeParam?: n.TSType
): n.AwaitExpression {
  if (sqlStyle === "tag") {
    const template = buildTemplateLiteral(parts.templateParts, parts.params)
    return buildAwaitSqlTag(template, typeParam)
  } else {
    // For string style, join template parts with $1, $2, ... placeholders
    const sqlText = parts.templateParts
      .map((part, i) => (i === 0 ? part : `$${i}${part}`))
      .join("")
    return buildAwaitSqlString(sqlText, parts.params, typeParam)
  }
}

// =============================================================================
// Result Extraction
// =============================================================================

/**
 * Build a variable declaration that extracts the first row from query result.
 *
 * tag style: const [result] = await sql<Type[]>`...`
 * string style: const { rows: [result] } = await pool.query<Type>(...)
 */
export function buildFirstRowDecl(
  sqlStyle: SqlStyle,
  varName: string,
  queryExpr: n.AwaitExpression
): n.VariableDeclaration {
  if (sqlStyle === "tag") {
    // const [result] = await sql`...`
    return b.variableDeclaration("const", [
      b.variableDeclarator(b.arrayPattern([b.identifier(varName)]), queryExpr),
    ])
  } else {
    // const { rows: [result] } = await pool.query(...)
    const rowsProp = b.objectProperty(
      b.identifier("rows"),
      b.arrayPattern([b.identifier(varName)])
    )
    return b.variableDeclaration("const", [
      b.variableDeclarator(b.objectPattern([rowsProp]), queryExpr),
    ])
  }
}

/**
 * Build a variable declaration that gets all rows from query result.
 *
 * tag style: const result = await sql<Type[]>`...`  (returns array directly)
 * string style: const { rows: result } = await pool.query<Type>(...)
 */
export function buildAllRowsDecl(
  sqlStyle: SqlStyle,
  varName: string,
  queryExpr: n.AwaitExpression
): n.VariableDeclaration {
  if (sqlStyle === "tag") {
    // tag style returns array directly
    return b.variableDeclaration("const", [
      b.variableDeclarator(b.identifier(varName), queryExpr),
    ])
  } else {
    // string style: const { rows } = await pool.query(...)
    const rowsProp = b.objectProperty(b.identifier("rows"), b.identifier(varName))
    rowsProp.shorthand = varName === "rows"
    return b.variableDeclaration("const", [
      b.variableDeclarator(b.objectPattern([rowsProp]), queryExpr),
    ])
  }
}

/**
 * Build a return statement that returns query results.
 *
 * tag style: return await sql<Type[]>`...`  (returns array directly)
 * string style: extracts .rows and returns
 */
export function buildReturnQuery(
  sqlStyle: SqlStyle,
  parts: QueryParts,
  typeParam: n.TSType
): n.Statement[] {
  const queryExpr = buildQuery(sqlStyle, parts, typeParam)

  if (sqlStyle === "tag") {
    // tag style returns array directly
    return [b.returnStatement(queryExpr)]
  } else {
    // string style: const { rows } = await pool.query(...); return rows
    const decl = buildAllRowsDecl(sqlStyle, "rows", queryExpr)
    return [decl, b.returnStatement(b.identifier("rows"))]
  }
}

// =============================================================================
// Optional Field Helpers
// =============================================================================

/**
 * Build an expression that uses DEFAULT when the field is undefined.
 * 
 * For tag style: `field !== undefined ? field : sql\`default\``
 * For string style: Uses COALESCE in SQL (handled differently at query level)
 * 
 * @example
 * buildDefaultIfUndefined("title")
 * // title !== undefined ? title : sql`default`
 */
export function buildDefaultIfUndefined(
  fieldName: string
): n.ConditionalExpression {
  // field !== undefined
  const test = b.binaryExpression(
    "!==",
    b.identifier(fieldName),
    b.identifier("undefined")
  )
  
  // sql`default`
  const sqlDefault = b.taggedTemplateExpression(
    b.identifier("sql"),
    b.templateLiteral(
      [b.templateElement({ raw: "default", cooked: "default" }, true)],
      []
    )
  )
  
  // field !== undefined ? field : sql`default`
  return b.conditionalExpression(
    test,
    b.identifier(fieldName),
    sqlDefault
  )
}

// =============================================================================
// Main API
// =============================================================================

/**
 * Hex - SQL Query Building Primitives
 *
 * A collection of AST builders for generating SQL query code.
 */
export const hex = {
  // Query building
  query: buildQuery,
  templateLiteral: buildTemplateLiteral,

  // Style-specific
  tag: {
    awaitSql: buildAwaitSqlTag,
  },
  string: {
    awaitSql: buildAwaitSqlString,
  },

  // Result extraction
  firstRowDecl: buildFirstRowDecl,
  allRowsDecl: buildAllRowsDecl,
  returnQuery: buildReturnQuery,
  
  // Optional field handling
  defaultIfUndefined: buildDefaultIfUndefined,
} as const

export default hex

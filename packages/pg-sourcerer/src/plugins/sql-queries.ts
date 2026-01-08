/**
 * SQL Queries Plugin - Generate raw SQL query functions using template strings
 */
import { Schema as S } from "effect"
import type { namedTypes as n } from "ast-types"
import { definePlugin } from "../services/plugin.js"
import type { FileNameContext } from "../services/plugin.js"
import type { Field, IndexDef, TableEntity, EnumEntity, SemanticIR } from "../ir/semantic-ir.js"
import { getTableEntities, getEnumEntities } from "../ir/semantic-ir.js"
import { conjure, cast } from "../lib/conjure.js"
import { resolveFieldType } from "../lib/field-utils.js"
import { TsType } from "../services/pg-types.js"

const { ts, b, stmt } = conjure
const toExpr = cast.toExpr
const toTSType = cast.toTSType

/**
 * Plugin configuration schema
 */
const SqlQueriesPluginConfig = S.Struct({
  outputDir: S.String,
  header: S.optional(S.String),
})

type SqlQueriesPluginConfig = S.Schema.Type<typeof SqlQueriesPluginConfig>

/**
 * Context passed to generation helpers
 */
interface GenerationContext {
  entity: TableEntity
  enums: readonly EnumEntity[]
  ir: SemanticIR
  config: SqlQueriesPluginConfig
}

/**
 * Convert TsType enum to AST type node
 */
function tsTypeToAst(tsType: TsType): n.TSType {
  switch (tsType) {
    case TsType.String:
      return ts.string()
    case TsType.Number:
      return ts.number()
    case TsType.Boolean:
      return ts.boolean()
    case TsType.BigInt:
      return ts.bigint()
    case TsType.Date:
      return ts.ref("Date")
    case TsType.Buffer:
      return ts.ref("Buffer")
    case TsType.Unknown:
    default:
      return ts.unknown()
  }
}

/**
 * Find a field in the row shape by column name
 */
function findRowField(entity: TableEntity, columnName: string): Field | undefined {
  return entity.shapes.row.fields.find((f) => f.columnName === columnName)
}

/**
 * Get the TypeScript type AST for a field, properly resolving PG types
 */
function getFieldTypeAst(field: Field | undefined, ctx: GenerationContext): n.TSType {
  if (!field) return ts.string()

  const resolved = resolveFieldType(field, ctx.enums, ctx.ir.extensions)

  // If it resolved to an enum, use the enum name
  if (resolved.enumDef) {
    return ts.ref(resolved.enumDef.name)
  }

  // Convert TsType to AST
  return tsTypeToAst(resolved.tsType)
}

/**
 * Build an object type literal for function parameters
 */
function buildParamType(props: Array<{ name: string; type: n.TSType; optional: boolean }>): n.TSType {
  const members = props.map((p) => {
    const sig = b.tsPropertySignature(b.identifier(p.name), b.tsTypeAnnotation(toTSType(p.type)))
    if (p.optional) sig.optional = true
    return sig
  })
  return b.tsTypeLiteral(members)
}

/**
 * Check if an index is unique
 */
function isUniqueIndex(index: IndexDef): boolean {
  return index.isUnique || index.isPrimary
}

/**
 * Generate a function name for an index-based lookup
 */
function generateLookupName(entity: TableEntity, index: IndexDef): string {
  const entitySingular = entity.name.replace(/s$/, "")
  const byPart = index.columns
    .map((col) => `By${col.charAt(0).toUpperCase() + col.slice(1)}`)
    .join("")
  return `get${entitySingular}${byPart}`
}

/**
 * Check if an index should generate a lookup function
 */
function shouldGenerateLookup(index: IndexDef): boolean {
  if (index.isPartial) return false
  if (index.hasExpressions) return false
  if (index.columns.length > 1) return false
  if (index.method === "gin" || index.method === "gist") return false
  return true
}

/**
 * Build SQL template literal expression
 */
function buildSqlTemplate(parts: string[], exprs: n.Expression[]): n.TemplateLiteral {
  const elements = parts.map((raw, i) =>
    b.templateElement({ raw, cooked: raw }, i === parts.length - 1)
  )
  return b.templateLiteral(elements, exprs.map(toExpr))
}

/**
 * Build await expression for sql tagged template
 */
function buildAwaitSql(sqlTemplate: n.TemplateLiteral): n.AwaitExpression {
  const taggedSql = b.taggedTemplateExpression(b.identifier("sql"), sqlTemplate)
  return b.awaitExpression(taggedSql)
}

/**
 * Wrap a type in Promise<>
 */
function wrapPromise(innerType: n.TSType): n.TSType {
  return b.tsTypeReference(b.identifier("Promise"), b.tsTypeParameterInstantiation([toTSType(innerType)]))
}

/**
 * Generate CRUD functions for an entity
 */
function generateCrudFunctions(ctx: GenerationContext): n.Statement[] {
  const { entity } = ctx
  const statements: n.Statement[] = []
  const rowType = `${entity.name}Row`
  const schema = entity.schemaName
  const table = entity.pgName

  // findById
  if (entity.primaryKey) {
    const pkColName = entity.primaryKey.columns[0]!
    const pkField = findRowField(entity, pkColName)
    if (pkField) {
      const fieldType = getFieldTypeAst(pkField, ctx)
      const paramType = buildParamType([{ name: "id", type: fieldType, optional: false }])
      const param = b.identifier("args")
      param.typeAnnotation = b.tsTypeAnnotation(toTSType(paramType))

      const sqlTemplate = buildSqlTemplate(
        [`select * from ${schema}.${table} where ${pkColName} = `, ""],
        [b.memberExpression(b.identifier("args"), b.identifier("id"), false)]
      )
      const awaitSql = buildAwaitSql(sqlTemplate)

      const varDecl = b.variableDeclaration("const", [
        b.variableDeclarator(b.arrayPattern([b.identifier("result")]), awaitSql),
      ])

      const returnType = wrapPromise(ts.union(ts.ref(rowType), ts.null()))
      const fn = b.functionDeclaration(
        b.identifier(`find${entity.name}ById`),
        [param],
        b.blockStatement([varDecl, b.returnStatement(b.identifier("result"))])
      )
      fn.async = true
      fn.returnType = b.tsTypeAnnotation(toTSType(returnType))

      statements.push(b.exportNamedDeclaration(fn, []))
    }
  }

  // findMany
  {
    const paramType = buildParamType([
      { name: "limit", type: ts.number(), optional: true },
      { name: "offset", type: ts.number(), optional: true },
    ])
    const param = b.identifier("args")
    param.typeAnnotation = b.tsTypeAnnotation(toTSType(paramType))

    const sqlTemplate = buildSqlTemplate(
      [`select * from ${schema}.${table} limit `, ` offset `, ""],
      [b.identifier("limit"), b.identifier("offset")]
    )
    const awaitSql = buildAwaitSql(sqlTemplate)

    const returnType = wrapPromise(ts.array(ts.ref(rowType)))
    const fn = b.functionDeclaration(
      b.identifier(`findMany${entity.name}s`),
      [param],
      b.blockStatement([
        stmt.const("limit", b.logicalExpression("??", b.memberExpression(b.identifier("args"), b.identifier("limit"), false), b.numericLiteral(50))),
        stmt.const("offset", b.logicalExpression("??", b.memberExpression(b.identifier("args"), b.identifier("offset"), false), b.numericLiteral(0))),
        b.returnStatement(awaitSql),
      ])
    )
    fn.async = true
    fn.returnType = b.tsTypeAnnotation(toTSType(returnType))

    statements.push(b.exportNamedDeclaration(fn, []))
  }

  // delete
  if (entity.primaryKey) {
    const pkColName = entity.primaryKey.columns[0]!
    const pkField = findRowField(entity, pkColName)
    if (pkField) {
      const fieldType = getFieldTypeAst(pkField, ctx)
      const param = b.identifier("args")
      param.typeAnnotation = b.tsTypeAnnotation(
        toTSType(buildParamType([{ name: "id", type: fieldType, optional: false }]))
      )

      const sqlTemplate = buildSqlTemplate(
        [`delete from ${schema}.${table} where ${pkColName} = `, ""],
        [b.memberExpression(b.identifier("args"), b.identifier("id"), false)]
      )
      const awaitSql = buildAwaitSql(sqlTemplate)

      const returnType = wrapPromise(ts.void())
      const fn = b.functionDeclaration(
        b.identifier(`delete${entity.name}`),
        [param],
        b.blockStatement([b.expressionStatement(awaitSql)])
      )
      fn.async = true
      fn.returnType = b.tsTypeAnnotation(toTSType(returnType))

      statements.push(b.exportNamedDeclaration(fn, []))
    }
  }

  return statements
}

/**
 * Generate index-based lookup functions
 */
function generateLookupFunctions(ctx: GenerationContext): n.Statement[] {
  const { entity } = ctx
  const statements: n.Statement[] = []
  const rowType = `${entity.name}Row`
  const schema = entity.schemaName
  const table = entity.pgName
  const seenNames = new Set<string>()

  for (const index of entity.indexes) {
    if (!shouldGenerateLookup(index)) continue
    if (index.isPrimary) continue

    const fnName = generateLookupName(entity, index)

    // Skip duplicates (same function name from multiple indexes on same column)
    if (seenNames.has(fnName)) continue
    seenNames.add(fnName)

    const columnName = index.columnNames[0]!
    const paramName = index.columns[0]!
    const field = findRowField(entity, paramName)
    const fieldType = getFieldTypeAst(field, ctx)
    const paramType = buildParamType([{ name: paramName, type: fieldType, optional: false }])
    const isUnique = isUniqueIndex(index)

    const param = b.identifier("args")
    param.typeAnnotation = b.tsTypeAnnotation(toTSType(paramType))

    const sqlTemplate = buildSqlTemplate(
      [`select * from ${schema}.${table} where ${columnName} = `, ""],
      [b.memberExpression(b.identifier("args"), b.identifier(paramName), false)]
    )
    const awaitSql = buildAwaitSql(sqlTemplate)

    if (isUnique) {
      const varDecl = b.variableDeclaration("const", [
        b.variableDeclarator(b.arrayPattern([b.identifier("result")]), awaitSql),
      ])

      const returnType = wrapPromise(ts.union(ts.ref(rowType), ts.null()))
      const fn = b.functionDeclaration(
        b.identifier(fnName),
        [param],
        b.blockStatement([varDecl, b.returnStatement(b.identifier("result"))])
      )
      fn.async = true
      fn.returnType = b.tsTypeAnnotation(toTSType(returnType))

      statements.push(b.exportNamedDeclaration(fn, []))
    } else {
      const returnType = wrapPromise(ts.array(ts.ref(rowType)))
      const fn = b.functionDeclaration(
        b.identifier(fnName),
        [param],
        b.blockStatement([b.returnStatement(awaitSql)])
      )
      fn.async = true
      fn.returnType = b.tsTypeAnnotation(toTSType(returnType))

      statements.push(b.exportNamedDeclaration(fn, []))
    }
  }

  return statements
}

/**
 * SQL Queries Plugin
 */
export const sqlQueriesPlugin = definePlugin({
  name: "sql-queries",
  provides: ["queries", "queries:sql"],
  requires: ["types"],
  configSchema: SqlQueriesPluginConfig,
  inflection: {
    outputFile: (ctx) => `${ctx.entityName}.ts`,
    symbolName: (entityName, artifactKind) => `${entityName}${artifactKind}`,
  },

  run: (ctx, config) => {
    const { ir } = ctx
    const enums = getEnumEntities(ir)

    for (const entity of getTableEntities(ir)) {
      if (entity.tags.omit === true) continue

      const genCtx: GenerationContext = { entity, enums, ir, config }
      const crudStatements = generateCrudFunctions(genCtx)
      const lookupStatements = generateLookupFunctions(genCtx)
      const allStatements = [...crudStatements, ...lookupStatements]

      if (allStatements.length === 0) continue

      const entityName = ctx.inflection.entityName(entity.pgClass, entity.tags)
      const fileNameCtx: FileNameContext = {
        entityName,
        pgName: entity.pgName,
        schema: entity.schemaName,
        inflection: ctx.inflection,
        entity,
      }
      const fileName = ctx.pluginInflection.outputFile(fileNameCtx)
      const filePath = `${config.outputDir}/${fileName}`

      const fileBuilder = ctx.file(filePath)

      if (config.header) {
        fileBuilder.header(`${config.header}\n`)
      } else {
        fileBuilder.header("// This file is auto-generated. Do not edit.\n")
      }

      // Import sql template tag
      fileBuilder.import({
        kind: "relative",
        names: ["sql"],
        from: "../db",
      })

      // Import Row type
      fileBuilder.import({
        kind: "symbol",
        ref: { capability: "types", entity: entity.name, shape: "row" },
      })

      fileBuilder.ast(conjure.program(...allStatements)).emit()
    }
  },
})

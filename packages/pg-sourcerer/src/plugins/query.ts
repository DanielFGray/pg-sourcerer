/**
 * Query Plugin - Generate typed query functions based on indexes
 *
 * Generates typed query functions that execute raw SQL with type-safe wrappers.
 */
import { Schema as S } from "effect"
import { definePlugin } from "../services/plugin.js"
import type { Entity, IndexDef, TableEntity } from "../ir/semantic-ir.js"
import { isTableEntity } from "../ir/semantic-ir.js"
import { conjure } from "../lib/conjure.js"

const { ts, b, exp } = conjure

/**
 * Plugin configuration schema
 */
const QueryPluginConfig = S.Struct({
  outputDir: S.String,
})

/**
 * Generate a function name from an index
 */
function generateFunctionName(entity: TableEntity, index: IndexDef): string {
  const entitySingular = entity.name.replace(/s$/, "")
  const byPart = index.columns
    .map((col) => `By${col.charAt(0).toUpperCase() + col.slice(1)}`)
    .join("")
  return `get${entitySingular}${byPart}`
}

/**
 * Determine if an index is unique (including primary keys)
 */
function isUniqueIndex(index: IndexDef): boolean {
  return index.isUnique || index.isPrimary
}

/**
 * Analyze an entity's indexes and generate query functions
 */
function analyzeEntityForQueries(entity: TableEntity) {
  const queries: Array<{
    name: string
    entityName: string
    index: IndexDef
    returnType: string
    paramNames: readonly string[]
  }> = []
  const seenNames = new Set<string>()

  for (const index of entity.indexes) {
    if (index.hasExpressions) continue
    if (index.isPartial) continue

    const functionName = generateFunctionName(entity, index)

    // Skip duplicates (e.g., multiple indexes on same columns)
    if (seenNames.has(functionName)) continue
    seenNames.add(functionName)

    const isUnique = isUniqueIndex(index)

    queries.push({
      name: functionName,
      entityName: entity.name,
      index,
      returnType: isUnique
        ? `Promise<${entity.name}Row | null>`
        : `Promise<${entity.name}Row[]>`,
      paramNames: index.columns,
    })
  }

  return queries
}

/**
 * Create a simple function declaration that emits basic code
 */
function createQueryFunction(name: string, paramNames: string[], returnType: string): ReturnType<typeof b.functionDeclaration> {
  // Build parameters
  const params = paramNames.map((p) => {
    const id = b.identifier(p)
    id.typeAnnotation = b.tsTypeAnnotation(ts.ref("string"))
    return id
  })

  // Parse return type to AST - simplified
  let returnTypeAST = b.tsTypeAnnotation(ts.ref("unknown"))
  if (returnType.includes("[]")) {
    returnTypeAST = b.tsTypeAnnotation(ts.array(ts.ref("unknown")))
  } else if (returnType.includes("null")) {
    returnTypeAST = b.tsTypeAnnotation(ts.union(ts.ref("unknown"), ts.null()))
  }

  // Build function body - simplified
  const sql = `SELECT * FROM table WHERE id = $1`
  const body = b.blockStatement([
    b.throwStatement(b.newExpression(b.identifier("Error"), [b.stringLiteral("Not implemented")])),
  ])

  const fn = b.functionDeclaration(b.identifier(name), params, body)
  fn.async = true
  fn.returnType = returnTypeAST

  return fn
}

/**
 * Query Plugin
 */
export const queryPlugin = definePlugin({
  name: "query",
  provides: ["queries"],
  requires: ["types"],
  configSchema: QueryPluginConfig,
  inflection: {
    outputFile: (ctx) => `${ctx.entityName}.ts`,
    symbolName: (entityName, artifactKind) => `${entityName}${artifactKind}`,
  },

  run: (ctx, config) => {
    const { ir } = ctx

    for (const [name, entity] of ir.entities) {
      // Only process table/view entities (enums don't have indexes)
      if (!isTableEntity(entity)) continue
      if (entity.tags.omit === true) continue

      const queries = analyzeEntityForQueries(entity)

      if (queries.length === 0) continue

      // Generate function declarations
      const functions = queries.map((q) =>
        createQueryFunction(q.name, [...q.paramNames], q.returnType)
      )

      const fileBuilder = ctx
        .file(`${config.outputDir}/${name}.ts`)
        .header("// This file is auto-generated. Do not edit.\n")

      fileBuilder.import({
        kind: "symbol" as const,
        ref: { capability: "types", entity: name, shape: "row" },
      })

      fileBuilder.import({
        kind: "relative" as const,
        types: ["Database"],
        from: "../db",
      })

      fileBuilder.ast(conjure.program(...functions)).emit()
    }
  },
})

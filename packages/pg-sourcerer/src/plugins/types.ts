/**
 * Types Plugin - Generate TypeScript interfaces for entities
 *
 * Generates Row, Insert, Update, and Patch interfaces for each entity.
 * Supports user-configured type overrides via TypeHints.
 */
import { Option, Schema as S } from "effect"
import type { namedTypes as n } from "ast-types"
import { definePlugin } from "../services/plugin.js"
import type { FileNameContext } from "../services/plugin.js"
import { findEnumByPgName, TsType } from "../services/pg-types.js"
import type {
  Field,
  Shape,
  TableEntity,
  EnumEntity,
  ExtensionInfo,
} from "../ir/semantic-ir.js"
import { getEnumEntities, getTableEntities } from "../ir/semantic-ir.js"
import { conjure } from "../lib/conjure.js"
import type { SymbolStatement } from "../lib/conjure.js"
import type { ImportRef } from "../services/file-builder.js"
import type { TypeHintRegistry, TypeHintFieldMatch } from "../services/type-hints.js"
import {
  isEnumType,
  getPgTypeName,
  resolveFieldType as resolveFieldBaseType,
} from "../lib/field-utils.js"

const { ts, exp } = conjure

/**
 * Plugin configuration schema
 *
 * Note: outputDir is required in the schema. Default is applied when
 * creating the plugin config, not via Schema.optionalWith, to avoid
 * type conflicts with exactOptionalPropertyTypes.
 */
const TypesPluginConfig = S.Struct({
  /** Output directory relative to main outputDir */
  outputDir: S.String,
})

/** Default configuration values */
const _defaultConfig = { outputDir: "types" } as const

/**
 * Convert a TsType string to an AST node
 */
function tsTypeToAst(tsType: string): n.TSType {
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
 * Build TypeHintFieldMatch from entity and field
 * For arrays, uses the element type name for matching (not the array type _foo)
 */
function buildFieldMatch(entity: TableEntity, field: Field): TypeHintFieldMatch {
  // For arrays, use the element type name for matching
  // This allows { pgType: "citext" } to match citext[] columns
  const pgTypeName = field.isArray && field.elementTypeName
    ? field.elementTypeName
    : field.pgAttribute.getType()?.typname ?? ""
  
  return {
    schema: entity.schemaName,
    table: entity.pgName,
    column: field.columnName,
    pgType: pgTypeName,
  }
}

/**
 * Result of resolving a field's type
 */
interface ResolvedFieldType {
  type: n.TSType
  /** Custom import: { typeName, importPath } */
  customImport?: { typeName: string; importPath: string }
}

/**
 * Resolve a field to its TypeScript AST type node
 * 
 * Resolution order:
 * 1. TypeHints override (highest priority)
 * 2. Shared field type resolution (enum, OID, domain, extension)
 */
function resolveFieldType(
  field: Field,
  entity: TableEntity,
  enums: readonly EnumEntity[],
  extensions: readonly ExtensionInfo[],
  typeHints: TypeHintRegistry
): ResolvedFieldType {
  // 1. Check TypeHints first (highest priority)
  const fieldMatch = buildFieldMatch(entity, field)
  const tsTypeHint = typeHints.getHint<string>(fieldMatch, "tsType")
  
  if (Option.isSome(tsTypeHint)) {
    const importPath = typeHints.getHint<string>(fieldMatch, "import")
    const baseType = ts.ref(tsTypeHint.value)
    const result: ResolvedFieldType = {
      type: field.isArray ? ts.array(baseType) : baseType,
    }
    if (Option.isSome(importPath)) {
      result.customImport = { typeName: tsTypeHint.value, importPath: importPath.value }
    }
    return result
  }

  // 2. Use shared field type resolution
  const resolved = resolveFieldBaseType(field, enums, extensions)
  
  // If resolved to an enum, use the enum name
  if (resolved.enumDef) {
    const baseType = ts.ref(resolved.enumDef.name)
    return { type: field.isArray ? ts.array(baseType) : baseType }
  }
  
  // Convert TsType to AST node
  const baseType = tsTypeToAst(resolved.tsType)
  return { type: field.isArray ? ts.array(baseType) : baseType }
}

/**
 * Wrap type with null union if nullable
 */
function wrapNullableAst(typeNode: n.TSType, nullable: boolean): n.TSType {
  if (!nullable) return typeNode
  return ts.union(typeNode, ts.null())
}

/**
 * Property signature for exp.interface()
 */
interface PropSig {
  name: string
  type: n.TSType
  optional?: boolean
}

/**
 * Custom import info: type name and where to import from
 */
interface CustomImportInfo {
  typeName: string
  importPath: string
}

/**
 * Result of generating a shape statement
 */
interface ShapeGenerationResult {
  statement: SymbolStatement
  customImports: CustomImportInfo[]
}

/**
 * Generate interface statement for a shape using exp.interface()
 */
function generateShapeStatement(
  shape: Shape,
  entity: TableEntity,
  enums: readonly EnumEntity[],
  extensions: readonly ExtensionInfo[],
  entityName: string,
  shapeKind: "row" | "insert" | "update" | "patch",
  typeHints: TypeHintRegistry
): ShapeGenerationResult {
  const customImports: CustomImportInfo[] = []
  
  const properties: PropSig[] = shape.fields.map((field) => {
    const resolved = resolveFieldType(field, entity, enums, extensions, typeHints)
    const typeWithNull = wrapNullableAst(resolved.type, field.nullable)
    
    // Track custom imports
    if (resolved.customImport) {
      customImports.push(resolved.customImport)
    }
    
    const prop: PropSig = { name: field.name, type: typeWithNull }
    if (field.optional) prop.optional = true
    return prop
  })

  const statement = exp.interface(
    shape.name,
    { capability: "types", entity: entityName, shape: shapeKind },
    properties
  )
  
  return { statement, customImports }
}

/**
 * Generate enum type alias using exp.typeAlias()
 */
function generateEnumStatement(enumEntity: EnumEntity): SymbolStatement {
  const unionType = ts.union(...enumEntity.values.map((value) => ts.literal(value)))
  return exp.typeAlias(
    enumEntity.name,
    { capability: "types", entity: enumEntity.name },
    unionType
  )
}

/**
 * Collect enum names used by an entity's shapes
 */
function collectUsedEnums(
  entity: TableEntity,
  enums: readonly EnumEntity[]
): Set<string> {
  const usedEnums = new Set<string>()
  const { row, insert, update, patch } = entity.shapes

  for (const shape of [row, insert, update, patch]) {
    if (!shape) continue
    for (const field of shape.fields) {
      if (isEnumType(field)) {
        const pgTypeName = getPgTypeName(field)
        if (pgTypeName) {
          const enumEntityOpt = findEnumByPgName(enums, pgTypeName)
          if (Option.isSome(enumEntityOpt)) {
            usedEnums.add(enumEntityOpt.value.name)
          }
        }
      }
    }
  }

  return usedEnums
}

/**
 * Types Plugin
 *
 * Generates TypeScript interfaces for each entity's shapes (Row, Insert, Update, Patch)
 * and type aliases for PostgreSQL enums.
 * 
 * Supports type overrides via TypeHints configuration:
 * ```typescript
 * typeHints: [
 *   { match: { pgType: 'jsonb' }, hints: { tsType: 'JsonValue', import: './types.js' } },
 *   { match: { table: 'users', column: 'id' }, hints: { tsType: 'UserId' } },
 * ]
 * ```
 */
export const typesPlugin = definePlugin({
  name: "types",
  provides: ["types"],
  configSchema: TypesPluginConfig,
  inflection: {
    outputFile: (ctx) => `${ctx.entityName}.ts`,
    symbolName: (entityName, artifactKind) => `${entityName}${artifactKind}`,
  },

  run: (ctx, config) => {
    const { ir, typeHints } = ctx

    // Get enum and table entities
    const enumEntities = getEnumEntities(ir)
    const tableEntities = getTableEntities(ir)

    // Generate enum type files - each enum gets its own file
    for (const enumEntity of enumEntities) {
      // Skip enums marked with @omit
      if (enumEntity.tags.omit === true) continue

      const statement = generateEnumStatement(enumEntity)

      // Build file name context for outputFile
      const fileNameCtx: FileNameContext = {
        entityName: enumEntity.name,
        pgName: enumEntity.pgName,
        schema: enumEntity.schemaName,
        inflection: ctx.inflection,
        entity: enumEntity,
      }
      const fileName = ctx.pluginInflection.outputFile(fileNameCtx)
      const filePath = `${config.outputDir}/${fileName}`

      ctx
        .file(filePath)
        .header("// This file is auto-generated. Do not edit.\n")
        .ast(conjure.symbolProgram(statement))
        .emit()
    }

    // Generate table/view entity type files
    for (const entity of tableEntities) {
      // Skip entities marked with @omit
      if (entity.tags.omit === true) continue

      const name = entity.name
      const statements: SymbolStatement[] = []
      const allCustomImports: CustomImportInfo[] = []
      const { row, insert, update, patch } = entity.shapes

      // Generate Row interface
      const rowResult = generateShapeStatement(
        row, entity, enumEntities, ir.extensions, name, "row", typeHints
      )
      statements.push(rowResult.statement)
      allCustomImports.push(...rowResult.customImports)

      // Generate optional shape interfaces
      if (insert) {
        const insertResult = generateShapeStatement(
          insert, entity, enumEntities, ir.extensions, name, "insert", typeHints
        )
        statements.push(insertResult.statement)
        allCustomImports.push(...insertResult.customImports)
      }
      if (update) {
        const updateResult = generateShapeStatement(
          update, entity, enumEntities, ir.extensions, name, "update", typeHints
        )
        statements.push(updateResult.statement)
        allCustomImports.push(...updateResult.customImports)
      }
      if (patch) {
        const patchResult = generateShapeStatement(
          patch, entity, enumEntities, ir.extensions, name, "patch", typeHints
        )
        statements.push(patchResult.statement)
        allCustomImports.push(...patchResult.customImports)
      }

      // Collect enum imports
      const usedEnums = collectUsedEnums(entity, enumEntities)
      const enumImports: ImportRef[] =
        usedEnums.size > 0
          ? [...usedEnums].map((enumName) => ({
              kind: "symbol" as const,
              ref: { capability: "types", entity: enumName },
            }))
          : []

      // Build file name context for outputFile
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
      const fileBuilder = ctx
        .file(filePath)
        .header("// This file is auto-generated. Do not edit.\n")

      // Add enum imports (symbol refs, resolved automatically)
      for (const ref of enumImports) {
        fileBuilder.import(ref)
      }
      
      // Add custom imports from type hints
      // Group by import path, collect all type names for each path
      const importsByPath = new Map<string, Set<string>>()
      for (const info of allCustomImports) {
        const existing = importsByPath.get(info.importPath) ?? new Set()
        existing.add(info.typeName)
        importsByPath.set(info.importPath, existing)
      }
      
      for (const [importPath, typeNames] of importsByPath) {
        fileBuilder.import({
          kind: "relative" as const,
          types: [...typeNames],
          from: importPath,
        })
      }

      fileBuilder.ast(conjure.symbolProgram(...statements)).emit()
    }
  },
})

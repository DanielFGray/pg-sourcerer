/**
 * Types Plugin - Generate TypeScript interfaces for entities
 *
 * Generates Row, Insert, Update, and Patch interfaces for each entity.
 * Supports user-configured type overrides via TypeHints.
 */
import { Schema as S } from "effect"
import type { namedTypes as n } from "ast-types"
import { definePlugin } from "../services/plugin.js"
import {
  defaultPgToTs,
  findEnumByPgName,
  getExtensionTypeMapping,
  TsType,
} from "../services/pg-types.js"
import type { Field, Shape, Entity, EnumDef, ExtensionInfo } from "../ir/semantic-ir.js"
import { conjure } from "../lib/conjure.js"
import type { SymbolStatement } from "../lib/conjure.js"
import type { ImportRef } from "../services/file-builder.js"
import type { TypeHintRegistry, TypeHintFieldMatch } from "../services/type-hints.js"

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
const defaultConfig = { outputDir: "types" } as const

/**
 * Get the TypeScript type OID from a field's pg attribute
 */
function getTypeOid(field: Field): number | undefined {
  const pgType = field.pgAttribute.getType()
  if (!pgType?._id) return undefined
  return Number(pgType._id)
}

/**
 * Check if a field's type is an enum
 */
function isEnumType(field: Field): boolean {
  const pgType = field.pgAttribute.getType()
  return pgType?.typtype === "e"
}

/**
 * Get the PostgreSQL type name from a field
 */
function getPgTypeName(field: Field): string | undefined {
  // For arrays, get the element type name
  if (field.isArray && field.elementTypeName) {
    return field.elementTypeName
  }
  return field.pgAttribute.getType()?.typname
}

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
 */
function buildFieldMatch(entity: Entity, field: Field): TypeHintFieldMatch {
  const pgType = field.pgAttribute.getType()
  return {
    schema: entity.schemaName,
    table: entity.tableName,
    column: field.columnName,
    pgType: pgType?.typname ?? "",
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
 * 2. Enum type
 * 3. OID-based mapping
 * 4. Domain base type mapping
 * 5. Extension type mapping
 * 6. Fallback to unknown
 */
function resolveFieldType(
  field: Field,
  entity: Entity,
  enums: ReadonlyMap<string, EnumDef>,
  extensions: ReadonlyArray<ExtensionInfo>,
  typeHints: TypeHintRegistry
): ResolvedFieldType {
  // 1. Check TypeHints first (highest priority)
  const fieldMatch = buildFieldMatch(entity, field)
  const tsTypeHint = typeHints.getHint<string>(fieldMatch, "tsType")
  
  if (tsTypeHint) {
    const importPath = typeHints.getHint<string>(fieldMatch, "import")
    const baseType = ts.ref(tsTypeHint)
    const result: ResolvedFieldType = {
      type: field.isArray ? ts.array(baseType) : baseType,
    }
    if (importPath) {
      result.customImport = { typeName: tsTypeHint, importPath }
    }
    return result
  }

  // 2. Check for enum
  if (isEnumType(field)) {
    const pgTypeName = getPgTypeName(field)
    if (pgTypeName) {
      const enumDef = findEnumByPgName(enums, pgTypeName)
      if (enumDef) {
        const baseType = ts.ref(enumDef.name)
        return { type: field.isArray ? ts.array(baseType) : baseType }
      }
    }
  }

  // 3. Try OID-based mapping (precise, for built-in types)
  const oid = getTypeOid(field)
  if (oid !== undefined) {
    const tsTypeName = defaultPgToTs(oid)
    if (tsTypeName) {
      const baseType = tsTypeToAst(tsTypeName)
      return { type: field.isArray ? ts.array(baseType) : baseType }
    }
  }

  // 4. Try OID-based mapping for domain base types
  if (field.domainBaseType) {
    const tsTypeName = defaultPgToTs(field.domainBaseType.typeOid)
    if (tsTypeName) {
      const baseType = tsTypeToAst(tsTypeName)
      return { type: field.isArray ? ts.array(baseType) : baseType }
    }
  }

  // 5. Try extension-based mapping for the direct type
  const pgType = field.pgAttribute.getType()
  if (pgType) {
    const tsTypeName = getExtensionTypeMapping(
      pgType.typname,
      String(pgType.typnamespace),
      extensions
    )
    if (tsTypeName) {
      const baseType = tsTypeToAst(tsTypeName)
      return { type: field.isArray ? ts.array(baseType) : baseType }
    }
  }

  // Try extension-based mapping for domain base types
  if (field.domainBaseType) {
    const tsTypeName = getExtensionTypeMapping(
      field.domainBaseType.typeName,
      field.domainBaseType.namespaceOid,
      extensions
    )
    if (tsTypeName) {
      const baseType = tsTypeToAst(tsTypeName)
      return { type: field.isArray ? ts.array(baseType) : baseType }
    }
  }

  // For arrays, try to resolve element type
  if (field.isArray && field.elementTypeName) {
    // Check if element is an enum
    const enumDef = findEnumByPgName(enums, field.elementTypeName)
    if (enumDef) {
      return { type: ts.array(ts.ref(enumDef.name)) }
    }
  }

  // 6. Fallback to unknown
  return { type: field.isArray ? ts.array(ts.unknown()) : ts.unknown() }
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
  entity: Entity,
  enums: ReadonlyMap<string, EnumDef>,
  extensions: ReadonlyArray<ExtensionInfo>,
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
function generateEnumStatement(enumDef: EnumDef): SymbolStatement {
  const unionType = ts.union(...enumDef.values.map((value) => ts.literal(value)))
  return exp.typeAlias(
    enumDef.name,
    { capability: "types", entity: enumDef.name },
    unionType
  )
}

/**
 * Collect enum names used by an entity's shapes
 */
function collectUsedEnums(
  entity: Entity,
  enums: ReadonlyMap<string, EnumDef>
): Set<string> {
  const usedEnums = new Set<string>()
  const { row, insert, update, patch } = entity.shapes

  for (const shape of [row, insert, update, patch]) {
    if (!shape) continue
    for (const field of shape.fields) {
      if (isEnumType(field)) {
        const pgTypeName = getPgTypeName(field)
        if (pgTypeName) {
          const enumDef = findEnumByPgName(enums, pgTypeName)
          if (enumDef) {
            usedEnums.add(enumDef.name)
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
    outputFile: (entityName, _artifactKind) => `${entityName}.ts`,
    symbolName: (entityName, artifactKind) => `${entityName}${artifactKind}`,
  },

  run: (ctx, config) => {
    const { ir, typeHints } = ctx

    // Generate enum types file if there are enums
    if (ir.enums.size > 0) {
      const enumStatements = [...ir.enums.values()].map(generateEnumStatement)

      ctx
        .file(`${config.outputDir}/enums.ts`)
        .header("// This file is auto-generated. Do not edit.\n")
        .ast(conjure.symbolProgram(...enumStatements))
        .emit()
    }

    // Generate entity type files
    for (const [name, entity] of ir.entities) {
      // Skip entities marked with @omit
      if (entity.tags.omit === true) continue

      const statements: SymbolStatement[] = []
      const allCustomImports: CustomImportInfo[] = []
      const { row, insert, update, patch } = entity.shapes

      // Generate Row interface
      const rowResult = generateShapeStatement(
        row, entity, ir.enums, ir.extensions, name, "row", typeHints
      )
      statements.push(rowResult.statement)
      allCustomImports.push(...rowResult.customImports)

      // Generate optional shape interfaces
      if (insert) {
        const insertResult = generateShapeStatement(
          insert, entity, ir.enums, ir.extensions, name, "insert", typeHints
        )
        statements.push(insertResult.statement)
        allCustomImports.push(...insertResult.customImports)
      }
      if (update) {
        const updateResult = generateShapeStatement(
          update, entity, ir.enums, ir.extensions, name, "update", typeHints
        )
        statements.push(updateResult.statement)
        allCustomImports.push(...updateResult.customImports)
      }
      if (patch) {
        const patchResult = generateShapeStatement(
          patch, entity, ir.enums, ir.extensions, name, "patch", typeHints
        )
        statements.push(patchResult.statement)
        allCustomImports.push(...patchResult.customImports)
      }

      // Collect enum imports
      const usedEnums = collectUsedEnums(entity, ir.enums)
      const enumImports: ImportRef[] =
        usedEnums.size > 0 && ir.enums.size > 0
          ? [...usedEnums].map((enumName) => ({
              kind: "symbol" as const,
              ref: { capability: "types", entity: enumName },
            }))
          : []

      const filePath = `${config.outputDir}/${ctx.inflection.entityName(entity.pgClass, entity.tags)}.ts`
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

/**
 * Types Plugin - Generate TypeScript interfaces for entities
 *
 * Generates Row, Insert, Update, and Patch interfaces for each entity.
 * Supports user-configured type overrides via TypeHints.
 */
import { Array as Arr, Option, pipe, Schema as S } from "effect"
import type { namedTypes as n } from "ast-types"
import { definePlugin, type PluginContext } from "../services/plugin.js"
import { findEnumByPgName } from "../services/pg-types.js"
import type {
  Field,
  Shape,
  TableEntity,
  EnumEntity,
  CompositeEntity,
  ExtensionInfo,
} from "../ir/semantic-ir.js"
import { getEnumEntities, getTableEntities, getCompositeEntities } from "../ir/semantic-ir.js"
import { conjure } from "../lib/conjure.js"
import type { SymbolStatement } from "../lib/conjure.js"
import type { ImportRef } from "../services/file-builder.js"
import type { TypeHintRegistry, TypeHintFieldMatch } from "../services/type-hints.js"
import {
  isEnumType,
  getPgTypeName,
  resolveFieldType as resolveFieldBaseType,
  tsTypeToAst,
} from "../lib/field-utils.js"

const { ts, exp } = conjure

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for the types provider
 */
export interface TypesConfig {
  readonly outputDir?: string
}

const TypesConfigSchema = S.Struct({
  outputDir: S.optionalWith(S.String, { default: () => "types" }),
})

// ============================================================================
// Types
// ============================================================================

/** Custom import info: type name and where to import from */
interface CustomImportInfo {
  readonly typeName: string
  readonly importPath: string
}

/** Result of resolving a field's type */
interface ResolvedFieldType {
  readonly type: n.TSType
  readonly customImport?: CustomImportInfo
}

/** Result of generating statements with imports */
interface GenerationResult {
  readonly statements: readonly SymbolStatement[]
  readonly customImports: readonly CustomImportInfo[]
}

/** Context for field resolution */
interface FieldContext {
  readonly schemaName: string
  readonly tableName: string
  readonly enums: readonly EnumEntity[]
  readonly extensions: readonly ExtensionInfo[]
  readonly typeHints: TypeHintRegistry
}

// ============================================================================
// Helpers
// ============================================================================

/** Build TypeHintFieldMatch from field and context */
const buildFieldMatch = (field: Field, ctx: FieldContext): TypeHintFieldMatch => ({
  schema: ctx.schemaName,
  table: ctx.tableName,
  column: field.columnName,
  pgType: field.isArray && field.elementTypeName
    ? field.elementTypeName
    : field.pgAttribute.getType()?.typname ?? "",
})

/** Group custom imports by path */
const groupImportsByPath = (imports: readonly CustomImportInfo[]): Map<string, Set<string>> =>
  imports.reduce((map, info) => {
    const existing = map.get(info.importPath) ?? new Set()
    existing.add(info.typeName)
    map.set(info.importPath, existing)
    return map
  }, new Map<string, Set<string>>())

/** Collect enum names used by fields */
const collectUsedEnums = (fields: readonly Field[], enums: readonly EnumEntity[]): Set<string> => {
  const enumNames = fields
    .filter(isEnumType)
    .flatMap(field => {
      const pgTypeName = getPgTypeName(field)
      if (!pgTypeName) return []
      return pipe(
        findEnumByPgName(enums, pgTypeName),
        Option.map(e => e.name),
        Option.toArray
      )
    })
  return new Set(enumNames)
}

/** Build enum import refs from used enum names */
const buildEnumImports = (usedEnums: Set<string>): readonly ImportRef[] =>
  Arr.fromIterable(usedEnums).map(enumName => ({
    kind: "symbol" as const,
    ref: { capability: "types", entity: enumName },
  }))

// ============================================================================
// Field Resolution
// ============================================================================

/**
 * Resolve a field to its TypeScript AST type node
 *
 * Resolution order:
 * 1. TypeHints override (highest priority)
 * 2. Shared field type resolution (enum, OID, domain, extension)
 */
const resolveFieldType = (field: Field, ctx: FieldContext): ResolvedFieldType => {
  const fieldMatch = buildFieldMatch(field, ctx)
  const tsTypeHint = ctx.typeHints.getHint<string>(fieldMatch, "tsType")

  // 1. Check TypeHints first (highest priority)
  return pipe(
    tsTypeHint,
    Option.match({
      onSome: typeName => {
        const importPath = ctx.typeHints.getHint<string>(fieldMatch, "import")
        const baseType = ts.ref(typeName)
        return {
          type: ts.withModifiers(baseType, { array: field.isArray }),
          customImport: pipe(
            importPath,
            Option.map(path => ({ typeName, importPath: path })),
            Option.getOrUndefined
          ),
        }
      },
      onNone: () => {
        // 2. Use shared field type resolution
        const resolved = resolveFieldBaseType(field, ctx.enums, ctx.extensions)
        const baseType = resolved.enumDef
          ? ts.ref(resolved.enumDef.name)
          : tsTypeToAst(resolved.tsType)
        return { type: ts.withModifiers(baseType, { array: field.isArray }) }
      },
    })
  )
}

// ============================================================================
// Statement Generators
// ============================================================================

/** Generate interface statement for a shape */
const generateShapeStatement = (
  shape: Shape,
  entityName: string,
  shapeKind: "row" | "insert" | "update" | "patch",
  ctx: FieldContext
): GenerationResult => {
  const resolvedFields = shape.fields.map(field => ({
    field,
    resolved: resolveFieldType(field, ctx),
  }))

  const properties = resolvedFields.map(({ field, resolved }) => ({
    name: field.name,
    type: ts.withModifiers(resolved.type, { nullable: field.nullable }),
    optional: field.optional || undefined,
  }))

  const customImports = Arr.filterMap(resolvedFields, ({ resolved }) =>
    Option.fromNullable(resolved.customImport)
  )

  const statement = exp.interface(
    shape.name,
    { capability: "types", entity: entityName, shape: shapeKind },
    properties
  )

  return { statements: [statement], customImports }
}

/** Generate enum type alias */
const generateEnumStatement = (enumEntity: EnumEntity): SymbolStatement =>
  exp.typeAlias(
    enumEntity.name,
    { capability: "types", entity: enumEntity.name },
    ts.union(...enumEntity.values.map(ts.literal))
  )

/** Generate all shape statements for a table entity */
const generateTableStatements = (
  entity: TableEntity,
  ctx: FieldContext
): GenerationResult => {
  const { row, insert, update } = entity.shapes
  type ShapeEntry = [Shape, "row" | "insert" | "update"]
  
  const shapeEntries: ShapeEntry[] = [
    [row, "row"],
    ...(insert ? [[insert, "insert"] as ShapeEntry] : []),
    ...(update ? [[update, "update"] as ShapeEntry] : []),
  ]

  const results = shapeEntries.map(([shape, kind]) =>
    generateShapeStatement(shape, entity.name, kind, ctx)
  )

  return {
    statements: results.flatMap(r => r.statements),
    customImports: results.flatMap(r => r.customImports),
  }
}

/** Generate interface statement for a composite type */
const generateCompositeStatement = (
  composite: CompositeEntity,
  ctx: FieldContext
): GenerationResult => {
  const resolvedFields = composite.fields.map(field => ({
    field,
    resolved: resolveFieldType(field, ctx),
  }))

  const properties = resolvedFields.map(({ field, resolved }) => ({
    name: field.name,
    type: ts.withModifiers(resolved.type, { nullable: field.nullable }),
    optional: field.optional || undefined,
  }))

  const customImports = Arr.filterMap(resolvedFields, ({ resolved }) =>
    Option.fromNullable(resolved.customImport)
  )

  const statement = exp.interface(
    composite.name,
    { capability: "types", entity: composite.name },
    properties
  )

  return { statements: [statement], customImports }
}

// ============================================================================
// File Emission
// ============================================================================

/** Add custom imports to file builder grouped by path */
const addCustomImports = (
  fileBuilder: { import: (ref: ImportRef) => unknown },
  imports: readonly CustomImportInfo[]
): void => {
  const grouped = groupImportsByPath(imports)
  for (const [importPath, typeNames] of grouped) {
    fileBuilder.import({
      kind: "relative" as const,
      types: [...typeNames],
      from: importPath,
    })
  }
}

// ============================================================================
// Provider Definition
// ============================================================================

/**
 * Create a types provider that generates TypeScript interfaces.
 *
 * @example
 * ```typescript
 * import { types } from "pg-sourcerer"
 *
 * export default defineConfig({
 *   plugins: [
 *     types(),
 *     types({ outputDir: "custom/types" }),
 *   ],
 * })
 * ```
 */
export function types(config: TypesConfig = {}): ReturnType<typeof definePlugin> {
  const parsed = S.decodeUnknownSync(TypesConfigSchema)(config)

  return definePlugin({
    name: "types",
    kind: "typescript-types",
    singleton: true,

    canProvide: () => true,

    provide: (_params: unknown, _deps: readonly unknown[], ctx: PluginContext) => {
      const { ir, typeHints, inflection } = ctx
      const enumEntities = getEnumEntities(ir)

      // Helper to build file path
      const buildFilePath = (entityName: string): string =>
        `${parsed.outputDir}/${entityName}.ts`

      // Generate enum type files
      enumEntities
        .filter(e => e.tags.omit !== true)
        .forEach(enumEntity => {
          ctx
            .file(buildFilePath(enumEntity.name))
            .ast(conjure.symbolProgram(generateEnumStatement(enumEntity)))
            .emit()
        })

      // Generate table/view entity type files
      getTableEntities(ir)
        .filter(e => e.tags.omit !== true)
        .forEach(entity => {
          const fieldCtx: FieldContext = {
            schemaName: entity.schemaName,
            tableName: entity.pgName,
            enums: enumEntities,
            extensions: ir.extensions,
            typeHints,
          }

          const result = generateTableStatements(entity, fieldCtx)

          // Collect all fields from all shapes for enum detection
          const allFields = [
            ...entity.shapes.row.fields,
            ...(entity.shapes.insert?.fields ?? []),
            ...(entity.shapes.update?.fields ?? []),
          ]
          const usedEnums = collectUsedEnums(allFields, enumEntities)

          const entityName = inflection.entityName(entity.pgClass, entity.tags)

          const fileBuilder = ctx.file(buildFilePath(entityName))

          buildEnumImports(usedEnums).forEach(ref => fileBuilder.import(ref))
          addCustomImports(fileBuilder, result.customImports)

          fileBuilder.ast(conjure.symbolProgram(...result.statements)).emit()
        })

      // Generate composite type files
      getCompositeEntities(ir)
        .filter(e => e.tags.omit !== true)
        .forEach(composite => {
          const fieldCtx: FieldContext = {
            schemaName: composite.schemaName,
            tableName: composite.pgName,
            enums: enumEntities,
            extensions: ir.extensions,
            typeHints,
          }

          const result = generateCompositeStatement(composite, fieldCtx)
          const usedEnums = collectUsedEnums(composite.fields, enumEntities)

          const fileBuilder = ctx.file(buildFilePath(composite.name))

          buildEnumImports(usedEnums).forEach(ref => fileBuilder.import(ref))
          addCustomImports(fileBuilder, result.customImports)

          fileBuilder.ast(conjure.symbolProgram(...result.statements)).emit()
        })

      // Singleton providers can return void
      return undefined
    },
  })
}

// ============================================================================
// Legacy Export (for backwards compatibility during migration)
// ============================================================================

/** Alias for types() */
export const typesPlugin = types

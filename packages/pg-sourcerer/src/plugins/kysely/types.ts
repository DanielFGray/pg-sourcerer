// @ts-nocheck - TODO: migrate to new plugin API
/**
 * Kysely Types Generation
 *
 * Generates table interfaces with Generated<T>, ColumnType<S, I, U>, and DB interface.
 * Uses RLS permissions to determine Generated<T> wrapping.
 */
import { Option, pipe } from "effect"
import type { namedTypes as n } from "ast-types"
import type { SimplePluginContext } from "../../services/plugin.js"
import { findEnumByPgName, findCompositeByPgName, PgTypeOid } from "../../services/pg-types.js"
import type {
  Field,
  TableEntity,
  EnumEntity,
  CompositeEntity,
  ExtensionInfo,
} from "../../ir/semantic-ir.js"
import { getEnumEntities, getTableEntities, getCompositeEntities } from "../../ir/semantic-ir.js"
import { conjure } from "../../lib/conjure.js"
import type { SymbolStatement } from "../../lib/conjure.js"
import type { TypeHintRegistry, TypeHintFieldMatch } from "../../services/type-hints.js"
import { isEnumType, getPgTypeName } from "../../lib/field-utils.js"
import { getExtensionTypeMapping } from "../../services/pg-types.js"
import {
  SCALAR_TYPES,
  COMPLEX_TYPES,
  GENERATED_TYPE_DEF,
  ARRAY_TYPE_DEF,
  ARRAY_TYPE_IMPL_DEF,
} from "./shared.js"

const { ts, exp } = conjure

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for Kysely types generation.
 */
export interface KyselyTypesConfig {
  /** Output file path */
  readonly outputFile: string
  /** Use runtime enums instead of string literal unions */
  readonly runtimeEnums: boolean
  /** Use type-only imports (recommended) */
  readonly typeOnlyImports: boolean
}

/** Default config values */
export const defaultTypesConfig: KyselyTypesConfig = {
  outputFile: "db.ts",
  runtimeEnums: false,
  typeOnlyImports: true,
}

// ============================================================================
// Types
// ============================================================================

/** Context for field type resolution */
interface FieldContext {
  readonly schemaName: string
  readonly tableName: string
  readonly enums: readonly EnumEntity[]
  readonly composites: readonly CompositeEntity[]
  readonly extensions: readonly ExtensionInfo[]
  readonly typeHints: TypeHintRegistry
  readonly defaultSchemas: readonly string[]
}

/** Kysely type complexity - whether to use ColumnType<S, I, U> */
interface KyselyType {
  /** The select type (what you get back from queries) */
  readonly selectType: n.TSType
  /** The insert type (what you provide for inserts) - differs for Generated */
  readonly insertType?: n.TSType
  /** The update type (what you provide for updates) */
  readonly updateType?: n.TSType
  /** Whether this needs ColumnType wrapper */
  readonly needsColumnType: boolean
  /** Optional import for external types */
  readonly externalImport?: { name: string; from: string }
}

// ============================================================================
// Type Resolution
// ============================================================================

/** Build TypeHintFieldMatch from field and context */
const buildFieldMatch = (field: Field, ctx: FieldContext): TypeHintFieldMatch => ({
  schema: ctx.schemaName,
  table: ctx.tableName,
  column: field.columnName,
  pgType:
    field.isArray && field.elementTypeName
      ? field.elementTypeName
      : (field.pgAttribute.getType()?.typname ?? ""),
})

/**
 * Resolve a field to its Kysely type.
 * Handles: TypeHints, enums, complex types, scalar types, extensions.
 */
function resolveFieldType(field: Field, ctx: FieldContext): KyselyType {
  const pgType = field.pgAttribute.getType()
  const typeName = pgType?.typname ?? ""

  // 1. Check TypeHints first (highest priority)
  const fieldMatch = buildFieldMatch(field, ctx)
  const tsTypeHint = ctx.typeHints.getHint<string>(fieldMatch, "tsType")

  if (Option.isSome(tsTypeHint)) {
    const hintTypeName = tsTypeHint.value
    const importPath = ctx.typeHints.getHint<string>(fieldMatch, "import")
    return {
      selectType: ts.ref(hintTypeName),
      needsColumnType: false,
      externalImport: pipe(
        importPath,
        Option.map(path => ({ name: hintTypeName, from: path })),
        Option.getOrUndefined
      ),
    }
  }

  // 2. Check if it's an enum
  if (isEnumType(field)) {
    const enumName = getPgTypeName(field)
    if (enumName) {
      const enumDef = findEnumByPgName(ctx.enums, enumName)
      if (Option.isSome(enumDef)) {
        return {
          selectType: ts.ref(enumDef.value.name),
          needsColumnType: false,
        }
      }
    }
  }

  // 3. Check if it's a composite type
  if (pgType?.typtype === "c") {
    const compositeName = getPgTypeName(field)
    if (compositeName) {
      const compositeDef = findCompositeByPgName(ctx.composites, compositeName)
      if (Option.isSome(compositeDef)) {
        return {
          selectType: ts.ref(compositeDef.value.name),
          needsColumnType: false,
        }
      }
    }
  }

  // 4. Check complex types (need ColumnType wrapper)
  const complexType = COMPLEX_TYPES[typeName]
  if (complexType) {
    return {
      selectType: complexType.select(),
      insertType: complexType.insert(),
      updateType: complexType.update(),
      needsColumnType: true,
      externalImport: complexType.import,
    }
  }

  // 5. Check simple scalar types
  const scalarBuilder = SCALAR_TYPES[typeName]
  if (scalarBuilder) {
    return {
      selectType: scalarBuilder(),
      needsColumnType: false,
    }
  }

  // 6. Check extension types (citext, etc.)
  if (pgType) {
    const extType = getExtensionTypeMapping(typeName, String(pgType.typnamespace), ctx.extensions)
    if (Option.isSome(extType)) {
      return {
        selectType: ts.fromString(extType.value),
        needsColumnType: false,
      }
    }
  }

  // 7. Default to string (PostgreSQL sends unknown types as strings)
  return {
    selectType: ts.string(),
    needsColumnType: false,
  }
}

/**
 * Build the final field type with array/nullable/Generated wrappers.
 */
function buildFieldType(field: Field, kyselyType: KyselyType, needsGenerated: boolean): n.TSType {
  let baseType: n.TSType

  // If complex type, wrap in ColumnType<S, I, U>
  if (kyselyType.needsColumnType && kyselyType.insertType && kyselyType.updateType) {
    baseType = ts.ref("ColumnType", [kyselyType.selectType, kyselyType.insertType, kyselyType.updateType])
  } else {
    baseType = kyselyType.selectType
  }

  // Wrap in array if needed
  if (field.isArray) {
    // For simple types, use T[]
    // For complex types, use ArrayType<T>
    if (kyselyType.needsColumnType) {
      baseType = ts.ref("ArrayType", [baseType])
    } else {
      baseType = ts.array(baseType)
    }
  }

  // Wrap in nullable if needed
  if (field.nullable) {
    baseType = ts.nullable(baseType)
  }

  // Wrap in Generated<T> if field has default and is not insertable
  if (needsGenerated) {
    baseType = ts.ref("Generated", [baseType])
  }

  return baseType
}

/**
 * Determine if a field should be wrapped in Generated<T>.
 *
 * A field is Generated when:
 * - It has a default value, AND
 * - It's not required on insert (either auto-increment or RLS blocks insert)
 */
function isGeneratedField(field: Field): boolean {
  if (!field.hasDefault) return false

  // If field can't be inserted via RLS, it's generated
  if (!field.permissions.canInsert) return true

  // Check for serial/identity columns (auto-incrementing)
  const pgType = field.pgAttribute.getType()
  if (!pgType) return false

  // Check for identity columns (GENERATED ALWAYS AS IDENTITY)
  if (field.isIdentity) return true

  // Check for generated columns (GENERATED ALWAYS AS ...)
  if (field.isGenerated) return true

  // serial types have specific OIDs that resolve to int4/int8
  // but the attribute itself may have attidentity or atthasdef
  // For now, use a heuristic: if it's an integer with a default, likely generated
  const typeOid = Number(pgType._id)
  const isIntegerType =
    typeOid === PgTypeOid.Int2 || typeOid === PgTypeOid.Int4 || typeOid === PgTypeOid.Int8

  // If it's an integer primary key with a default, it's likely auto-increment
  // This is a simplification - proper detection would check sequences
  if (isIntegerType && field.hasDefault) {
    // Check if it's a primary key (best effort)
    const constraints = field.pgAttribute.getClass()?.getConstraints() ?? []
    const isPrimaryKey = constraints.some(
      c => c.contype === "p" && c.conkey?.includes(field.pgAttribute.attnum)
    )
    if (isPrimaryKey) return true
  }

  return false
}

// ============================================================================
// Statement Generators
// ============================================================================

/**
 * Generate enum type alias: `export type Status = "active" | "inactive"`
 */
function generateEnumStatement(enumEntity: EnumEntity): SymbolStatement {
  return exp.typeAlias(
    enumEntity.name,
    { capability: "types:kysely", entity: enumEntity.name },
    ts.union(...enumEntity.values.map(v => ts.literal(v)))
  )
}

/**
 * Generate table interface with all column types.
 */
function generateTableInterface(entity: TableEntity, ctx: FieldContext): SymbolStatement {
  const properties: Array<{ name: string; type: n.TSType; optional?: boolean }> = []

  // Use the row shape for column definitions
  for (const field of entity.shapes.row.fields) {
    // Skip fields that aren't selectable via RLS
    if (!field.permissions.canSelect) continue

    const kyselyType = resolveFieldType(field, ctx)
    const needsGenerated = isGeneratedField(field)
    const fieldType = buildFieldType(field, kyselyType, needsGenerated)

    properties.push({
      name: field.name,
      type: fieldType,
    })
  }

  return exp.interface(entity.name, { capability: "types:kysely", entity: entity.name }, properties)
}

/**
 * Generate composite type interface.
 *
 * Composite types are simpler than tables - they just have fields,
 * no shapes, no Generated wrapping (composites can't have defaults).
 */
function generateCompositeInterface(composite: CompositeEntity, ctx: FieldContext): SymbolStatement {
  const properties: Array<{ name: string; type: n.TSType; optional?: boolean }> = []

  for (const field of composite.fields) {
    const kyselyType = resolveFieldType(field, ctx)
    // Composites don't have Generated wrapping - they're just data structures
    const fieldType = buildFieldType(field, kyselyType, false)

    properties.push({
      name: field.name,
      type: fieldType,
    })
  }

  return exp.interface(
    composite.name,
    { capability: "types:kysely", entity: composite.name },
    properties
  )
}

/**
 * Generate DB interface: `export interface DB { 'schema.table': Table }`
 */
function generateDBInterface(
  entities: readonly TableEntity[],
  defaultSchemas: readonly string[]
): SymbolStatement {
  const properties: Array<{ name: string; type: n.TSType }> = []

  for (const entity of entities) {
    // Skip entities that aren't selectable
    if (!entity.permissions.canSelect) continue

    // Use schema-qualified key if not in default schema
    const key = defaultSchemas.includes(entity.schemaName)
      ? entity.pgName
      : `${entity.schemaName}.${entity.pgName}`

    properties.push({
      name: key,
      type: ts.ref(entity.name),
    })
  }

  // Sort by key for stable output
  properties.sort((a, b) => a.name.localeCompare(b.name))

  return exp.interface("DB", { capability: "types:kysely", entity: "DB" }, properties)
}

// ============================================================================
// Collect Required Imports
// ============================================================================

interface CollectedImports {
  readonly kyselyImports: Set<string>
  readonly externalImports: Map<string, Set<string>> // path → names
  readonly usedEnums: Set<string>
  readonly needsJsonTypes: boolean
  readonly needsArrayType: boolean
  readonly needsGenerated: boolean
}

function collectImports(
  entities: readonly TableEntity[],
  composites: readonly CompositeEntity[],
  ctx: FieldContext
): CollectedImports {
  const kyselyImports = new Set<string>()
  const externalImports = new Map<string, Set<string>>()
  const usedEnums = new Set<string>()
  let needsJsonTypes = false
  let needsArrayType = false
  let needsGenerated = false

  // Helper to process a single field
  const processField = (
    field: Field,
    schemaName: string,
    tableName: string,
    checkGenerated: boolean
  ) => {
    const kyselyType = resolveFieldType(field, {
      ...ctx,
      schemaName,
      tableName,
    })

    // Check for ColumnType usage
    if (kyselyType.needsColumnType) {
      kyselyImports.add("ColumnType")
    }

    // Check for external imports
    if (kyselyType.externalImport) {
      const { name, from } = kyselyType.externalImport
      if (!externalImports.has(from)) {
        externalImports.set(from, new Set())
      }
      externalImports.get(from)!.add(name)
    }

    // Check for enum usage
    if (isEnumType(field)) {
      const enumName = getPgTypeName(field)
      if (enumName) {
        const enumDef = findEnumByPgName(ctx.enums, enumName)
        if (Option.isSome(enumDef)) {
          usedEnums.add(enumDef.value.name)
        }
      }
    }

    // Check for JSON types
    const pgType = field.pgAttribute.getType()
    if (pgType?.typname === "json" || pgType?.typname === "jsonb") {
      needsJsonTypes = true
    }

    // Check for complex array types
    if (field.isArray && kyselyType.needsColumnType) {
      needsArrayType = true
    }

    // Check for Generated (only for table fields)
    if (checkGenerated && isGeneratedField(field)) {
      needsGenerated = true
    }
  }

  // Process table entity fields
  for (const entity of entities) {
    if (!entity.permissions.canSelect) continue

    for (const field of entity.shapes.row.fields) {
      if (!field.permissions.canSelect) continue
      processField(field, entity.schemaName, entity.pgName, true)
    }
  }

  // Process composite entity fields
  for (const composite of composites) {
    for (const field of composite.fields) {
      processField(field, composite.schemaName, composite.pgName, false)
    }
  }

  return {
    kyselyImports,
    externalImports,
    usedEnums,
    needsJsonTypes,
    needsArrayType,
    needsGenerated,
  }
}

// ============================================================================
// Core Generation Function
// ============================================================================

/**
 * Generate Kysely types from the IR.
 *
 * @param ctx - Plugin context for file emission and services
 * @param config - Types configuration (partial, defaults applied)
 */
export function generateKyselyTypes(
  ctx: SimplePluginContext,
  config: Partial<KyselyTypesConfig> = {}
): void {
  // Apply defaults
  const resolvedConfig: KyselyTypesConfig = {
    ...defaultTypesConfig,
    ...config,
  }

  const { ir, typeHints } = ctx
  const enumEntities = getEnumEntities(ir)
  const compositeEntities = getCompositeEntities(ir).filter(e => e.tags.omit !== true)
  const tableEntities = getTableEntities(ir).filter(e => e.tags.omit !== true)
  const defaultSchemas = ir.schemas

  // Build field context
  const fieldCtx: FieldContext = {
    schemaName: "", // Will be set per-entity
    tableName: "",
    enums: enumEntities,
    composites: compositeEntities,
    extensions: ir.extensions,
    typeHints,
    defaultSchemas,
  }

  // Collect what imports we need
  const imports = collectImports(tableEntities, compositeEntities, fieldCtx)

  // Build statements
  const statements: SymbolStatement[] = []

  // Generate enum types
  for (const enumEntity of enumEntities) {
    if (enumEntity.tags.omit === true) continue
    statements.push(generateEnumStatement(enumEntity))
  }

  // Generate composite type interfaces
  for (const composite of compositeEntities) {
    statements.push(
      generateCompositeInterface(composite, {
        ...fieldCtx,
        schemaName: composite.schemaName,
        tableName: composite.pgName,
      })
    )
  }

  // Generate table interfaces
  for (const entity of tableEntities) {
    statements.push(
      generateTableInterface(entity, {
        ...fieldCtx,
        schemaName: entity.schemaName,
        tableName: entity.pgName,
      })
    )
  }

  // Generate DB interface
  statements.push(generateDBInterface(tableEntities, defaultSchemas))

  // Build the file
  const file = ctx.file(resolvedConfig.outputFile)

  // Add Kysely imports
  if (imports.kyselyImports.size > 0) {
    file.import({
      kind: "package",
      types: [...imports.kyselyImports],
      from: "kysely",
    })
  }

  // Add external imports
  for (const [from, names] of imports.externalImports) {
    file.import({
      kind: "relative",
      types: [...names],
      from,
    })
  }

  // Build header with helper types
  const helperTypes: string[] = []

  if (imports.needsGenerated) {
    helperTypes.push(`export type Generated<T> = ${GENERATED_TYPE_DEF};`)
  }

  if (imports.needsArrayType) {
    helperTypes.push(`export type ArrayType<T> = ${ARRAY_TYPE_DEF};`)
    helperTypes.push(`export type ArrayTypeImpl<T> = ${ARRAY_TYPE_IMPL_DEF};`)
  }

  if (imports.needsJsonTypes) {
    helperTypes.push(`export type JsonPrimitive = boolean | number | string | null;`)
    helperTypes.push(`export type JsonObject = { [x: string]: JsonValue | undefined };`)
    helperTypes.push(`export type JsonArray = JsonValue[];`)
    helperTypes.push(`export type JsonValue = JsonArray | JsonObject | JsonPrimitive;`)
  }

  if (helperTypes.length > 0) {
    file.header(helperTypes.join("\n\n"))
  }

  // Add the main content
  file.ast(conjure.symbolProgram(...statements)).emit()
}

/**
 * Effect Model Plugin - Generate @effect/sql Model classes for entities
 *
 * Generates Model classes with proper variants based on:
 * - RLS permissions (canSelect, canInsert, canUpdate)
 * - Field properties (isGenerated, isIdentity, hasDefault, nullable)
 * - Smart tags (sensitive, insert override)
 */
import { Schema as S } from "effect"
import type { namedTypes as n } from "ast-types"
import type { ExpressionKind } from "ast-types/lib/gen/kinds.js"
import { definePlugin } from "../services/plugin.js"
import type { FileNameContext } from "../services/plugin.js"
import { inflect } from "../services/inflection.js"
import { TsType } from "../services/pg-types.js"
import type { EnumLookupResult } from "../services/pg-types.js"
import type {
  Field,
  TableEntity,
  EnumEntity,
  ExtensionInfo,
} from "../ir/semantic-ir.js"
import { getEnumEntities, getTableEntities } from "../ir/semantic-ir.js"
import { conjure } from "../lib/conjure.js"
import type { SymbolStatement } from "../lib/conjure.js"
import {
  isUuidType,
  isDateType,
  isBigIntType,
  resolveFieldType,
} from "../lib/field-utils.js"

const { exp, obj } = conjure

/**
 * Plugin configuration schema
 */
const EffectModelPluginConfig = S.Struct({
  /** Output directory relative to main outputDir */
  outputDir: S.String,
  /** How to handle enums: "inline" or "separate" file */
  enumStyle: S.optional(S.Union(S.Literal("inline"), S.Literal("separate"))),
})

type EffectModelPluginConfig = S.Schema.Type<typeof EffectModelPluginConfig>

/**
 * Smart tag schema for effect:model plugin-specific options
 * These are nested under {"sourcerer": {"effect:model": {...}}}
 */
const EffectModelTagsSchema = S.Struct({
  /** Override insert optionality: "optional" or "required" */
  insert: S.optional(S.Union(S.Literal("optional"), S.Literal("required"))),
  /** Mark field as sensitive - excluded from json variants */
  sensitive: S.optional(S.Boolean),
})

type EffectModelTags = S.Schema.Type<typeof EffectModelTagsSchema>

/**
 * Extract effect:model smart tags from a field's tags
 */
function getEffectModelTags(field: Field): EffectModelTags {
  const pluginTags = field.tags["effect:model"]
  if (!pluginTags) return {}
  
  // Validate against schema, return empty on failure
  const result = S.decodeUnknownSync(EffectModelTagsSchema)(pluginTags)
  return result
}

/**
 * Check if a field is marked as sensitive via smart tag
 */
function isSensitive(field: Field): boolean {
  return getEffectModelTags(field).sensitive === true
}

/**
 * Get insert optionality override from smart tag
 * Returns undefined if not specified (use default behavior)
 */
function getInsertOverride(field: Field): "optional" | "required" | undefined {
  return getEffectModelTags(field).insert
}

/**
 * Cast n.Expression to ExpressionKind for recast compatibility
 */
function toExprKind(expr: n.Expression): ExpressionKind {
  return expr as ExpressionKind
}

/**
 * Map TypeScript type to Effect Schema expression
 */
function tsTypeToEffectSchema(tsType: string): n.Expression {
  switch (tsType) {
    case TsType.String:
      return conjure.id("S").prop("String").build()
    case TsType.Number:
      return conjure.id("S").prop("Number").build()
    case TsType.Boolean:
      return conjure.id("S").prop("Boolean").build()
    case TsType.BigInt:
      return conjure.id("S").prop("BigInt").build()
    case TsType.Date:
      return conjure.id("S").prop("Date").build()
    case TsType.Buffer:
    case TsType.Unknown:
    default:
      return conjure.id("S").prop("Unknown").build()
  }
}

/**
 * Build S.Union(S.Literal(...), ...) for an enum
 */
function buildEnumSchema(enumResult: EnumLookupResult): n.Expression {
  const literals = enumResult.values.map((v: string) =>
    conjure.id("S").method("Literal", [conjure.str(v)]).build()
  )
  return conjure.id("S").method("Union", literals).build()
}

/**
 * Build an Effect Schema expression for a base type.
 * Returns S.<Type> expression.
 */
function buildEffectSchemaType(
  field: Field,
  enums: readonly EnumEntity[],
  extensions: readonly ExtensionInfo[],
): n.Expression {
  // Use shared field type resolution
  const resolved = resolveFieldType(field, enums, extensions)

  // If resolved to an enum, build enum schema
  if (resolved.enumDef) {
    return buildEnumSchema(resolved.enumDef)
  }

  // Special cases that need specific Effect Schema types
  // UUID -> S.UUID (more specific than just S.String)
  if (isUuidType(field)) {
    return conjure.id("S").prop("UUID").build()
  }

  // Date/timestamp -> S.Date
  if (isDateType(field)) {
    return conjure.id("S").prop("Date").build()
  }

  // BigInt (int8) -> S.BigInt
  if (isBigIntType(field)) {
    return conjure.id("S").prop("BigInt").build()
  }

  // Use the resolved TsType
  return tsTypeToEffectSchema(resolved.tsType)
}

/**
 * Wrap schema with S.NullOr if nullable
 */
function wrapNullable(schema: n.Expression, nullable: boolean): n.Expression {
  if (!nullable) return schema
  return conjure.id("S").method("NullOr", [schema]).build()
}

/**
 * Wrap schema with S.Array if array type
 */
function wrapArray(schema: n.Expression, isArray: boolean): n.Expression {
  if (!isArray) return schema
  return conjure.id("S").method("Array", [schema]).build()
}

/**
 * Wrap schema with Model.Generated
 */
function wrapGenerated(schema: n.Expression): n.Expression {
  return conjure.id("Model").method("Generated", [schema]).build()
}

/**
 * Wrap schema with Model.Sensitive
 * Model.Sensitive excludes the field from JSON variants
 */
function wrapSensitive(schema: n.Expression): n.Expression {
  return conjure.id("Model").method("Sensitive", [schema]).build()
}

/**
 * Wrap schema with Model.FieldOption to make optional in insert variant
 * Model.FieldOption(schema) allows the field to be omitted on insert
 */
function wrapFieldOption(schema: n.Expression): n.Expression {
  return conjure.id("Model").method("FieldOption", [schema]).build()
}

/**
 * Determine if a field should be treated as DB-generated.
 * 
 * Generated fields are excluded from insert variants by Model.Generated.
 * 
 * This includes:
 * - GENERATED ALWAYS columns (isGenerated)
 * - IDENTITY columns (isIdentity)
 * - Primary key fields with defaults (like UUID with gen_random_uuid())
 * 
 * Note: We intentionally ignore ACL permissions here - they're runtime concerns,
 * not type generation concerns. The model represents the table structure.
 */
function isDbGenerated(field: Field, entity: TableEntity): boolean {
  // Explicit generated/identity columns
  if (field.isGenerated || field.isIdentity) {
    return true
  }
  
  // Primary key fields with defaults should be treated as generated
  // (e.g., UUID with gen_random_uuid())
  if (field.hasDefault && entity.primaryKey) {
    const isPkColumn = entity.primaryKey.columns.includes(field.columnName)
    if (isPkColumn) {
      return true
    }
  }
  
  return false
}

/**
 * Check if a field should use auto-timestamp generation.
 * 
 * Matches common patterns like created_at, updated_at with defaults.
 */
function isAutoTimestamp(field: Field): { kind: "insert" | "update" } | undefined {
  if (!field.hasDefault) return undefined
  
  const name = field.columnName.toLowerCase()
  
  // created_at pattern - set on insert only
  if (name === "created_at" || name === "createdat") {
    return { kind: "insert" }
  }
  
  // updated_at pattern - set on insert and update
  if (name === "updated_at" || name === "updatedat") {
    return { kind: "update" }
  }
  
  return undefined
}

/**
 * Build the complete field schema expression.
 * 
 * Uses clean @effect/sql Model patterns:
 * - Model.Generated(schema) for DB-generated fields
 * - Model.Sensitive(schema) for fields hidden from JSON
 * - Model.DateTimeInsertFromDate for created_at patterns
 * - Model.DateTimeUpdateFromDate for updated_at patterns
 * - Plain schema for regular fields
 */
function buildFieldSchema(
  field: Field,
  entity: TableEntity,
  enums: readonly EnumEntity[],
  extensions: readonly ExtensionInfo[],
): n.Expression {
  // Start with the base type
  let schema = buildEffectSchemaType(field, enums, extensions)

  // Wrap with array if needed
  schema = wrapArray(schema, field.isArray)

  // Wrap with nullable if needed
  schema = wrapNullable(schema, field.nullable)
  
  // Check for insert optionality override via smart tag
  const insertOverride = getInsertOverride(field)
  
  // Check for sensitive smart tag - use Model.Sensitive
  if (isSensitive(field)) {
    schema = wrapSensitive(schema)
  }
  
  // Check for auto-timestamp patterns
  const autoTs = isAutoTimestamp(field)
  if (autoTs) {
    // Use the appropriate DateTime helper based on pattern
    if (autoTs.kind === "insert") {
      return conjure.id("Model").prop("DateTimeInsertFromDate").build()
    } else {
      return conjure.id("Model").prop("DateTimeUpdateFromDate").build()
    }
  }

  // Determine if field should be treated as generated
  // `insert: "required"` overrides the default generated behavior
  const shouldBeGenerated = insertOverride === "required" 
    ? (field.isGenerated || field.isIdentity) // Only truly generated, not "has default"
    : isDbGenerated(field, entity)

  if (shouldBeGenerated) {
    schema = wrapGenerated(schema)
  } else if (insertOverride === "optional") {
    // Smart tag requests optional on insert
    schema = wrapFieldOption(schema)
  }

  return schema
}

/**
 * Build Model.Class definition for an entity
 *
 * @param entity - The entity to generate
 * @param className - The inflected class name (e.g., "Users" for table "users")
 * @param enums - Enum entities for type lookup
 * @param extensions - Extension info for type mapping
 */
function buildModelClass(
  entity: TableEntity,
  className: string,
  enums: readonly EnumEntity[],
  extensions: readonly ExtensionInfo[],
): n.Expression {
  // Build the fields object
  let fieldsObj = obj()

  for (const field of entity.shapes.row.fields) {
    const schema = buildFieldSchema(field, entity, enums, extensions)
    fieldsObj = fieldsObj.prop(field.name, schema)
  }

  // Build: Model.Class<ClassName>("table_name")({ ... })
  // Note: className is inflected (e.g., "Users"), entity.name is the raw table name ("users")
  
  // First build Model.Class with type parameter
  const modelClassRef = conjure.b.memberExpression(
    conjure.b.identifier("Model"),
    conjure.b.identifier("Class")
  )
  
  // Create the call with type argument: Model.Class<ClassName>
  // The string argument is the raw table name for SQL queries
  const modelClassWithType = conjure.b.callExpression(modelClassRef, [
    conjure.str(entity.name)
  ])
  
  // Add type arguments to the call: Model.Class<ClassName>
  // Use typeParameters for TypeScript (not typeArguments which is for Flow)
  ;(modelClassWithType as { typeParameters?: unknown }).typeParameters = 
    conjure.b.tsTypeParameterInstantiation([
      conjure.b.tsTypeReference(conjure.b.identifier(className))
    ])
  
  // Now call that with the fields object: Model.Class<ClassName>("table_name")({ ... })
  const modelCall = conjure.b.callExpression(modelClassWithType, [
    fieldsObj.build()
  ])

  return modelCall
}

/**
 * Generate a Model class statement for an entity
 *
 * @param entity - The entity to generate
 * @param className - The inflected class name (e.g., "Users" for table "users")
 * @param enums - Enum entities for type lookup
 * @param extensions - Extension info for type mapping
 */
function generateModelStatement(
  entity: TableEntity,
  className: string,
  enums: readonly EnumEntity[],
  extensions: readonly ExtensionInfo[],
): SymbolStatement {
  const modelExpr = buildModelClass(entity, className, enums, extensions)

  // We need to generate:
  // export class ClassName extends Model.Class<ClassName>("table_name")({ ... }) {}
  //
  // This is a class declaration with extends - no type params on the class itself
  const classDecl = conjure.b.classDeclaration(
    conjure.b.identifier(className),
    conjure.b.classBody([]),
    toExprKind(modelExpr)  // superClass
  )

  const exportDecl = conjure.b.exportNamedDeclaration(classDecl, [])

  return {
    _tag: "SymbolStatement",
    node: exportDecl,
    symbol: {
      name: className,
      capability: "models:effect",
      entity: entity.name,  // Keep original entity name for lookups
      isType: false,
    },
  }
}

/**
 * Generate enum schema statement
 */
function generateEnumStatement(enumEntity: EnumEntity): SymbolStatement {
  const enumResult: EnumLookupResult = {
    name: enumEntity.name,
    pgName: enumEntity.pgName,
    values: enumEntity.values,
  }
  const schema = buildEnumSchema(enumResult)

  return exp.const(
    enumEntity.name,
    { capability: "models:effect", entity: enumEntity.name },
    schema,
  )
}

/**
 * Effect Model Plugin
 *
 * Generates @effect/sql Model classes for each entity.
 */
export const effectModelPlugin = definePlugin({
  name: "effect-model",
  provides: ["models:effect", "models"],
  configSchema: EffectModelPluginConfig,
  inflection: {
    outputFile: (ctx) => `${ctx.entityName}.ts`,
    symbolName: (entityName, _artifactKind) => entityName,
  },
  // Plugin defaults: PascalCase for entity/class names
  // Users can compose with additional transforms (e.g., singularize)
  inflectionDefaults: {
    entityName: inflect.pascalCase,
    enumName: inflect.pascalCase,
  },

  run: (ctx, config) => {
    const { ir } = ctx
    const enumStyle = config.enumStyle ?? "inline"

    // Get enum and table entities
    const enumEntities = getEnumEntities(ir)
    const tableEntities = getTableEntities(ir)

    // Generate enum files - each enum gets its own file (unless inline)
    if (enumStyle === "separate") {
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
          .import({ kind: "package", names: ["Schema as S"], from: "effect" })
          .ast(conjure.symbolProgram(statement))
          .emit()
      }
    }

    // Generate table/view entity model files
    for (const entity of tableEntities) {
      // Skip entities marked with @omit
      if (entity.tags.omit === true) continue

      // Get the inflected class name (e.g., "Users" for table "users")
      const className = ctx.inflection.entityName(entity.pgClass, entity.tags)

      const statements: SymbolStatement[] = []

      // Generate the Model class
      statements.push(generateModelStatement(entity, className, enumEntities, ir.extensions))

      // Build file name context for outputFile
      const fileNameCtx: FileNameContext = {
        entityName: className,
        pgName: entity.pgName,
        schema: entity.schemaName,
        inflection: ctx.inflection,
        entity,
      }
      const fileName = ctx.pluginInflection.outputFile(fileNameCtx)
      const filePath = `${config.outputDir}/${fileName}`

      ctx
        .file(filePath)
        .header("// This file is auto-generated. Do not edit.\n")
        .import({ kind: "package", names: ["Model"], from: "@effect/sql" })
        .import({ kind: "package", names: ["Schema as S"], from: "effect" })
        .ast(conjure.symbolProgram(...statements))
        .emit()
    }
  },
})

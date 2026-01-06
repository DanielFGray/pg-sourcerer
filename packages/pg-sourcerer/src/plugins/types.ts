/**
 * Types Plugin - Generate TypeScript interfaces for entities
 *
 * Generates Row, Insert, Update, and Patch interfaces for each entity.
 */
import { Schema as S } from "effect"
import recast from "recast"
import type { namedTypes as n } from "ast-types"
import { definePlugin } from "../services/plugin.js"
import {
  defaultPgToTs,
  findEnumByPgName,
  getExtensionTypeMapping,
  TsType,
} from "../services/pg-types.js"
import type { Field, Shape, Entity, EnumDef, ExtensionInfo } from "../ir/semantic-ir.js"

const b = recast.types.builders

/**
 * Type assertion helpers for recast AST nodes.
 *
 * The recast/ast-types library has type definitions that conflict with
 * exactOptionalPropertyTypes. These helpers provide safe casts.
 */
type AnyTSType = Parameters<typeof b.tsArrayType>[0]
type AnyStatement = Parameters<typeof b.program>[0][number]

/** Cast TSType for use in recast builders */
const asTSType = (node: n.TSType): AnyTSType => node as AnyTSType

/** Cast Statement for use in recast builders */
const asStatement = (node: n.Statement): AnyStatement => node as AnyStatement

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
      return b.tsStringKeyword()
    case TsType.Number:
      return b.tsNumberKeyword()
    case TsType.Boolean:
      return b.tsBooleanKeyword()
    case TsType.BigInt:
      return b.tsBigIntKeyword()
    case TsType.Date:
      return b.tsTypeReference(b.identifier("Date"))
    case TsType.Buffer:
      return b.tsTypeReference(b.identifier("Buffer"))
    case TsType.Unknown:
    default:
      return b.tsUnknownKeyword()
  }
}

/**
 * Resolve a field to its TypeScript AST type node
 */
function resolveFieldType(
  field: Field,
  enums: ReadonlyMap<string, EnumDef>,
  extensions: ReadonlyArray<ExtensionInfo>
): n.TSType {
  // Check for enum first
  if (isEnumType(field)) {
    const pgTypeName = getPgTypeName(field)
    if (pgTypeName) {
      const enumDef = findEnumByPgName(enums, pgTypeName)
      if (enumDef) {
        const baseType = b.tsTypeReference(b.identifier(enumDef.name))
        return field.isArray ? b.tsArrayType(baseType) : baseType
      }
    }
  }

  // Try OID-based mapping (precise, for built-in types)
  const oid = getTypeOid(field)
  if (oid !== undefined) {
    const tsType = defaultPgToTs(oid)
    if (tsType) {
      const baseType = tsTypeToAst(tsType)
      return field.isArray ? b.tsArrayType(asTSType(baseType)) : baseType
    }
  }

  // Try OID-based mapping for domain base types
  // (e.g., `url` domain over `text` -> map text OID 25 to string)
  if (field.domainBaseType) {
    const tsType = defaultPgToTs(field.domainBaseType.typeOid)
    if (tsType) {
      const baseType = tsTypeToAst(tsType)
      return field.isArray ? b.tsArrayType(asTSType(baseType)) : baseType
    }
  }

  // Try extension-based mapping for the direct type (for citext, ltree, etc.)
  const pgType = field.pgAttribute.getType()
  if (pgType) {
    const tsType = getExtensionTypeMapping(
      pgType.typname,
      String(pgType.typnamespace),
      extensions
    )
    if (tsType) {
      const baseType = tsTypeToAst(tsType)
      return field.isArray ? b.tsArrayType(asTSType(baseType)) : baseType
    }
  }

  // Try extension-based mapping for domain base types
  // (e.g., `username` domain over `citext` -> map citext to string)
  if (field.domainBaseType) {
    const tsType = getExtensionTypeMapping(
      field.domainBaseType.typeName,
      field.domainBaseType.namespaceOid,
      extensions
    )
    if (tsType) {
      const baseType = tsTypeToAst(tsType)
      return field.isArray ? b.tsArrayType(asTSType(baseType)) : baseType
    }
  }

  // For arrays, try to resolve element type
  if (field.isArray && field.elementTypeName) {
    // Check if element is an enum
    const enumDef = findEnumByPgName(enums, field.elementTypeName)
    if (enumDef) {
      return b.tsArrayType(b.tsTypeReference(b.identifier(enumDef.name)))
    }
  }

  // Fallback to unknown
  const unknownType = b.tsUnknownKeyword()
  return field.isArray ? b.tsArrayType(unknownType) : unknownType
}

/**
 * Wrap type with null union if nullable
 */
function wrapNullableAst(typeNode: n.TSType, nullable: boolean): n.TSType {
  if (!nullable) return typeNode
  return b.tsUnionType([asTSType(typeNode), b.tsNullKeyword()])
}

/**
 * Generate interface for a shape
 */
function generateShapeInterface(
  shape: Shape,
  enums: ReadonlyMap<string, EnumDef>,
  extensions: ReadonlyArray<ExtensionInfo>
): n.ExportNamedDeclaration {
  const properties = shape.fields.map((field) => {
    const baseType = resolveFieldType(field, enums, extensions)
    const typeWithNull = wrapNullableAst(baseType, field.nullable)

    const prop = b.tsPropertySignature(
      b.identifier(field.name),
      b.tsTypeAnnotation(asTSType(typeWithNull))
    )
    prop.optional = field.optional
    return prop
  })

  const interfaceDecl = b.tsInterfaceDeclaration(
    b.identifier(shape.name),
    b.tsInterfaceBody(properties)
  )

  return b.exportNamedDeclaration(interfaceDecl)
}

/**
 * Generate enum type alias
 */
function generateEnumType(enumDef: EnumDef): n.ExportNamedDeclaration {
  const unionType = b.tsUnionType(
    enumDef.values.map((value) => b.tsLiteralType(b.stringLiteral(value)))
  )

  const typeAlias = b.tsTypeAliasDeclaration(
    b.identifier(enumDef.name),
    unionType
  )

  return b.exportNamedDeclaration(typeAlias)
}

/**
 * Generate file content for an entity
 */
function generateEntityFile(
  entity: Entity,
  enums: ReadonlyMap<string, EnumDef>,
  extensions: ReadonlyArray<ExtensionInfo>,
  usedEnums: Set<string>
): string {
  const declarations: n.Statement[] = []

  // Generate each shape
  const { row, insert, update, patch } = entity.shapes

  declarations.push(generateShapeInterface(row, enums, extensions))

  if (insert) {
    declarations.push(generateShapeInterface(insert, enums, extensions))
  }

  if (update) {
    declarations.push(generateShapeInterface(update, enums, extensions))
  }

  if (patch) {
    declarations.push(generateShapeInterface(patch, enums, extensions))
  }

  // Collect enum imports needed
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

  const program = b.program(declarations.map(asStatement))
  return recast.print(program).code
}

/**
 * Generate file content for enums
 */
function generateEnumsFile(enums: ReadonlyMap<string, EnumDef>): string {
  const declarations: n.Statement[] = []

  for (const enumDef of enums.values()) {
    declarations.push(generateEnumType(enumDef))
  }

  const program = b.program(declarations.map(asStatement))
  return recast.print(program).code
}

/**
 * Types Plugin
 *
 * Generates TypeScript interfaces for each entity's shapes (Row, Insert, Update, Patch)
 * and type aliases for PostgreSQL enums.
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
    const { ir } = ctx
    const usedEnumsByEntity = new Map<string, Set<string>>()

    // Generate enum types file if there are enums
    if (ir.enums.size > 0) {
      const enumsContent = generateEnumsFile(ir.enums)
      const enumsPath = `${config.outputDir}/enums.ts`

      // Add header
      const header = "// This file is auto-generated. Do not edit.\n\n"
      ctx.emit(enumsPath, header + enumsContent)

      // Register enum symbols
      for (const enumDef of ir.enums.values()) {
        ctx.symbols.register(
          {
            name: enumDef.name,
            file: enumsPath,
            capability: "types",
            entity: enumDef.name,
            isType: true,
            isDefault: false,
          },
          ctx.pluginName
        )
      }
    }

    // Generate entity type files
    for (const [name, entity] of ir.entities) {
      // Skip entities marked with @omit
      if (entity.tags.omit === true) continue

      const usedEnums = new Set<string>()
      usedEnumsByEntity.set(name, usedEnums)

      const content = generateEntityFile(entity, ir.enums, ir.extensions, usedEnums)
      const filePath = `${config.outputDir}/${ctx.inflection.entityName(entity.pgClass, entity.tags)}.ts`

      // Build imports for enums
      let imports = ""
      if (usedEnums.size > 0 && ir.enums.size > 0) {
        const enumImports = [...usedEnums].sort().join(", ")
        imports = `import type { ${enumImports} } from "./enums.js"\n\n`
      }

      // Add header
      const header = "// This file is auto-generated. Do not edit.\n\n"
      ctx.emit(filePath, header + imports + content)

      // Register symbols for each shape
      const { row, insert, update, patch } = entity.shapes

      ctx.symbols.register(
        {
          name: row.name,
          file: filePath,
          capability: "types",
          entity: name,
          shape: "row",
          isType: true,
          isDefault: false,
        },
        ctx.pluginName
      )

      if (insert) {
        ctx.symbols.register(
          {
            name: insert.name,
            file: filePath,
            capability: "types",
            entity: name,
            shape: "insert",
            isType: true,
            isDefault: false,
          },
          ctx.pluginName
        )
      }

      if (update) {
        ctx.symbols.register(
          {
            name: update.name,
            file: filePath,
            capability: "types",
            entity: name,
            shape: "update",
            isType: true,
            isDefault: false,
          },
          ctx.pluginName
        )
      }

      if (patch) {
        ctx.symbols.register(
          {
            name: patch.name,
            file: filePath,
            capability: "types",
            entity: name,
            shape: "patch",
            isType: true,
            isDefault: false,
          },
          ctx.pluginName
        )
      }
    }
  },
})

/**
 * Types Plugin - Generate TypeScript interfaces for entities
 *
 * Generates Row, Insert, Update, and Patch interfaces for each entity.
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
import { conjure, cast } from "../lib/conjure.js"

const { ts, program, b } = conjure
const { asTSType } = cast

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
        const baseType = ts.ref(enumDef.name)
        return field.isArray ? ts.array(baseType) : baseType
      }
    }
  }

  // Try OID-based mapping (precise, for built-in types)
  const oid = getTypeOid(field)
  if (oid !== undefined) {
    const tsTypeName = defaultPgToTs(oid)
    if (tsTypeName) {
      const baseType = tsTypeToAst(tsTypeName)
      return field.isArray ? ts.array(baseType) : baseType
    }
  }

  // Try OID-based mapping for domain base types
  // (e.g., `url` domain over `text` -> map text OID 25 to string)
  if (field.domainBaseType) {
    const tsTypeName = defaultPgToTs(field.domainBaseType.typeOid)
    if (tsTypeName) {
      const baseType = tsTypeToAst(tsTypeName)
      return field.isArray ? ts.array(baseType) : baseType
    }
  }

  // Try extension-based mapping for the direct type (for citext, ltree, etc.)
  const pgType = field.pgAttribute.getType()
  if (pgType) {
    const tsTypeName = getExtensionTypeMapping(
      pgType.typname,
      String(pgType.typnamespace),
      extensions
    )
    if (tsTypeName) {
      const baseType = tsTypeToAst(tsTypeName)
      return field.isArray ? ts.array(baseType) : baseType
    }
  }

  // Try extension-based mapping for domain base types
  // (e.g., `username` domain over `citext` -> map citext to string)
  if (field.domainBaseType) {
    const tsTypeName = getExtensionTypeMapping(
      field.domainBaseType.typeName,
      field.domainBaseType.namespaceOid,
      extensions
    )
    if (tsTypeName) {
      const baseType = tsTypeToAst(tsTypeName)
      return field.isArray ? ts.array(baseType) : baseType
    }
  }

  // For arrays, try to resolve element type
  if (field.isArray && field.elementTypeName) {
    // Check if element is an enum
    const enumDef = findEnumByPgName(enums, field.elementTypeName)
    if (enumDef) {
      return ts.array(ts.ref(enumDef.name))
    }
  }

  // Fallback to unknown
  return field.isArray ? ts.array(ts.unknown()) : ts.unknown()
}

/**
 * Wrap type with null union if nullable
 */
function wrapNullableAst(typeNode: n.TSType, nullable: boolean): n.TSType {
  if (!nullable) return typeNode
  return ts.union(typeNode, ts.null())
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
  const unionType = ts.union(...enumDef.values.map((value) => ts.literal(value)))

  const typeAlias = b.tsTypeAliasDeclaration(
    b.identifier(enumDef.name),
    unionType
  )

  return b.exportNamedDeclaration(typeAlias)
}

/**
 * Generate AST for an entity's interfaces
 */
function generateEntityAst(
  entity: Entity,
  enums: ReadonlyMap<string, EnumDef>,
  extensions: ReadonlyArray<ExtensionInfo>,
  usedEnums: Set<string>
): n.Program {
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

  return program(...declarations)
}

/**
 * Generate AST for enums file
 */
function generateEnumsAst(enums: ReadonlyMap<string, EnumDef>): n.Program {
  const declarations: n.Statement[] = []

  for (const enumDef of enums.values()) {
    declarations.push(generateEnumType(enumDef))
  }

  return program(...declarations)
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
      const enumsAst = generateEnumsAst(ir.enums)
      const enumsPath = `${config.outputDir}/enums.ts`

      // Emit AST with header
      const header = "// This file is auto-generated. Do not edit.\n\n"
      ctx.emitAst(enumsPath, enumsAst, header)

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

      const ast = generateEntityAst(entity, ir.enums, ir.extensions, usedEnums)
      const filePath = `${config.outputDir}/${ctx.inflection.entityName(entity.pgClass, entity.tags)}.ts`

      // Build header with imports
      let header = "// This file is auto-generated. Do not edit.\n\n"
      if (usedEnums.size > 0 && ir.enums.size > 0) {
        const enumImports = [...usedEnums].sort().join(", ")
        header += `import type { ${enumImports} } from "./enums.js"\n\n`
      }

      ctx.emitAst(filePath, ast, header)

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

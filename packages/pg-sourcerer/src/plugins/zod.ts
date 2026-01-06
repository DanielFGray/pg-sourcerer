/**
 * Zod Plugin - Generate Zod schemas for entities
 *
 * Generates Zod schemas for Row, Insert, Update, and Patch shapes,
 * with inferred TypeScript types.
 */
import { Schema as S } from "effect"
import type { namedTypes as n } from "ast-types"
import { definePlugin } from "../services/plugin.js"
import {
  defaultPgToTs,
  findEnumByPgName,
  getExtensionTypeMapping,
  TsType,
  PgTypeOid,
} from "../services/pg-types.js"
import type { Field, Shape, Entity, EnumDef, ExtensionInfo } from "../ir/semantic-ir.js"
import { conjure, cast } from "../lib/conjure.js"

const { ts, program, b, obj } = conjure
const { asPropValue, asExpr } = cast

/**
 * Plugin configuration schema
 *
 * Note: Both fields are required in the schema. Defaults are applied when
 * creating the plugin config, not via Schema.optionalWith, to avoid
 * type conflicts with exactOptionalPropertyTypes.
 */
const ZodPluginConfig = S.Struct({
  /** Output directory relative to main outputDir */
  outputDir: S.String,
  /** Export inferred types alongside schemas */
  exportTypes: S.Boolean,
})

/** Default configuration values */
const defaultConfig = { outputDir: "schemas", exportTypes: true } as const

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
 * Check if this field is a UUID type
 */
function isUuidType(field: Field): boolean {
  const oid = getTypeOid(field)
  return oid === PgTypeOid.Uuid
}

/**
 * Check if this field is a date/timestamp type
 */
function isDateType(field: Field): boolean {
  const oid = getTypeOid(field)
  return (
    oid === PgTypeOid.Date ||
    oid === PgTypeOid.Timestamp ||
    oid === PgTypeOid.TimestampTz
  )
}

/**
 * Build a Zod method chain expression.
 * Starts with z.<method>() and chains additional methods.
 *
 * @example
 * buildZodChain("string", ["uuid", "nullable"])
 * // => z.string().uuid().nullable()
 */
function buildZodChain(baseMethod: string, chainMethods: string[]): n.Expression {
  let chain = conjure.id("z").method(baseMethod)
  for (const method of chainMethods) {
    chain = chain.method(method)
  }
  return chain.build()
}

/**
 * Build a Zod enum expression.
 *
 * @example
 * buildZodEnum(["admin", "user"])
 * // => z.enum(["admin", "user"])
 */
function buildZodEnum(values: readonly string[]): n.Expression {
  return conjure
    .id("z")
    .method("enum", [conjure.arr(...values.map((v) => conjure.str(v))).build()])
    .build()
}

/**
 * Build z.array(<inner>)
 */
function buildZodArray(inner: n.Expression): n.Expression {
  return conjure.id("z").method("array", [inner]).build()
}

/**
 * Add method calls to an expression
 */
function chainMethods(expr: n.Expression, methods: string[]): n.Expression {
  let chain = conjure.chain(expr)
  for (const method of methods) {
    chain = chain.method(method)
  }
  return chain.build()
}

/**
 * Resolve a field to its Zod schema expression
 */
function resolveFieldZodSchema(
  field: Field,
  enums: ReadonlyMap<string, EnumDef>,
  extensions: ReadonlyArray<ExtensionInfo>
): n.Expression {
  const modifiers: string[] = []

  // Check for enum first
  if (isEnumType(field)) {
    const pgTypeName = getPgTypeName(field)
    if (pgTypeName) {
      const enumDef = findEnumByPgName(enums, pgTypeName)
      if (enumDef) {
        let schema = buildZodEnum(enumDef.values)
        if (field.isArray) {
          schema = buildZodArray(schema)
        }
        if (field.nullable) {
          schema = chainMethods(schema, ["nullable"])
        }
        if (field.optional) {
          schema = chainMethods(schema, ["optional"])
        }
        return schema
      }
    }
  }

  // Determine base Zod type and modifiers
  let baseZodType = "unknown"
  const zodModifiers: string[] = []

  // Check for UUID - use z.string().uuid()
  if (isUuidType(field)) {
    baseZodType = "string"
    zodModifiers.push("uuid")
  }
  // Check for date/timestamp - use z.coerce.date()
  else if (isDateType(field)) {
    // z.coerce.date() is different - needs special handling
    let schema: n.Expression = conjure.id("z").prop("coerce").method("date").build()

    if (field.isArray) {
      schema = buildZodArray(schema)
    }
    if (field.nullable) {
      schema = chainMethods(schema, ["nullable"])
    }
    if (field.optional) {
      schema = chainMethods(schema, ["optional"])
    }
    return schema
  } else {
    // Try OID-based mapping
    const oid = getTypeOid(field)
    if (oid !== undefined) {
      const tsType = defaultPgToTs(oid)
      if (tsType) {
        baseZodType = tsTypeToZodMethod(tsType)
      }
    }

    // Try domain base type mapping
    if (baseZodType === "unknown" && field.domainBaseType) {
      const tsType = defaultPgToTs(field.domainBaseType.typeOid)
      if (tsType) {
        baseZodType = tsTypeToZodMethod(tsType)
      }
    }

    // Try extension-based mapping
    if (baseZodType === "unknown") {
      const pgType = field.pgAttribute.getType()
      if (pgType) {
        const tsType = getExtensionTypeMapping(
          pgType.typname,
          String(pgType.typnamespace),
          extensions
        )
        if (tsType) {
          baseZodType = tsTypeToZodMethod(tsType)
        }
      }
    }

    // Try extension mapping for domain base types
    if (baseZodType === "unknown" && field.domainBaseType) {
      const tsType = getExtensionTypeMapping(
        field.domainBaseType.typeName,
        field.domainBaseType.namespaceOid,
        extensions
      )
      if (tsType) {
        baseZodType = tsTypeToZodMethod(tsType)
      }
    }
  }

  // Build the schema
  let schema = buildZodChain(baseZodType, zodModifiers)

  if (field.isArray) {
    schema = buildZodArray(schema)
  }
  if (field.nullable) {
    schema = chainMethods(schema, ["nullable"])
  }
  if (field.optional) {
    schema = chainMethods(schema, ["optional"])
  }

  return schema
}

/**
 * Map TypeScript type to Zod method name
 */
function tsTypeToZodMethod(tsType: string): string {
  switch (tsType) {
    case TsType.String:
      return "string"
    case TsType.Number:
      return "number"
    case TsType.Boolean:
      return "boolean"
    case TsType.BigInt:
      return "bigint"
    case TsType.Date:
      // Note: for Date we use z.coerce.date() which is handled specially
      return "date"
    case TsType.Buffer:
      // Zod doesn't have a native Buffer type, use unknown
      return "unknown"
    case TsType.Unknown:
    default:
      return "unknown"
  }
}

/**
 * Generate a Zod schema for a shape
 *
 * @example
 * // Generates:
 * export const UserRow = z.object({
 *   id: z.string().uuid(),
 *   username: z.string(),
 * })
 */
function generateShapeSchema(
  shape: Shape,
  enums: ReadonlyMap<string, EnumDef>,
  extensions: ReadonlyArray<ExtensionInfo>
): n.ExportNamedDeclaration {
  // Build object properties using conjure.obj()
  let objBuilder = obj()
  for (const field of shape.fields) {
    const zodSchema = resolveFieldZodSchema(field, enums, extensions)
    objBuilder = objBuilder.prop(field.name, zodSchema)
  }

  const schemaExpr = conjure.id("z").method("object", [objBuilder.build()]).build()

  const variableDecl = b.variableDeclaration("const", [
    b.variableDeclarator(b.identifier(shape.name), asExpr(schemaExpr)),
  ])

  return b.exportNamedDeclaration(variableDecl)
}

/**
 * Generate inferred type export for a shape
 *
 * @example
 * // Generates:
 * export type UserRow = z.infer<typeof UserRow>
 */
function generateShapeTypeExport(shapeName: string): n.ExportNamedDeclaration {
  // Build: z.infer<typeof ShapeName>
  const inferType = ts.qualifiedRef("z", "infer", [ts.typeof(shapeName)])

  const typeAlias = b.tsTypeAliasDeclaration(b.identifier(shapeName), inferType)

  return b.exportNamedDeclaration(typeAlias)
}

/**
 * Generate AST for an entity's Zod schemas
 */
function generateEntityAst(
  entity: Entity,
  enums: ReadonlyMap<string, EnumDef>,
  extensions: ReadonlyArray<ExtensionInfo>,
  exportTypes: boolean
): n.Program {
  const declarations: n.Statement[] = []

  const { row, insert, update, patch } = entity.shapes

  // Generate Row schema and type
  declarations.push(generateShapeSchema(row, enums, extensions))
  if (exportTypes) {
    declarations.push(generateShapeTypeExport(row.name))
  }

  // Generate Insert schema and type
  if (insert) {
    declarations.push(generateShapeSchema(insert, enums, extensions))
    if (exportTypes) {
      declarations.push(generateShapeTypeExport(insert.name))
    }
  }

  // Generate Update schema and type
  if (update) {
    declarations.push(generateShapeSchema(update, enums, extensions))
    if (exportTypes) {
      declarations.push(generateShapeTypeExport(update.name))
    }
  }

  // Generate Patch schema and type
  if (patch) {
    declarations.push(generateShapeSchema(patch, enums, extensions))
    if (exportTypes) {
      declarations.push(generateShapeTypeExport(patch.name))
    }
  }

  return program(...declarations)
}

/**
 * Zod Plugin
 *
 * Generates Zod schemas for each entity's shapes (Row, Insert, Update, Patch)
 * with inferred TypeScript types.
 */
export const zodPlugin = definePlugin({
  name: "zod",
  provides: ["schemas:zod", "schemas"],
  configSchema: ZodPluginConfig,
  inflection: {
    outputFile: (entityName, _artifactKind) => `${entityName}.ts`,
    symbolName: (entityName, artifactKind) => `${entityName}${artifactKind}`,
  },

  run: (ctx, config) => {
    const { ir } = ctx

    // Generate entity schema files
    for (const [name, entity] of ir.entities) {
      // Skip entities marked with @omit
      if (entity.tags.omit === true) continue

      const ast = generateEntityAst(
        entity,
        ir.enums,
        ir.extensions,
        config.exportTypes
      )

      const filePath = `${config.outputDir}/${ctx.inflection.entityName(entity.pgClass, entity.tags)}.ts`

      // Build header with zod import
      const header = '// This file is auto-generated. Do not edit.\n\nimport { z } from "zod"\n\n'
      ctx.emitAst(filePath, ast, header)

      // Register symbols for each shape
      const { row, insert, update, patch } = entity.shapes

      ctx.symbols.register(
        {
          name: row.name,
          file: filePath,
          capability: "schemas:zod",
          entity: name,
          shape: "row",
          isType: false,
          isDefault: false,
        },
        ctx.pluginName
      )

      if (config.exportTypes) {
        ctx.symbols.register(
          {
            name: row.name,
            file: filePath,
            capability: "schemas:zod",
            entity: name,
            shape: "row",
            isType: true,
            isDefault: false,
          },
          ctx.pluginName
        )
      }

      if (insert) {
        ctx.symbols.register(
          {
            name: insert.name,
            file: filePath,
            capability: "schemas:zod",
            entity: name,
            shape: "insert",
            isType: false,
            isDefault: false,
          },
          ctx.pluginName
        )

        if (config.exportTypes) {
          ctx.symbols.register(
            {
              name: insert.name,
              file: filePath,
              capability: "schemas:zod",
              entity: name,
              shape: "insert",
              isType: true,
              isDefault: false,
            },
            ctx.pluginName
          )
        }
      }

      if (update) {
        ctx.symbols.register(
          {
            name: update.name,
            file: filePath,
            capability: "schemas:zod",
            entity: name,
            shape: "update",
            isType: false,
            isDefault: false,
          },
          ctx.pluginName
        )

        if (config.exportTypes) {
          ctx.symbols.register(
            {
              name: update.name,
              file: filePath,
              capability: "schemas:zod",
              entity: name,
              shape: "update",
              isType: true,
              isDefault: false,
            },
            ctx.pluginName
          )
        }
      }

      if (patch) {
        ctx.symbols.register(
          {
            name: patch.name,
            file: filePath,
            capability: "schemas:zod",
            entity: name,
            shape: "patch",
            isType: false,
            isDefault: false,
          },
          ctx.pluginName
        )

        if (config.exportTypes) {
          ctx.symbols.register(
            {
              name: patch.name,
              file: filePath,
              capability: "schemas:zod",
              entity: name,
              shape: "patch",
              isType: true,
              isDefault: false,
            },
            ctx.pluginName
          )
        }
      }
    }
  },
})

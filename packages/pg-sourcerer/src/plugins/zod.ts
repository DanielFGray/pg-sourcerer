/**
 * Zod Plugin - Generate Zod schemas for entities
 *
 * Generates Zod schemas for Row, Insert, Update, and Patch shapes,
 * with inferred TypeScript types.
 */
import { Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";
import { definePlugin } from "../services/plugin.js";
import {
  defaultPgToTs,
  findEnumByPgName,
  getExtensionTypeMapping,
  TsType,
  PgTypeOid,
} from "../services/pg-types.js";
import type { Field, Shape, EnumDef, ExtensionInfo } from "../ir/semantic-ir.js";
import { conjure } from "../lib/conjure.js";
import type { SymbolStatement } from "../lib/conjure.js";

const { ts, exp, obj } = conjure;

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
});

/**
 * Get the TypeScript type OID from a field's pg attribute
 */
function getTypeOid(field: Field): number | undefined {
  const pgType = field.pgAttribute.getType();
  if (!pgType?._id) return undefined;
  return Number(pgType._id);
}

/**
 * Check if a field's type is an enum
 */
function isEnumType(field: Field): boolean {
  const pgType = field.pgAttribute.getType();
  return pgType?.typtype === "e";
}

/**
 * Get the PostgreSQL type name from a field
 */
function getPgTypeName(field: Field): string | undefined {
  // For arrays, get the element type name
  if (field.isArray && field.elementTypeName) {
    return field.elementTypeName;
  }
  return field.pgAttribute.getType()?.typname;
}

/**
 * Check if this field is a UUID type
 */
function isUuidType(field: Field): boolean {
  const oid = getTypeOid(field);
  return oid === PgTypeOid.Uuid;
}

/**
 * Check if this field is a date/timestamp type
 */
function isDateType(field: Field): boolean {
  const oid = getTypeOid(field);
  return oid === PgTypeOid.Date || oid === PgTypeOid.Timestamp || oid === PgTypeOid.TimestampTz;
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
  let chain = conjure.id("z").method(baseMethod);
  for (const method of chainMethods) {
    chain = chain.method(method);
  }
  return chain.build();
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
    .method("enum", [conjure.arr(...values.map(v => conjure.str(v))).build()])
    .build();
}

/**
 * Build z.array(<inner>)
 */
function buildZodArray(inner: n.Expression): n.Expression {
  return conjure.id("z").method("array", [inner]).build();
}

/**
 * Add method calls to an expression
 */
function chainMethods(expr: n.Expression, methods: string[]): n.Expression {
  let chain = conjure.chain(expr);
  for (const method of methods) {
    chain = chain.method(method);
  }
  return chain.build();
}

/**
 * Resolve a field to its Zod schema expression
 */
function resolveFieldZodSchema(
  field: Field,
  enums: ReadonlyMap<string, EnumDef>,
  extensions: readonly ExtensionInfo[],
): n.Expression {
  // modifiers array reserved for future use (e.g., .min(), .max() from smart tags)

  // Check for enum first
  if (isEnumType(field)) {
    const pgTypeName = getPgTypeName(field);
    if (pgTypeName) {
      const enumDef = findEnumByPgName(enums, pgTypeName);
      if (enumDef) {
        let schema = buildZodEnum(enumDef.values);
        if (field.isArray) {
          schema = buildZodArray(schema);
        }
        if (field.nullable) {
          schema = chainMethods(schema, ["nullable"]);
        }
        if (field.optional) {
          schema = chainMethods(schema, ["optional"]);
        }
        return schema;
      }
    }
  }

  // Determine base Zod type and modifiers
  let baseZodType = "unknown";
  const zodModifiers: string[] = [];

  // Check for UUID - use z.string().uuid()
  if (isUuidType(field)) {
    baseZodType = "string";
    zodModifiers.push("uuid");
  }
  // Check for date/timestamp - use z.coerce.date()
  else if (isDateType(field)) {
    // z.coerce.date() is different - needs special handling
    let schema: n.Expression = conjure.id("z").prop("coerce").method("date").build();

    if (field.isArray) {
      schema = buildZodArray(schema);
    }
    if (field.nullable) {
      schema = chainMethods(schema, ["nullable"]);
    }
    if (field.optional) {
      schema = chainMethods(schema, ["optional"]);
    }
    return schema;
  } else {
    // Try OID-based mapping
    const oid = getTypeOid(field);
    if (oid !== undefined) {
      const tsType = defaultPgToTs(oid);
      if (tsType) {
        baseZodType = tsTypeToZodMethod(tsType);
      }
    }

    // Try domain base type mapping
    if (baseZodType === "unknown" && field.domainBaseType) {
      const tsType = defaultPgToTs(field.domainBaseType.typeOid);
      if (tsType) {
        baseZodType = tsTypeToZodMethod(tsType);
      }
    }

    // Try extension-based mapping
    if (baseZodType === "unknown") {
      const pgType = field.pgAttribute.getType();
      if (pgType) {
        const tsType = getExtensionTypeMapping(
          pgType.typname,
          String(pgType.typnamespace),
          extensions,
        );
        if (tsType) {
          baseZodType = tsTypeToZodMethod(tsType);
        }
      }
    }

    // Try extension mapping for domain base types
    if (baseZodType === "unknown" && field.domainBaseType) {
      const tsType = getExtensionTypeMapping(
        field.domainBaseType.typeName,
        field.domainBaseType.namespaceOid,
        extensions,
      );
      if (tsType) {
        baseZodType = tsTypeToZodMethod(tsType);
      }
    }
  }

  // Build the schema
  let schema = buildZodChain(baseZodType, zodModifiers);

  if (field.isArray) {
    schema = buildZodArray(schema);
  }
  if (field.nullable) {
    schema = chainMethods(schema, ["nullable"]);
  }
  if (field.optional) {
    schema = chainMethods(schema, ["optional"]);
  }

  return schema;
}

/**
 * Map TypeScript type to Zod method name
 */
function tsTypeToZodMethod(tsType: string): string {
  switch (tsType) {
    case TsType.String:
      return "string";
    case TsType.Number:
      return "number";
    case TsType.Boolean:
      return "boolean";
    case TsType.BigInt:
      return "bigint";
    case TsType.Date:
      // Note: for Date we use z.coerce.date() which is handled specially
      return "date";
    case TsType.Buffer:
      // Zod doesn't have a native Buffer type, use unknown
      return "unknown";
    case TsType.Unknown:
    default:
      return "unknown";
  }
}

/**
 * Build a z.object({...}) expression for a shape
 */
function buildShapeZodObject(
  shape: Shape,
  enums: ReadonlyMap<string, EnumDef>,
  extensions: readonly ExtensionInfo[],
): n.Expression {
  let objBuilder = obj();
  for (const field of shape.fields) {
    const zodSchema = resolveFieldZodSchema(field, enums, extensions);
    objBuilder = objBuilder.prop(field.name, zodSchema);
  }
  return conjure.id("z").method("object", [objBuilder.build()]).build();
}

/**
 * Generate schema and type statements for a shape using exp.const() and exp.type()
 */
function generateShapeStatements(
  shape: Shape,
  enums: ReadonlyMap<string, EnumDef>,
  extensions: readonly ExtensionInfo[],
  entityName: string,
  shapeKind: "row" | "insert" | "update" | "patch",
  exportTypes: boolean,
): SymbolStatement[] {
  const statements: SymbolStatement[] = [];

  // Generate: export const ShapeName = z.object({...})
  const schemaExpr = buildShapeZodObject(shape, enums, extensions);
  statements.push(
    exp.const(
      shape.name,
      { capability: "schemas:zod", entity: entityName, shape: shapeKind },
      schemaExpr,
    ),
  );

  // Generate: export type ShapeName = z.infer<typeof ShapeName>
  if (exportTypes) {
    const inferType = ts.qualifiedRef("z", "infer", [ts.typeof(shape.name)]);
    statements.push(
      exp.type(
        shape.name,
        { capability: "schemas:zod", entity: entityName, shape: shapeKind },
        inferType,
      ),
    );
  }

  return statements;
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
    const { ir } = ctx;

    // Generate entity schema files
    for (const [name, entity] of ir.entities) {
      // Skip entities marked with @omit
      if (entity.tags.omit === true) continue;

      const statements: SymbolStatement[] = [];
      const { row, insert, update, patch } = entity.shapes;

      // Generate Row schema and type
      statements.push(
        ...generateShapeStatements(row, ir.enums, ir.extensions, name, "row", config.exportTypes),
      );

      // Generate Insert schema and type
      if (insert) {
        statements.push(
          ...generateShapeStatements(
            insert,
            ir.enums,
            ir.extensions,
            name,
            "insert",
            config.exportTypes,
          ),
        );
      }

      // Generate Update schema and type
      if (update) {
        statements.push(
          ...generateShapeStatements(
            update,
            ir.enums,
            ir.extensions,
            name,
            "update",
            config.exportTypes,
          ),
        );
      }

      // Generate Patch schema and type
      if (patch) {
        statements.push(
          ...generateShapeStatements(
            patch,
            ir.enums,
            ir.extensions,
            name,
            "patch",
            config.exportTypes,
          ),
        );
      }

      const filePath = `${config.outputDir}/${ctx.inflection.entityName(entity.pgClass, entity.tags)}.ts`;

      ctx
        .file(filePath)
        .header("// This file is auto-generated. Do not edit.\n")
        .import({ kind: "package", names: ["z"], from: "zod" })
        .ast(conjure.symbolProgram(...statements))
        .emit();
    }
  },
});

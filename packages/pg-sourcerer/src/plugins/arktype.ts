/**
 * ArkType Plugin - Generate ArkType schemas for entities
 *
 * Generates ArkType type definitions for Row, Insert, Update, and Patch shapes,
 * with inferred TypeScript types.
 *
 * ArkType uses string-based syntax for type definitions:
 * - `type({ foo: "string", bar: "number?" })` for objects
 * - `"string | null"` for nullable
 * - `"string[]"` for arrays
 * - Union syntax `"'a' | 'b' | 'c'"` for enums
 */
import { Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";
import { definePlugin } from "../services/plugin.js";
import type { FileNameContext } from "../services/plugin.js";
import { TsType } from "../services/pg-types.js";
import type {
  Field,
  Shape,
  ExtensionInfo,
  TableEntity,
  EnumEntity,
} from "../ir/semantic-ir.js";
import { getTableEntities, getEnumEntities } from "../ir/semantic-ir.js";
import { conjure } from "../lib/conjure.js";
import type { SymbolStatement } from "../lib/conjure.js";
import { isUuidType, isDateType, resolveFieldType } from "../lib/field-utils.js";

const { ts, exp, obj } = conjure;

// ============================================================================
// Configuration
// ============================================================================

const ArkTypePluginConfig = S.Struct({
  /** Output directory relative to main outputDir */
  outputDir: S.String,
  /** Export inferred types alongside schemas */
  exportTypes: S.Boolean,
});

// ============================================================================
// ArkType Schema Builders (pure functions)
// ============================================================================

/**
 * Build ArkType string-based type expression.
 *
 * ArkType uses string syntax for most types:
 * - `"string"`, `"number"`, `"boolean"`, `"bigint"`
 * - `"Date"` for Date objects
 * - `"string?"` for optional
 * - `"string | null"` for nullable
 * - `"string[]"` for arrays
 */
const buildArkTypeString = (
  baseType: string,
  modifiers: { nullable?: boolean; optional?: boolean; isArray?: boolean }
): string => {
  let result = baseType;

  // Apply array first (before nullable/optional)
  if (modifiers.isArray) {
    result = `${result}[]`;
  }

  // For nullable, use union with null
  if (modifiers.nullable) {
    result = `${result} | null`;
  }

  // Optional uses ? suffix in object keys, not in the type string itself
  // We handle this at the property level

  return result;
};

/**
 * Build ArkType enum as union of string literals: `"'a' | 'b' | 'c'"`
 */
const buildArkTypeEnumString = (values: readonly string[]): string =>
  values.map((v) => `'${v}'`).join(" | ");

/**
 * Map TypeScript type to ArkType string type
 */
const tsTypeToArkTypeString = (tsType: string): string => {
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
      return "Date";
    case TsType.Buffer:
    case TsType.Unknown:
    default:
      return "unknown";
  }
};

// ============================================================================
// Field → ArkType Schema Resolution
// ============================================================================

interface FieldContext {
  readonly enums: Iterable<EnumEntity>;
  readonly extensions: readonly ExtensionInfo[];
}

/**
 * Resolve a field to its ArkType type string
 */
const resolveFieldArkTypeString = (field: Field, ctx: FieldContext): string => {
  const resolved = resolveFieldType(field, ctx.enums, ctx.extensions);

  // Enum → union of string literals
  if (resolved.enumDef) {
    const baseType = buildArkTypeEnumString(resolved.enumDef.values);
    // Wrap enum in parens if adding modifiers
    const needsParens = field.nullable || field.isArray;
    const wrapped = needsParens ? `(${baseType})` : baseType;
    return buildArkTypeString(wrapped, {
      nullable: field.nullable,
      isArray: field.isArray,
    });
  }

  // UUID → string.uuid
  if (isUuidType(field)) {
    return buildArkTypeString("string.uuid", {
      nullable: field.nullable,
      isArray: field.isArray,
    });
  }

  // Date/timestamp → Date
  if (isDateType(field)) {
    return buildArkTypeString("Date", {
      nullable: field.nullable,
      isArray: field.isArray,
    });
  }

  // Standard type mapping
  return buildArkTypeString(tsTypeToArkTypeString(resolved.tsType), {
    nullable: field.nullable,
    isArray: field.isArray,
  });
};

// ============================================================================
// Shape → Statement Generation
// ============================================================================

/**
 * Build type({ ... }) expression from shape fields
 *
 * ArkType uses string keys for optionality: `"key?": "type"`
 */
const buildShapeArkTypeObject = (shape: Shape, ctx: FieldContext): n.Expression => {
  const objBuilder = shape.fields.reduce((builder, field) => {
    const typeString = resolveFieldArkTypeString(field, ctx);
    // Use "key?" syntax for optional fields - must use stringProp for valid JS
    if (field.optional) {
      return builder.stringProp(`${field.name}?`, conjure.str(typeString));
    }
    return builder.prop(field.name, conjure.str(typeString));
  }, obj());

  // Build: type({ ... })
  return conjure.id("type").call([objBuilder.build()]).build();
};

/**
 * Generate schema const + optional inferred type for a shape
 */
const generateShapeStatements = (
  shape: Shape,
  entityName: string,
  shapeKind: "row" | "insert" | "update" | "patch",
  ctx: FieldContext,
  exportTypes: boolean
): readonly SymbolStatement[] => {
  const symbolCtx = { capability: "schemas:arktype", entity: entityName, shape: shapeKind };
  const schemaExpr = buildShapeArkTypeObject(shape, ctx);

  const schemaStatement = exp.const(shape.name, symbolCtx, schemaExpr);

  if (!exportTypes) {
    return [schemaStatement];
  }

  // Generate: export type ShapeName = typeof ShapeName.infer
  // ArkType uses Schema.infer for the inferred type
  const inferType = ts.typeof(`${shape.name}.infer`);
  const typeStatement = exp.type(shape.name, symbolCtx, inferType);

  return [schemaStatement, typeStatement];
};

// ============================================================================
// Entity → File Generation
// ============================================================================

type ShapeEntry = readonly ["row" | "insert" | "update", Shape];

/**
 * Collect all defined shapes from an entity as [kind, shape] pairs
 */
const collectShapes = (entity: TableEntity): readonly ShapeEntry[] =>
  [
    ["row", entity.shapes.row] as const,
    ["insert", entity.shapes.insert] as const,
    ["update", entity.shapes.update] as const,
  ].filter((entry): entry is ShapeEntry => entry[1] != null);

/**
 * Generate all statements for an entity's shapes
 */
const generateEntityStatements = (
  entity: TableEntity,
  ctx: FieldContext,
  exportTypes: boolean
): readonly SymbolStatement[] =>
  collectShapes(entity).flatMap(([kind, shape]) =>
    generateShapeStatements(shape, entity.name, kind, ctx, exportTypes)
  );

// ============================================================================
// Plugin Definition
// ============================================================================

/**
 * ArkType Plugin
 *
 * Generates ArkType schemas for each entity's shapes (base, Insert, Update)
 * with inferred TypeScript types.
 */
export const arktypePlugin = definePlugin({
  name: "arktype",
  provides: ["schemas:arktype", "schemas"],
  configSchema: ArkTypePluginConfig,
  inflection: {
    outputFile: (ctx) => `${ctx.entityName}.ts`,
    symbolName: (entityName, artifactKind) => `${entityName}${artifactKind}`,
  },

  run: (ctx, config) => {
    const enumEntities = getEnumEntities(ctx.ir);
    const fieldCtx: FieldContext = { enums: enumEntities, extensions: ctx.ir.extensions };

    getTableEntities(ctx.ir)
      .filter((entity) => entity.tags.omit !== true)
      .forEach((entity) => {
        const statements = generateEntityStatements(entity, fieldCtx, config.exportTypes);

        const entityName = ctx.inflection.entityName(entity.pgClass, entity.tags);
        const fileNameCtx: FileNameContext = {
          entityName,
          pgName: entity.pgName,
          schema: entity.schemaName,
          inflection: ctx.inflection,
          entity,
        };
        const fileName = ctx.pluginInflection.outputFile(fileNameCtx);
        const filePath = `${config.outputDir}/${fileName}`;

        ctx
          .file(filePath)
          .header("// This file is auto-generated. Do not edit.\n")
          .import({ kind: "package", names: ["type"], from: "arktype" })
          .ast(conjure.symbolProgram(...statements))
          .emit();
      });
  },
});

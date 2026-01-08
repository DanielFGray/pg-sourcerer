/**
 * Effect Model Plugin - Generate @effect/sql Model classes for entities
 *
 * Generates Model classes with proper variants based on:
 * - Field properties (isGenerated, isIdentity, hasDefault, nullable)
 * - Smart tags (sensitive, insert override)
 */
import { Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";
import type { ExpressionKind } from "ast-types/lib/gen/kinds.js";
import { definePlugin } from "../services/plugin.js";
import type { FileNameContext } from "../services/plugin.js";
import { inflect } from "../services/inflection.js";
import { TsType } from "../services/pg-types.js";
import type { EnumLookupResult } from "../services/pg-types.js";
import type { Field, TableEntity, EnumEntity, ExtensionInfo } from "../ir/semantic-ir.js";
import { getEnumEntities, getTableEntities } from "../ir/semantic-ir.js";
import { conjure } from "../lib/conjure.js";
import type { SymbolStatement } from "../lib/conjure.js";
import { isUuidType, isDateType, isBigIntType, resolveFieldType } from "../lib/field-utils.js";

const { exp, obj } = conjure;

// ============================================================================
// Configuration
// ============================================================================

const EffectModelPluginConfig = S.Struct({
  /** Output directory relative to main outputDir */
  outputDir: S.String,
  /** How to handle enums: "inline" or "separate" file */
  enumStyle: S.optional(S.Union(S.Literal("inline"), S.Literal("separate"))),
});

type EffectModelPluginConfig = S.Schema.Type<typeof EffectModelPluginConfig>;

// ============================================================================
// Smart Tags
// ============================================================================

const EffectModelTagsSchema = S.Struct({
  /** Override insert optionality: "optional" or "required" */
  insert: S.optional(S.Union(S.Literal("optional"), S.Literal("required"))),
  /** Mark field as sensitive - excluded from json variants */
  sensitive: S.optional(S.Boolean),
});

type EffectModelTags = S.Schema.Type<typeof EffectModelTagsSchema>;

const getEffectModelTags = (field: Field): EffectModelTags => {
  const pluginTags = field.tags["effect:model"];
  if (!pluginTags) return {};
  return S.decodeUnknownSync(EffectModelTagsSchema)(pluginTags);
};

const isSensitive = (field: Field): boolean => getEffectModelTags(field).sensitive === true;

const getInsertOverride = (field: Field): "optional" | "required" | undefined =>
  getEffectModelTags(field).insert;

// ============================================================================
// Schema Builders (pure functions)
// ============================================================================

/** Cast n.Expression to ExpressionKind for recast compatibility */
const toExprKind = (expr: n.Expression): ExpressionKind => expr as ExpressionKind;

/** Map TypeScript type to Effect Schema property access */
const tsTypeToEffectSchema = (tsType: string): n.Expression => {
  const prop =
    tsType === TsType.String
      ? "String"
      : tsType === TsType.Number
        ? "Number"
        : tsType === TsType.Boolean
          ? "Boolean"
          : tsType === TsType.BigInt
            ? "BigInt"
            : tsType === TsType.Date
              ? "Date"
              : "Unknown";
  return conjure.id("S").prop(prop).build();
};

/** Build S.Union(S.Literal(...), ...) for an enum */
const buildEnumSchema = (enumResult: EnumLookupResult): n.Expression =>
  conjure
    .id("S")
    .method(
      "Union",
      enumResult.values.map(v =>
        conjure
          .id("S")
          .method("Literal", [conjure.str(v)])
          .build(),
      ),
    )
    .build();

// ============================================================================
// Schema Wrappers
// ============================================================================

const wrapIf = (
  schema: n.Expression,
  condition: boolean,
  wrapper: (s: n.Expression) => n.Expression,
): n.Expression => (condition ? wrapper(schema) : schema);

const wrapNullable = (schema: n.Expression): n.Expression =>
  conjure.id("S").method("NullOr", [schema]).build();

const wrapArray = (schema: n.Expression): n.Expression =>
  conjure.id("S").method("Array", [schema]).build();

const wrapGenerated = (schema: n.Expression): n.Expression =>
  conjure.id("Model").method("Generated", [schema]).build();

const wrapSensitive = (schema: n.Expression): n.Expression =>
  conjure.id("Model").method("Sensitive", [schema]).build();

const wrapFieldOption = (schema: n.Expression): n.Expression =>
  conjure.id("Model").method("FieldOption", [schema]).build();

// ============================================================================
// Field Analysis
// ============================================================================

interface FieldContext {
  readonly entity: TableEntity;
  readonly enums: readonly EnumEntity[];
  readonly extensions: readonly ExtensionInfo[];
}

/**
 * Determine if a field should be treated as DB-generated.
 * Includes GENERATED ALWAYS, IDENTITY, and PK fields with defaults.
 */
const isDbGenerated = (field: Field, entity: TableEntity): boolean =>
  field.isGenerated ||
  field.isIdentity ||
  (field.hasDefault && entity.primaryKey?.columns.includes(field.columnName) === true);

/**
 * Check for auto-timestamp patterns (created_at, updated_at)
 */
const getAutoTimestamp = (field: Field): "insert" | "update" | undefined => {
  if (!field.hasDefault) return undefined;
  const name = field.columnName.toLowerCase();
  if (name === "created_at" || name === "createdat") return "insert";
  if (name === "updated_at" || name === "updatedat") return "update";
  return undefined;
};

// ============================================================================
// Field → Schema Expression
// ============================================================================

/**
 * Build the base Effect Schema type for a field
 */
const buildBaseSchemaType = (field: Field, ctx: FieldContext): n.Expression => {
  const resolved = resolveFieldType(field, ctx.enums, ctx.extensions);

  if (resolved.enumDef) return buildEnumSchema(resolved.enumDef);
  if (isUuidType(field)) return conjure.id("S").prop("UUID").build();
  if (isDateType(field)) return conjure.id("S").prop("Date").build();
  if (isBigIntType(field)) return conjure.id("S").prop("BigInt").build();

  return tsTypeToEffectSchema(resolved.tsType);
};

/**
 * Build the complete field schema expression with all wrappers applied
 */
const buildFieldSchema = (field: Field, ctx: FieldContext): n.Expression => {
  // Check for auto-timestamp patterns first (returns early with special type)
  const autoTs = getAutoTimestamp(field);
  if (autoTs === "insert") return conjure.id("Model").prop("DateTimeInsertFromDate").build();
  if (autoTs === "update") return conjure.id("Model").prop("DateTimeUpdateFromDate").build();

  // Build base type with array/nullable wrappers
  let schema = buildBaseSchemaType(field, ctx);
  schema = wrapIf(schema, field.isArray, wrapArray);
  schema = wrapIf(schema, field.nullable, wrapNullable);
  schema = wrapIf(schema, isSensitive(field), wrapSensitive);

  // Determine generated/optional status
  const insertOverride = getInsertOverride(field);
  const shouldBeGenerated =
    insertOverride === "required"
      ? field.isGenerated || field.isIdentity
      : isDbGenerated(field, ctx.entity);

  if (shouldBeGenerated) {
    schema = wrapGenerated(schema);
  } else if (insertOverride === "optional") {
    schema = wrapFieldOption(schema);
  }

  return schema;
};

// ============================================================================
// Entity → Model Class
// ============================================================================

/**
 * Build Model.Class<ClassName>("table_name")({ ...fields })
 */
const buildModelClass = (
  entity: TableEntity,
  className: string,
  ctx: FieldContext,
): n.Expression => {
  // Build fields object from row shape
  const fieldsObj = entity.shapes.row.fields.reduce(
    (builder, field) => builder.prop(field.name, buildFieldSchema(field, ctx)),
    obj(),
  );

  // Build: Model.Class<ClassName>("table_name")
  const modelClassRef = conjure.b.memberExpression(
    conjure.b.identifier("Model"),
    conjure.b.identifier("Class"),
  );

  const modelClassWithType = conjure.b.callExpression(modelClassRef, [
    conjure.str(entity.name),
  ]);

  // Add type parameters: Model.Class<ClassName>
  // Use typeParameters for TypeScript (not typeArguments which is for Flow)
  (modelClassWithType as { typeParameters?: unknown }).typeParameters =
    conjure.b.tsTypeParameterInstantiation([
      conjure.b.tsTypeReference(conjure.b.identifier(className)),
    ]);

  // Call with fields: Model.Class<ClassName>("table_name")({ ... })
  return conjure.b.callExpression(modelClassWithType, [fieldsObj.build()]);
};

/**
 * Generate: export class ClassName extends Model.Class<ClassName>("table")({ ... }) {}
 */
const generateModelStatement = (
  entity: TableEntity,
  className: string,
  ctx: FieldContext,
): SymbolStatement => {
  const modelExpr = buildModelClass(entity, className, ctx);

  const classDecl = conjure.b.classDeclaration(
    conjure.b.identifier(className),
    conjure.b.classBody([]),
    toExprKind(modelExpr),
  );

  return {
    _tag: "SymbolStatement",
    node: conjure.b.exportNamedDeclaration(classDecl, []),
    symbol: {
      name: className,
      capability: "models:effect",
      entity: entity.name,
      isType: false,
    },
  };
};

/**
 * Generate enum schema: export const EnumName = S.Union(S.Literal(...), ...)
 */
const generateEnumStatement = (enumEntity: EnumEntity): SymbolStatement =>
  exp.const(
    enumEntity.name,
    { capability: "models:effect", entity: enumEntity.name },
    buildEnumSchema({
      name: enumEntity.name,
      pgName: enumEntity.pgName,
      values: enumEntity.values,
    }),
  );

// ============================================================================
// File Emission Helpers
// ============================================================================

const buildFileNameContext = (
  entityName: string,
  pgName: string,
  schemaName: string,
  inflection: Parameters<typeof definePlugin>[0]["run"] extends (
    ctx: infer C,
    ...args: unknown[]
  ) => unknown
    ? C extends { inflection: infer I }
      ? I
      : never
    : never,
  entity: TableEntity | EnumEntity,
): FileNameContext => ({
  entityName,
  pgName,
  schema: schemaName,
  inflection,
  entity,
});

// ============================================================================
// Plugin Definition
// ============================================================================

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
    outputFile: ctx => `${ctx.entityName}.ts`,
    symbolName: (entityName, _artifactKind) => entityName,
  },
  inflectionDefaults: {
    entityName: inflect.pascalCase,
    enumName: inflect.pascalCase,
  },

  run: (ctx, config) => {
    const enumEntities = getEnumEntities(ctx.ir);
    const enumStyle = config.enumStyle ?? "inline";

    // Generate separate enum files if configured
    if (enumStyle === "separate") {
      enumEntities
        .filter(e => e.tags.omit !== true)
        .forEach(enumEntity => {
          const fileNameCtx = buildFileNameContext(
            enumEntity.name,
            enumEntity.pgName,
            enumEntity.schemaName,
            ctx.inflection,
            enumEntity,
          );
          const filePath = `${config.outputDir}/${ctx.pluginInflection.outputFile(fileNameCtx)}`;

          ctx
            .file(filePath)
            .header("// This file is auto-generated. Do not edit.\n")
            .import({ kind: "package", names: ["Schema as S"], from: "effect" })
            .ast(conjure.symbolProgram(generateEnumStatement(enumEntity)))
            .emit();
        });
    }

    // Generate table/view entity model files
    getTableEntities(ctx.ir)
      .filter(entity => entity.tags.omit !== true)
      .forEach(entity => {
        const className = ctx.inflection.entityName(entity.pgClass, entity.tags);
        const fieldCtx: FieldContext = {
          entity,
          enums: enumEntities,
          extensions: ctx.ir.extensions,
        };

        const fileNameCtx = buildFileNameContext(
          className,
          entity.pgName,
          entity.schemaName,
          ctx.inflection,
          entity,
        );
        const filePath = `${config.outputDir}/${ctx.pluginInflection.outputFile(fileNameCtx)}`;

        ctx
          .file(filePath)
          .header("// This file is auto-generated. Do not edit.\n")
          .import({ kind: "package", names: ["Model"], from: "@effect/sql" })
          .import({ kind: "package", names: ["Schema as S"], from: "effect" })
          .ast(conjure.symbolProgram(generateModelStatement(entity, className, fieldCtx)))
          .emit();
      });
  },
});

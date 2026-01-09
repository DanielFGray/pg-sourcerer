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
import { Array as Arr, Option, pipe, Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";
import { definePlugin } from "../services/plugin.js";
import type { FileNameContext } from "../services/plugin.js";
import { findEnumByPgName, TsType } from "../services/pg-types.js";
import type {
  Field,
  Shape,
  ExtensionInfo,
  TableEntity,
  EnumEntity,
  CompositeEntity,
} from "../ir/semantic-ir.js";
import { getTableEntities, getEnumEntities, getCompositeEntities } from "../ir/semantic-ir.js";
import { conjure } from "../lib/conjure.js";
import type { SymbolStatement } from "../lib/conjure.js";
import type { ImportRef } from "../services/file-builder.js";
import {
  isUuidType,
  isDateType,
  isEnumType,
  getPgTypeName,
  resolveFieldType,
} from "../lib/field-utils.js";

const { ts, exp, obj } = conjure;

// ============================================================================
// Configuration
// ============================================================================

const ArkTypePluginConfig = S.Struct({
  /** Output directory relative to main outputDir */
  outputDir: S.optionalWith(S.String, { default: () => "arktype" }),
  /** Export inferred types alongside schemas */
  exportTypes: S.optionalWith(S.Boolean, { default: () => true }),
  /** How to represent enum values: 'strings' uses union literals, 'enum' uses TS enum */
  enumStyle: S.optionalWith(S.Union(S.Literal("strings"), S.Literal("enum")), { default: () => "strings" as const }),
  /** Where to define enum types: 'inline' embeds at usage, 'separate' generates enum files */
  typeReferences: S.optionalWith(S.Union(S.Literal("inline"), S.Literal("separate")), { default: () => "separate" as const }),
});

type ArkTypePluginConfig = S.Schema.Type<typeof ArkTypePluginConfig>;

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
  modifiers: { nullable?: boolean; optional?: boolean; isArray?: boolean },
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
  values.map(v => `'${v}'`).join(" | ");

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
  readonly enumStyle: "strings" | "enum";
  readonly typeReferences: "inline" | "separate";
}

/**
 * Resolve a field to its ArkType type string or expression info.
 * Returns either a string (for inline string syntax) or an object with ref info.
 */
interface ArkTypeFieldResult {
  /** The type string to use in the object definition */
  readonly typeString: string;
  /** If true, this is a reference to an imported type, not a string literal */
  readonly isReference: boolean;
}

const resolveFieldArkType = (field: Field, ctx: FieldContext): ArkTypeFieldResult => {
  const resolved = resolveFieldType(field, ctx.enums, ctx.extensions);

  // Enum handling
  if (resolved.enumDef) {
    if (ctx.typeReferences === "separate") {
      // Reference by name - will be imported
      // ArkType can reference other types by name in a scope, but for simple
      // cases we'll use the type directly
      const baseRef = resolved.enumDef.name;
      const withMods = buildArkTypeString(baseRef, {
        nullable: field.nullable,
        isArray: field.isArray,
      });
      return { typeString: withMods, isReference: true };
    }

    // Inline: union of string literals
    const baseType = buildArkTypeEnumString(resolved.enumDef.values);
    const needsParens = field.nullable || field.isArray;
    const wrapped = needsParens ? `(${baseType})` : baseType;
    return {
      typeString: buildArkTypeString(wrapped, {
        nullable: field.nullable,
        isArray: field.isArray,
      }),
      isReference: false,
    };
  }

  // UUID → string.uuid
  if (isUuidType(field)) {
    return {
      typeString: buildArkTypeString("string.uuid", {
        nullable: field.nullable,
        isArray: field.isArray,
      }),
      isReference: false,
    };
  }

  // Date/timestamp → Date
  if (isDateType(field)) {
    return {
      typeString: buildArkTypeString("Date", {
        nullable: field.nullable,
        isArray: field.isArray,
      }),
      isReference: false,
    };
  }

  // Standard type mapping
  return {
    typeString: buildArkTypeString(tsTypeToArkTypeString(resolved.tsType), {
      nullable: field.nullable,
      isArray: field.isArray,
    }),
    isReference: false,
  };
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
    const result = resolveFieldArkType(field, ctx);
    const value = result.isReference
      ? conjure.id(result.typeString).build()
      : conjure.str(result.typeString);

    // Use "key?" syntax for optional fields - must use stringProp for valid JS
    if (field.optional) {
      return builder.stringProp(`${field.name}?`, value);
    }
    return builder.prop(field.name, value);
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
  exportTypes: boolean,
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
  exportTypes: boolean,
): readonly SymbolStatement[] =>
  collectShapes(entity).flatMap(([kind, shape]) =>
    generateShapeStatements(shape, entity.name, kind, ctx, exportTypes),
  );

// ============================================================================
// Composite Type Generation
// ============================================================================

/**
 * Build type({ ... }) expression from composite fields
 */
const buildCompositeArkTypeObject = (
  composite: CompositeEntity,
  ctx: FieldContext,
): n.Expression => {
  const objBuilder = composite.fields.reduce((builder, field) => {
    const result = resolveFieldArkType(field, ctx);
    const value = result.isReference
      ? conjure.id(result.typeString).build()
      : conjure.str(result.typeString);

    // Use "key?" syntax for optional fields
    if (field.optional) {
      return builder.stringProp(`${field.name}?`, value);
    }
    return builder.prop(field.name, value);
  }, obj());

  return conjure.id("type").call([objBuilder.build()]).build();
};

/**
 * Generate schema const + optional inferred type for a composite type
 */
const generateCompositeStatements = (
  composite: CompositeEntity,
  ctx: FieldContext,
  exportTypes: boolean,
): readonly SymbolStatement[] => {
  const symbolCtx = { capability: "schemas:arktype", entity: composite.name };
  const schemaExpr = buildCompositeArkTypeObject(composite, ctx);

  const schemaStatement = exp.const(composite.name, symbolCtx, schemaExpr);

  if (!exportTypes) {
    return [schemaStatement];
  }

  // Generate: export type CompositeName = typeof CompositeName.infer
  const inferType = ts.typeof(`${composite.name}.infer`);
  const typeStatement = exp.type(composite.name, symbolCtx, inferType);

  return [schemaStatement, typeStatement];
};

// ============================================================================
// Enum Generation
// ============================================================================

/**
 * Generate enum type for ArkType.
 * - For 'strings': export const EnumName = type("'a' | 'b' | 'c'")
 * - For 'enum': export enum EnumName { ... } + const EnumNameType = type("keyof", typeof EnumName)
 */
const generateEnumStatement = (
  enumEntity: EnumEntity,
  enumStyle: "strings" | "enum",
): readonly SymbolStatement[] => {
  const symbolCtx = { capability: "schemas:arktype", entity: enumEntity.name };

  if (enumStyle === "enum") {
    // Generate: export enum EnumName { A = 'a', B = 'b', ... }
    const enumDecl = conjure.b.tsEnumDeclaration(
      conjure.b.identifier(enumEntity.name),
      enumEntity.values.map(v =>
        conjure.b.tsEnumMember(
          conjure.b.identifier(v.toUpperCase().replace(/[^A-Z0-9_]/g, "_")),
          conjure.str(v),
        ),
      ),
    );
    const enumStatement: SymbolStatement = {
      _tag: "SymbolStatement",
      node: conjure.b.exportNamedDeclaration(enumDecl, []),
      symbol: {
        name: enumEntity.name,
        capability: "schemas:arktype",
        entity: enumEntity.name,
        isType: true,
      },
    };

    // For arktype with native enums: type("keyof", typeof EnumName)
    const schemaName = `${enumEntity.name}Type`;
    const typeofExpr = conjure.b.unaryExpression(
      "typeof",
      conjure.id(enumEntity.name).build() as Parameters<typeof conjure.b.unaryExpression>[1],
      true,
    );
    const schemaExpr = conjure
      .id("type")
      .call([conjure.str("keyof"), typeofExpr as n.Expression])
      .build();
    const schemaStatement = exp.const(schemaName, symbolCtx, schemaExpr);

    return [enumStatement, schemaStatement];
  }

  // strings style: export const EnumName = type("'a' | 'b' | 'c'")
  const enumString = buildArkTypeEnumString(enumEntity.values);
  const schemaExpr = conjure
    .id("type")
    .call([conjure.str(enumString)])
    .build();
  return [exp.const(enumEntity.name, symbolCtx, schemaExpr)];
};

/** Collect enum names used by fields */
const collectUsedEnums = (fields: readonly Field[], enums: readonly EnumEntity[]): Set<string> => {
  const enumNames = fields.filter(isEnumType).flatMap(field => {
    const pgTypeName = getPgTypeName(field);
    if (!pgTypeName) return [];
    return pipe(
      findEnumByPgName(enums, pgTypeName),
      Option.map(e => e.name),
      Option.toArray,
    );
  });
  return new Set(enumNames);
};

/** Build import refs for used enums */
const buildEnumImports = (usedEnums: Set<string>): readonly ImportRef[] =>
  Arr.fromIterable(usedEnums).map(enumName => ({
    kind: "symbol" as const,
    ref: { capability: "schemas:arktype", entity: enumName },
  }));

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
    outputFile: ctx => `${ctx.entityName}.ts`,
    symbolName: (entityName, artifactKind) => `${entityName}${artifactKind}`,
  },

  run: (ctx, config) => {
    const enumEntities = getEnumEntities(ctx.ir);
    const { enumStyle, typeReferences } = config;

    const fieldCtx: FieldContext = {
      enums: enumEntities,
      extensions: ctx.ir.extensions,
      enumStyle,
      typeReferences,
    };

    // Generate separate enum files if configured
    if (typeReferences === "separate") {
      enumEntities
        .filter(e => e.tags.omit !== true)
        .forEach(enumEntity => {
          const fileNameCtx: FileNameContext = {
            entityName: enumEntity.name,
            pgName: enumEntity.pgName,
            schema: enumEntity.schemaName,
            inflection: ctx.inflection,
            entity: enumEntity,
          };
          const filePath = `${config.outputDir}/${ctx.pluginInflection.outputFile(fileNameCtx)}`;
          const statements = generateEnumStatement(enumEntity, enumStyle);

          ctx
            .file(filePath)
            .import({ kind: "package", names: ["type"], from: "arktype" })
            .ast(conjure.symbolProgram(...statements))
            .emit();
        });
    }

    getTableEntities(ctx.ir)
      .filter(entity => entity.tags.omit !== true)
      .forEach(entity => {
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

        // Collect all fields for enum detection
        const allFields = [
          ...entity.shapes.row.fields,
          ...(entity.shapes.insert?.fields ?? []),
          ...(entity.shapes.update?.fields ?? []),
        ];
        const usedEnums =
          typeReferences === "separate"
            ? collectUsedEnums(allFields, Arr.fromIterable(fieldCtx.enums))
            : new Set<string>();

        const fileBuilder = ctx
          .file(filePath)
          .import({ kind: "package", names: ["type"], from: "arktype" });

        // Add enum imports when using separate files
        buildEnumImports(usedEnums).forEach(ref => fileBuilder.import(ref));

        fileBuilder.ast(conjure.symbolProgram(...statements)).emit();
      });

    // Generate composite type schemas
    getCompositeEntities(ctx.ir)
      .filter(composite => composite.tags.omit !== true)
      .forEach(composite => {
        const statements = generateCompositeStatements(composite, fieldCtx, config.exportTypes);

        const fileNameCtx: FileNameContext = {
          entityName: composite.name,
          pgName: composite.pgName,
          schema: composite.schemaName,
          inflection: ctx.inflection,
          entity: composite,
        };
        const fileName = ctx.pluginInflection.outputFile(fileNameCtx);
        const filePath = `${config.outputDir}/${fileName}`;

        // Collect enum usage for imports
        const usedEnums =
          typeReferences === "separate"
            ? collectUsedEnums(composite.fields, Arr.fromIterable(fieldCtx.enums))
            : new Set<string>();

        const fileBuilder = ctx
          .file(filePath)
          .import({ kind: "package", names: ["type"], from: "arktype" });

        buildEnumImports(usedEnums).forEach(ref => fileBuilder.import(ref));

        fileBuilder.ast(conjure.symbolProgram(...statements)).emit();
      });
  },
});

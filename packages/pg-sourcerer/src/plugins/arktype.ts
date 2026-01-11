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
import { definePlugin, type PluginContext } from "../services/plugin.js";
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
import {
  SCHEMA_BUILDER_KIND,
  type SchemaBuilder,
  type SchemaBuilderRequest,
  type SchemaBuilderResult,
} from "../ir/extensions/schema-builder.js";
import type { QueryMethodParam } from "../ir/extensions/queries.js";

const { ts, exp, obj } = conjure;

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for the arktype provider
 */
export interface ArkTypeConfig {
  /** Output directory relative to main outputDir */
  readonly outputDir?: string;
  /** Export inferred types alongside schemas */
  readonly exportTypes?: boolean;
  /** How to represent enum values: 'strings' uses union literals, 'enum' uses TS enum */
  readonly enumStyle?: "strings" | "enum";
  /** Where to define enum types: 'inline' embeds at usage, 'separate' generates enum files */
  readonly typeReferences?: "inline" | "separate";
}

const ArkTypeConfigSchema = S.Struct({
  outputDir: S.optionalWith(S.String, { default: () => "arktype" }),
  exportTypes: S.optionalWith(S.Boolean, { default: () => true }),
  enumStyle: S.optionalWith(S.Union(S.Literal("strings"), S.Literal("enum")), {
    default: () => "strings" as const,
  }),
  typeReferences: S.optionalWith(S.Union(S.Literal("inline"), S.Literal("separate")), {
    default: () => "separate" as const,
  }),
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
  const schemaSymbolCtx = { capability: "schemas", entity: entityName, shape: shapeKind };
  const schemaExpr = buildShapeArkTypeObject(shape, ctx);

  const schemaStatement = exp.const(shape.name, schemaSymbolCtx, schemaExpr);

  if (!exportTypes) {
    return [schemaStatement];
  }

  // Generate: export type ShapeName = typeof ShapeName.infer
  // ArkType uses Schema.infer for the inferred type
  const typeSymbolCtx = { capability: "types", entity: entityName, shape: shapeKind };
  const inferType = ts.typeof(`${shape.name}.infer`);
  const typeStatement = exp.type(shape.name, typeSymbolCtx, inferType);

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
  const schemaSymbolCtx = { capability: "schemas", entity: composite.name };
  const schemaExpr = buildCompositeArkTypeObject(composite, ctx);

  const schemaStatement = exp.const(composite.name, schemaSymbolCtx, schemaExpr);

  if (!exportTypes) {
    return [schemaStatement];
  }

  // Generate: export type CompositeName = typeof CompositeName.infer
  const typeSymbolCtx = { capability: "types", entity: composite.name };
  const inferType = ts.typeof(`${composite.name}.infer`);
  const typeStatement = exp.type(composite.name, typeSymbolCtx, inferType);

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
  exportTypes: boolean,
): readonly SymbolStatement[] => {
  const schemaSymbolCtx = { capability: "schemas", entity: enumEntity.name };

  if (enumStyle === "enum") {
    // Generate: export enum EnumName { A = 'a', B = 'b', ... }
    const enumStatement = exp.tsEnum(
      enumEntity.name,
      { capability: "types", entity: enumEntity.name },
      enumEntity.values,
    );

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
    const schemaStatement = exp.const(schemaName, schemaSymbolCtx, schemaExpr);

    return [enumStatement, schemaStatement];
  }

  // strings style: export const EnumName = type("'a' | 'b' | 'c'")
  const enumString = buildArkTypeEnumString(enumEntity.values);
  const schemaExpr = conjure
    .id("type")
    .call([conjure.str(enumString)])
    .build();
  const schemaStatement = exp.const(enumEntity.name, schemaSymbolCtx, schemaExpr);

  if (!exportTypes) {
    return [schemaStatement];
  }

  // Generate: export type EnumName = typeof EnumName.infer
  const typeSymbolCtx = { capability: "types", entity: enumEntity.name };
  const inferType = ts.typeof(`${enumEntity.name}.infer`);
  const typeStatement = exp.type(enumEntity.name, typeSymbolCtx, inferType);

  return [schemaStatement, typeStatement];
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
    ref: { capability: "schemas", entity: enumName },
  }));

// ============================================================================
// Schema Builder Service
// ============================================================================

/**
 * Map TypeScript type string to ArkType string for params.
 * URL params are strings, so we use string.integer for numbers (coerces).
 */
const paramTypeToArkTypeString = (tsType: string): string => {
  switch (tsType.toLowerCase()) {
    case "number":
      // string.integer parses string to integer
      return "string.integer.parse";
    case "boolean":
      return "string";  // ArkType doesn't have built-in boolean coercion from string
    case "bigint":
      return "string";  // Handle as string, parse manually
    case "string":
    default:
      return "string";
  }
};

/**
 * Build type({ ... }) expression from QueryMethodParam[].
 * For path/query parameter validation in HTTP handlers.
 */
const buildParamArkTypeObject = (params: readonly QueryMethodParam[]): n.Expression => {
  const objBuilder = params.reduce((builder, param) => {
    const arkType = paramTypeToArkTypeString(param.type);

    // Use "key?" syntax for optional params
    const key = param.required ? param.name : `${param.name}?`;
    return builder.stringProp(key, conjure.str(arkType));
  }, obj());

  return conjure.id("type").call([objBuilder.build()]).build();
};

/**
 * Create a SchemaBuilder implementation for ArkType.
 */
const createArkTypeSchemaBuilder = (): SchemaBuilder => ({
  build: (request: SchemaBuilderRequest): SchemaBuilderResult | undefined => {
    if (request.params.length === 0) {
      return undefined;
    }

    const ast = buildParamArkTypeObject(request.params);
    return {
      ast,
      importSpec: {
        names: ["type"],
        from: "arktype",
      },
    };
  },
});

// ============================================================================
// Provider Definition
// ============================================================================

/**
 * Create an arktype provider that generates ArkType schemas.
 *
 * @example
 * ```typescript
 * import { arktype } from "pg-sourcerer"
 *
 * export default defineConfig({
 *   plugins: [
 *     arktype(),
 *     arktype({ outputDir: "schemas", exportTypes: false }),
 *   ],
 * })
 * ```
 */
export function arktype(config: ArkTypeConfig = {}): ReturnType<typeof definePlugin> {
  const parsed = S.decodeUnknownSync(ArkTypeConfigSchema)(config);

  return definePlugin({
    name: "arktype",
    kind: "schemas",
    singleton: true,

    canProvide: () => true,

    provide: (_params: unknown, _deps: readonly unknown[], ctx: PluginContext) => {
      const { ir, inflection } = ctx;
      const enumEntities = getEnumEntities(ir);

      // Register schema-builder service for on-demand param/query schema generation
      ctx.registerHandler(SCHEMA_BUILDER_KIND, createArkTypeSchemaBuilder().build);

      const fieldCtx: FieldContext = {
        enums: enumEntities,
        extensions: ir.extensions,
        enumStyle: parsed.enumStyle,
        typeReferences: parsed.typeReferences,
      };

      // Helper to build file path
      const buildFilePath = (entityName: string): string =>
        `${parsed.outputDir}/${entityName}.ts`;

      // Generate separate enum files if configured
      if (parsed.typeReferences === "separate") {
        enumEntities
          .filter(e => e.tags.omit !== true)
          .forEach(enumEntity => {
            const statements = generateEnumStatement(enumEntity, parsed.enumStyle, parsed.exportTypes);

            ctx
              .file(buildFilePath(enumEntity.name))
              .import({ kind: "package", names: ["type"], from: "arktype" })
              .ast(conjure.symbolProgram(...statements))
              .emit();
          });
      }

      getTableEntities(ir)
        .filter(entity => entity.tags.omit !== true)
        .forEach(entity => {
          const statements = generateEntityStatements(entity, fieldCtx, parsed.exportTypes);

          const entityName = inflection.entityName(entity.pgClass, entity.tags);

          // Collect all fields for enum detection
          const allFields = [
            ...entity.shapes.row.fields,
            ...(entity.shapes.insert?.fields ?? []),
            ...(entity.shapes.update?.fields ?? []),
          ];
          const usedEnums =
            parsed.typeReferences === "separate"
              ? collectUsedEnums(allFields, Arr.fromIterable(fieldCtx.enums))
              : new Set<string>();

          const fileBuilder = ctx
            .file(buildFilePath(entityName))
            .import({ kind: "package", names: ["type"], from: "arktype" });

          // Add enum imports when using separate files
          buildEnumImports(usedEnums).forEach(ref => fileBuilder.import(ref));

          fileBuilder.ast(conjure.symbolProgram(...statements)).emit();
        });

      // Generate composite type schemas
      getCompositeEntities(ir)
        .filter(composite => composite.tags.omit !== true)
        .forEach(composite => {
          const statements = generateCompositeStatements(composite, fieldCtx, parsed.exportTypes);

          // Collect enum usage for imports
          const usedEnums =
            parsed.typeReferences === "separate"
              ? collectUsedEnums(composite.fields, Arr.fromIterable(fieldCtx.enums))
              : new Set<string>();

          const fileBuilder = ctx
            .file(buildFilePath(composite.name))
            .import({ kind: "package", names: ["type"], from: "arktype" });

          buildEnumImports(usedEnums).forEach(ref => fileBuilder.import(ref));

          fileBuilder.ast(conjure.symbolProgram(...statements)).emit();
        });

      return undefined;
    },
  });
}

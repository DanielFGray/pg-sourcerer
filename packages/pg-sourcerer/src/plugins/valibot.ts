/**
 * Valibot Plugin - Generate Valibot schemas for entities
 *
 * Generates Valibot schemas for Row, Insert, Update, and Patch shapes,
 * with inferred TypeScript types.
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

const { ts, exp, obj, b } = conjure;

// ============================================================================
// Configuration
// ============================================================================

const ValibotConfigSchema = S.Struct({
  /** Output directory relative to main outputDir */
  outputDir: S.optionalWith(S.String, { default: () => "valibot" }),
  /** Export inferred types alongside schemas */
  exportTypes: S.optionalWith(S.Boolean, { default: () => true }),
  /** How to represent enum values: 'strings' uses v.picklist([...]), 'enum' uses v.enum(TsEnum) */
  enumStyle: S.optionalWith(S.Union(S.Literal("strings"), S.Literal("enum")), {
    default: () => "strings" as const,
  }),
  /** Where to define enum types: 'inline' embeds at usage, 'separate' generates enum files */
  typeReferences: S.optionalWith(S.Union(S.Literal("inline"), S.Literal("separate")), {
    default: () => "separate" as const,
  }),
});

/** Input config type (with optional fields) */
export type ValibotConfig = S.Schema.Encoded<typeof ValibotConfigSchema>;

// ============================================================================
// Valibot Schema Builders (pure functions)
// ============================================================================

// ============================================================================
// Valibot Schema Builders (pure functions)
// ============================================================================

/**
 * Build v.<method>() call
 */
const buildValibotCall = (method: string, args: readonly n.Expression[] = []): n.Expression =>
  conjure
    .id("v")
    .method(method, [...args])
    .build();

/**
 * Build v.picklist([...values])
 */
const buildValibotPicklist = (values: readonly string[]): n.Expression =>
  buildValibotCall("picklist", [conjure.arr(...values.map(v => conjure.str(v))).build()]);

/**
 * Build v.array(<inner>)
 */
const buildValibotArray = (inner: n.Expression): n.Expression => buildValibotCall("array", [inner]);

/**
 * Wrap expression with v.nullable(...)
 */
const wrapNullable = (expr: n.Expression): n.Expression => buildValibotCall("nullable", [expr]);

/**
 * Wrap expression with v.optional(...)
 */
const wrapOptional = (expr: n.Expression): n.Expression => buildValibotCall("optional", [expr]);

/**
 * Map TypeScript type to Valibot method name
 */
const tsTypeToValibotMethod = (tsType: string): string => {
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
      return "date";
    case TsType.Buffer:
    case TsType.Unknown:
    default:
      return "unknown";
  }
};

// ============================================================================
// Field → Valibot Schema Resolution
// ============================================================================

interface FieldContext {
  readonly enums: Iterable<EnumEntity>;
  readonly extensions: readonly ExtensionInfo[];
  readonly enumStyle: "strings" | "enum";
  readonly typeReferences: "inline" | "separate";
}

/**
 * Apply nullable/optional/array modifiers to a base schema
 * Order matters: array wraps first, then nullable, then optional
 */
const applyFieldModifiers = (
  schema: n.Expression,
  field: Pick<Field, "isArray" | "nullable" | "optional">,
): n.Expression => {
  let result = schema;

  // Array wrapping first
  if (field.isArray) {
    result = buildValibotArray(result);
  }

  // Nullable wrapping
  if (field.nullable) {
    result = wrapNullable(result);
  }

  // Optional wrapping
  if (field.optional) {
    result = wrapOptional(result);
  }

  return result;
};

/**
 * Resolve a field to its Valibot schema expression
 */
const resolveFieldValibotSchema = (field: Field, ctx: FieldContext): n.Expression => {
  const resolved = resolveFieldType(field, ctx.enums, ctx.extensions);

  // Enum handling
  if (resolved.enumDef) {
    let enumSchema: n.Expression;

    if (ctx.typeReferences === "separate") {
      // Reference by name - the enum schema is imported
      enumSchema = conjure.id(resolved.enumDef.name).build();
    } else if (ctx.enumStyle === "enum") {
      // Inline native enum: v.enum(EnumName)
      // Note: This requires the TS enum to be generated separately
      enumSchema = buildValibotCall("enum", [conjure.id(resolved.enumDef.name).build()]);
    } else {
      // Inline strings: v.picklist(['a', 'b', 'c'])
      enumSchema = buildValibotPicklist(resolved.enumDef.values);
    }

    return applyFieldModifiers(enumSchema, field);
  }

  // UUID → v.pipe(v.string(), v.uuid())
  if (isUuidType(field)) {
    const uuidSchema = buildValibotCall("pipe", [
      buildValibotCall("string"),
      buildValibotCall("uuid"),
    ]);
    return applyFieldModifiers(uuidSchema, field);
  }

  // Date/timestamp → v.date()
  if (isDateType(field)) {
    return applyFieldModifiers(buildValibotCall("date"), field);
  }

  // Standard type mapping
  return applyFieldModifiers(buildValibotCall(tsTypeToValibotMethod(resolved.tsType)), field);
};

// ============================================================================
// Shape → Statement Generation
// ============================================================================

/**
 * Build v.object({...}) expression from shape fields
 */
const buildShapeValibotObject = (shape: Shape, ctx: FieldContext): n.Expression => {
  const objBuilder = shape.fields.reduce(
    (builder, field) => builder.prop(field.name, resolveFieldValibotSchema(field, ctx)),
    obj(),
  );
  return buildValibotCall("object", [objBuilder.build()]);
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
  const schemaExpr = buildShapeValibotObject(shape, ctx);

  const schemaStatement = exp.const(shape.name, schemaSymbolCtx, schemaExpr);

  if (!exportTypes) {
    return [schemaStatement];
  }

  // Generate: export type ShapeName = v.InferOutput<typeof ShapeName>
  // Register under "types" capability so other plugins can import
  const typeSymbolCtx = { capability: "types", entity: entityName, shape: shapeKind };
  const inferType = ts.qualifiedRef("v", "InferOutput", [ts.typeof(shape.name)]);
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
 * Build v.object({...}) expression from composite fields
 */
const buildCompositeValibotObject = (
  composite: CompositeEntity,
  ctx: FieldContext,
): n.Expression => {
  const objBuilder = composite.fields.reduce(
    (builder, field) => builder.prop(field.name, resolveFieldValibotSchema(field, ctx)),
    obj(),
  );
  return buildValibotCall("object", [objBuilder.build()]);
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
  const schemaExpr = buildCompositeValibotObject(composite, ctx);

  const schemaStatement = exp.const(composite.name, schemaSymbolCtx, schemaExpr);

  if (!exportTypes) {
    return [schemaStatement];
  }

  // Generate: export type CompositeName = v.InferOutput<typeof CompositeName>
  // Register under "types" capability so other plugins can import
  const typeSymbolCtx = { capability: "types", entity: composite.name };
  const inferType = ts.qualifiedRef("v", "InferOutput", [ts.typeof(composite.name)]);
  const typeStatement = exp.type(composite.name, typeSymbolCtx, inferType);

  return [schemaStatement, typeStatement];
};

// ============================================================================
// Enum Generation
// ============================================================================

/**
 * Generate enum schema statement: export const EnumName = v.picklist(['a', 'b', ...])
 * or for native enums: export enum EnumName { A = 'a', ... } + schema
 */
const generateEnumStatement = (
  enumEntity: EnumEntity,
  enumStyle: "strings" | "enum",
  exportTypes: boolean,
): readonly SymbolStatement[] => {
  const schemaSymbolCtx = { capability: "schemas", entity: enumEntity.name };

  if (enumStyle === "enum") {
    // Generate: export enum EnumName { A = 'a', B = 'b', ... }
    // Then: export const EnumNameSchema = v.enum(EnumName)
    const enumStatement = exp.tsEnum(
      enumEntity.name,
      { capability: "types", entity: enumEntity.name },
      enumEntity.values,
    );

    const schemaName = `${enumEntity.name}Schema`;
    const schemaExpr = buildValibotCall("enum", [conjure.id(enumEntity.name).build()]);
    const schemaStatement = exp.const(schemaName, schemaSymbolCtx, schemaExpr);

    return [enumStatement, schemaStatement];
  }

  // strings style: export const EnumName = v.picklist(['a', 'b', ...])
  const schemaExpr = buildValibotPicklist(enumEntity.values);
  const schemaStatement = exp.const(enumEntity.name, schemaSymbolCtx, schemaExpr);

  if (!exportTypes) {
    return [schemaStatement];
  }

  // Generate: export type EnumName = v.InferOutput<typeof EnumName>
  // Register under "types" capability so other plugins can import
  const typeSymbolCtx = { capability: "types", entity: enumEntity.name };
  const inferType = ts.qualifiedRef("v", "InferOutput", [ts.typeof(enumEntity.name)]);
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
// Param Schema Builder (for HTTP plugins)
// ============================================================================

/**
 * Build Valibot schema expression for a single param.
 * Uses v.pipe(v.string(), v.transform(...)) for type coercion since URL params are strings.
 */
const buildParamFieldSchema = (param: QueryMethodParam): n.Expression => {
  const tsType = param.type.toLowerCase();
  let fieldSchema: n.Expression;

  switch (tsType) {
    case "number":
      // v.pipe(v.string(), v.transform(Number))
      fieldSchema = buildValibotCall("pipe", [
        buildValibotCall("string"),
        buildValibotCall("transform", [conjure.id("Number").build()]),
      ]);
      break;
    case "boolean":
      // v.pipe(v.string(), v.transform(v => v === 'true'))
      fieldSchema = buildValibotCall("pipe", [
        buildValibotCall("string"),
        buildValibotCall("transform", [
          b.arrowFunctionExpression(
            [b.identifier("v")],
            b.binaryExpression("===", b.identifier("v"), b.stringLiteral("true")),
          ),
        ]),
      ]);
      break;
    case "bigint":
      // v.pipe(v.string(), v.transform(BigInt))
      fieldSchema = buildValibotCall("pipe", [
        buildValibotCall("string"),
        buildValibotCall("transform", [conjure.id("BigInt").build()]),
      ]);
      break;
    case "date":
      // v.pipe(v.string(), v.transform(s => new Date(s)))
      fieldSchema = buildValibotCall("pipe", [
        buildValibotCall("string"),
        buildValibotCall("transform", [
          b.arrowFunctionExpression(
            [b.identifier("s")],
            b.newExpression(b.identifier("Date"), [b.identifier("s")]),
          ),
        ]),
      ]);
      break;
    case "string":
    default:
      // v.string()
      fieldSchema = buildValibotCall("string");
      break;
  }

  // Add v.optional(...) for non-required params
  if (!param.required) {
    fieldSchema = wrapOptional(fieldSchema);
  }

  return fieldSchema;
};

/**
 * Build v.object({ ... }) expression from QueryMethodParam[].
 */
const buildParamValibotObject = (params: readonly QueryMethodParam[]): n.Expression => {
  const objBuilder = params.reduce(
    (builder, param) => builder.prop(param.name, buildParamFieldSchema(param)),
    obj(),
  );

  return buildValibotCall("object", [objBuilder.build()]);
};

/**
 * Create a SchemaBuilder implementation for Valibot.
 */
const createValibotSchemaBuilder = (): SchemaBuilder => ({
  build: (request: SchemaBuilderRequest): SchemaBuilderResult | undefined => {
    if (request.params.length === 0) {
      return undefined;
    }

    const ast = buildParamValibotObject(request.params);
    return {
      ast,
      importSpec: {
        namespace: "v",
        from: "valibot",
      },
    };
  },
});

// ============================================================================
// Provider Definition
// ============================================================================

/**
 * Create a valibot provider that generates Valibot schemas.
 *
 * @example
 * ```typescript
 * import { valibot } from "pg-sourcerer"
 *
 * export default defineConfig({
 *   plugins: [
 *     valibot(),
 *     valibot({ outputDir: "schemas", exportTypes: false }),
 *   ],
 * })
 * ```
 */
export function valibot(config: ValibotConfig = {}) {
  const parsed = S.decodeUnknownSync(ValibotConfigSchema)(config);

  return definePlugin({
    name: "valibot",
    kind: "schemas",
    singleton: true,

    canProvide: () => true,

    provide: (_params: unknown, _deps: readonly unknown[], ctx: PluginContext) => {
      const { ir, inflection } = ctx;
      const enumEntities = getEnumEntities(ir);

      // Register schema-builder service for on-demand param/query schema generation
      ctx.registerHandler(SCHEMA_BUILDER_KIND, createValibotSchemaBuilder().build);

      const fieldCtx: FieldContext = {
        enums: enumEntities,
        extensions: ir.extensions,
        enumStyle: parsed.enumStyle,
        typeReferences: parsed.typeReferences,
      };

      // Helper to build file path
      const buildFilePath = (entityName: string): string => `${parsed.outputDir}/${entityName}.ts`;

      // Generate separate enum files if configured
      if (parsed.typeReferences === "separate") {
        enumEntities
          .filter(e => e.tags.omit !== true)
          .forEach(enumEntity => {
            const statements = generateEnumStatement(
              enumEntity,
              parsed.enumStyle,
              parsed.exportTypes,
            );

            ctx
              .file(buildFilePath(enumEntity.name))
              .import({ kind: "package", namespace: "v", from: "valibot" })
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
            .import({ kind: "package", namespace: "v", from: "valibot" });

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
            .import({ kind: "package", namespace: "v", from: "valibot" });

          buildEnumImports(usedEnums).forEach(ref => fileBuilder.import(ref));

          fileBuilder.ast(conjure.symbolProgram(...statements)).emit();
        });
    },
  });
}

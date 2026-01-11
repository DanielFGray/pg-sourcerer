/**
 * Zod Plugin - Generate Zod schemas for entities
 *
 * Generates Zod schemas for Row, Insert, Update, and Patch shapes,
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
import {
  SCHEMA_BUILDER_KIND,
  type SchemaBuilder,
  type SchemaBuilderRequest,
  type SchemaBuilderResult,
} from "../ir/extensions/schema-builder.js";
import type { QueryMethodParam } from "../ir/extensions/queries.js";
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

/**
 * Configuration for the zod provider
 */
export interface ZodConfig {
  /** Output directory relative to main outputDir */
  readonly outputDir?: string
  /** Export inferred types alongside schemas */
  readonly exportTypes?: boolean
  /** How to represent enum values: 'strings' uses z.enum([...]), 'enum' uses z.nativeEnum(TsEnum) */
  readonly enumStyle?: "strings" | "enum"
  /** Where to define enum types: 'inline' embeds at usage, 'separate' generates enum files */
  readonly typeReferences?: "inline" | "separate"
}

const ZodConfigSchema = S.Struct({
  outputDir: S.optionalWith(S.String, { default: () => "zod" }),
  exportTypes: S.optionalWith(S.Boolean, { default: () => true }),
  enumStyle: S.optionalWith(S.Union(S.Literal("strings"), S.Literal("enum")), { default: () => "strings" as const }),
  typeReferences: S.optionalWith(S.Union(S.Literal("inline"), S.Literal("separate")), { default: () => "separate" as const }),
});

// ============================================================================
// Types
// ============================================================================

/** Context for field resolution */
interface FieldContext {
  readonly enums: readonly EnumEntity[];
  readonly extensions: readonly ExtensionInfo[];
  readonly enumStyle: "strings" | "enum";
  readonly typeReferences: "inline" | "separate";
}

// ============================================================================
// Zod Schema Builders (pure functions)
// ============================================================================

/**
 * Build z.<method>() and chain additional methods
 */
const buildZodChain = (baseMethod: string, chainMethods: readonly string[]): n.Expression =>
  chainMethods
    .reduce((chain, method) => chain.method(method), conjure.id("z").method(baseMethod))
    .build();

/**
 * Build z.enum([...values])
 */
const buildZodEnum = (values: readonly string[]): n.Expression =>
  conjure
    .id("z")
    .method("enum", [conjure.arr(...values.map(v => conjure.str(v))).build()])
    .build();

/**
 * Build z.array(<inner>)
 */
const buildZodArray = (inner: n.Expression): n.Expression =>
  conjure.id("z").method("array", [inner]).build();

/**
 * Add method calls to an existing expression
 */
const chainZodMethods = (expr: n.Expression, methods: readonly string[]): n.Expression =>
  methods.reduce((chain, method) => chain.method(method), conjure.chain(expr)).build();

/**
 * Map TypeScript type to Zod method name
 */
const tsTypeToZodMethod = (tsType: string): string => {
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
// Field → Zod Schema Resolution
// ============================================================================

/**
 * Resolve a field to its Zod schema expression.
 *
 * Order of resolution (first match wins):
 * 1. UUID types → z.string().uuid()
 * 2. Date types → z.coerce.date()
 * 3. Enum types → z.enum([...]) or reference
 * 4. Fallback to resolved TypeScript type
 *
 * Then wraps with array/nullable/optional as needed.
 */
const resolveFieldZodSchema = (field: Field, ctx: FieldContext): n.Expression => {
  // Get the base schema expression
  let baseSchema: n.Expression;

  // 1. UUID types get special treatment
  if (isUuidType(field)) {
    baseSchema = buildZodChain("string", ["uuid"]);
  }
  // 2. Date types use coercion for flexibility
  else if (isDateType(field)) {
    baseSchema = conjure.id("z").prop("coerce").method("date").build();
  }
  // 3. Enum types
  else if (isEnumType(field)) {
    const pgTypeName = getPgTypeName(field);
    const enumDef = pgTypeName
      ? pipe(
          findEnumByPgName(ctx.enums, pgTypeName),
          Option.getOrUndefined,
        )
      : undefined;

    if (enumDef) {
      if (ctx.typeReferences === "inline") {
        // Inline the enum values
        baseSchema = buildZodEnum(enumDef.values);
      } else {
        // Reference the separate enum schema
        baseSchema = conjure.id(enumDef.name).build();
      }
    } else {
      baseSchema = buildZodChain("unknown", []);
    }
  }
  // 4. Fallback to resolved TypeScript type
  else {
    const resolved = resolveFieldType(field, ctx.enums, ctx.extensions);
    const zodMethod = tsTypeToZodMethod(resolved.tsType);
    baseSchema = buildZodChain(zodMethod, []);
  }

  // Wrap with array if needed
  if (field.isArray) {
    baseSchema = buildZodArray(baseSchema);
  }

  // Collect modifiers to chain
  const modifiers: string[] = [];
  if (field.nullable) modifiers.push("nullable");
  if (field.optional) modifiers.push("optional");

  // Apply modifiers
  return modifiers.length > 0 ? chainZodMethods(baseSchema, modifiers) : baseSchema;
};

// ============================================================================
// Statement Generators
// ============================================================================

/**
 * Build z.object({...}) expression from shape fields
 */
const buildShapeZodObject = (shape: Shape, ctx: FieldContext): n.Expression => {
  const objBuilder = shape.fields.reduce(
    (builder, field) => builder.prop(field.name, resolveFieldZodSchema(field, ctx)),
    obj(),
  );
  return conjure.id("z").method("object", [objBuilder.build()]).build();
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
  const schemaExpr = buildShapeZodObject(shape, ctx);

  const schemaStatement = exp.const(shape.name, schemaSymbolCtx, schemaExpr);

  if (!exportTypes) {
    return [schemaStatement];
  }

  // Generate: export type ShapeName = z.infer<typeof ShapeName>
  // Register under "types" capability so other plugins can import
  const typeSymbolCtx = { capability: "types", entity: entityName, shape: shapeKind };
  const inferType = ts.qualifiedRef("z", "infer", [ts.typeof(shape.name)]);
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
 * Build z.object({...}) expression from composite fields
 */
const buildCompositeZodObject = (composite: CompositeEntity, ctx: FieldContext): n.Expression => {
  const objBuilder = composite.fields.reduce(
    (builder, field) => builder.prop(field.name, resolveFieldZodSchema(field, ctx)),
    obj(),
  );
  return conjure.id("z").method("object", [objBuilder.build()]).build();
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
  const schemaExpr = buildCompositeZodObject(composite, ctx);

  const schemaStatement = exp.const(composite.name, schemaSymbolCtx, schemaExpr);

  if (!exportTypes) {
    return [schemaStatement];
  }

  // Generate: export type CompositeName = z.infer<typeof CompositeName>
  // Register under "types" capability so other plugins can import
  const typeSymbolCtx = { capability: "types", entity: composite.name };
  const inferType = ts.qualifiedRef("z", "infer", [ts.typeof(composite.name)]);
  const typeStatement = exp.type(composite.name, typeSymbolCtx, inferType);

  return [schemaStatement, typeStatement];
};

// ============================================================================
// Enum Generation
// ============================================================================

/**
 * Generate enum schema statement: export const EnumName = z.enum(['a', 'b', ...])
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
    // Then: export const EnumNameSchema = z.nativeEnum(EnumName)
    const enumStatement = exp.tsEnum(
      enumEntity.name,
      { capability: "types", entity: enumEntity.name },
      enumEntity.values,
    );

    const schemaName = `${enumEntity.name}Schema`;
    const schemaExpr = conjure
      .id("z")
      .method("nativeEnum", [conjure.id(enumEntity.name).build()])
      .build();
    const schemaStatement = exp.const(schemaName, schemaSymbolCtx, schemaExpr);

    return [enumStatement, schemaStatement];
  }

  // strings style: export const EnumName = z.enum(['a', 'b', ...])
  const schemaExpr = buildZodEnum(enumEntity.values);
  const schemaStatement = exp.const(enumEntity.name, schemaSymbolCtx, schemaExpr);

  if (!exportTypes) {
    return [schemaStatement];
  }

  // Generate: export type EnumName = z.infer<typeof EnumName>
  // Register under "types" capability so other plugins can import
  const typeSymbolCtx = { capability: "types", entity: enumEntity.name };
  const inferType = ts.qualifiedRef("z", "infer", [ts.typeof(enumEntity.name)]);
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
 * Build Zod schema expression for a single param.
 * Uses z.coerce for numeric types since URL params are always strings.
 */
const buildParamFieldSchema = (param: QueryMethodParam): n.Expression => {
  const tsType = param.type.toLowerCase();
  let fieldSchema: n.Expression;

  switch (tsType) {
    case "number":
      // z.coerce.number() - converts string "10" to number 10
      fieldSchema = conjure.id("z").prop("coerce").method("number").build();
      break;
    case "boolean":
      // z.coerce.boolean() - converts "true"/"false" strings
      fieldSchema = conjure.id("z").prop("coerce").method("boolean").build();
      break;
    case "bigint":
      // z.coerce.bigint()
      fieldSchema = conjure.id("z").prop("coerce").method("bigint").build();
      break;
    case "date":
      // z.coerce.date() - converts ISO strings to Date objects
      fieldSchema = conjure.id("z").prop("coerce").method("date").build();
      break;
    case "string":
    default:
      // z.string() - no coercion needed
      fieldSchema = buildZodChain("string", []);
      break;
  }

  // Add .optional() for non-required params
  if (!param.required) {
    fieldSchema = chainZodMethods(fieldSchema, ["optional"]);
  }

  return fieldSchema;
};

/**
 * Build z.object({ ... }) expression from QueryMethodParam[].
 * For path/query parameter validation in HTTP handlers.
 */
const buildParamZodObject = (params: readonly QueryMethodParam[]): n.Expression => {
  const objBuilder = params.reduce(
    (builder, param) => builder.prop(param.name, buildParamFieldSchema(param)),
    obj(),
  );

  return conjure.id("z").method("object", [objBuilder.build()]).build();
};

/**
 * Create a SchemaBuilder implementation for Zod.
 */
const createZodSchemaBuilder = (): SchemaBuilder => ({
  build: (request: SchemaBuilderRequest): SchemaBuilderResult | undefined => {
    if (request.params.length === 0) {
      return undefined;
    }

    const ast = buildParamZodObject(request.params);
    return {
      ast,
      importSpec: {
        names: ["z"],
        from: "zod",
      },
    };
  },
});

// ============================================================================
// Provider Definition
// ============================================================================

/**
 * Create a zod provider that generates Zod schemas.
 *
 * @example
 * ```typescript
 * import { zod } from "pg-sourcerer"
 *
 * export default defineConfig({
 *   plugins: [
 *     zod(),
 *     zod({ outputDir: "schemas", exportTypes: false }),
 *   ],
 * })
 * ```
 */
export function zod(config: ZodConfig = {}): ReturnType<typeof definePlugin> {
  const parsed = S.decodeUnknownSync(ZodConfigSchema)(config);

  return definePlugin({
    name: "zod",
    kind: "schemas",
    singleton: true,

    canProvide: () => true,

    provide: (_params: unknown, _deps: readonly unknown[], ctx: PluginContext) => {
      const { ir, inflection } = ctx;
      const enumEntities = getEnumEntities(ir);

      // Register schema-builder service for on-demand param/query schema generation
      ctx.registerHandler(SCHEMA_BUILDER_KIND, createZodSchemaBuilder().build);

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
              .import({ kind: "package", names: ["z"], from: "zod" })
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
            .import({ kind: "package", names: ["z"], from: "zod" });

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
            .import({ kind: "package", names: ["z"], from: "zod" });

          buildEnumImports(usedEnums).forEach(ref => fileBuilder.import(ref));

          fileBuilder.ast(conjure.symbolProgram(...statements)).emit();
        });

      return undefined;
    },
  });
}



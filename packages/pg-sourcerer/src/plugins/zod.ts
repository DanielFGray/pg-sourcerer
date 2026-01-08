/**
 * Zod Plugin - Generate Zod schemas for entities
 *
 * Generates Zod schemas for Row, Insert, Update, and Patch shapes,
 * with inferred TypeScript types.
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
import { isUuidType, isDateType, isEnumType, getPgTypeName, resolveFieldType } from "../lib/field-utils.js";

const { ts, exp, obj } = conjure;

// ============================================================================
// Configuration
// ============================================================================

const ZodPluginConfig = S.Struct({
  /** Output directory relative to main outputDir */
  outputDir: S.String,
  /** Export inferred types alongside schemas */
  exportTypes: S.Boolean,
  /** How to represent enum values: 'strings' uses z.enum([...]), 'enum' uses z.nativeEnum(TsEnum) */
  enumStyle: S.optional(S.Union(S.Literal("strings"), S.Literal("enum"))),
  /** Where to define enum types: 'inline' embeds at usage, 'separate' generates enum files */
  typeReferences: S.optional(S.Union(S.Literal("inline"), S.Literal("separate"))),
});

type ZodPluginConfig = S.Schema.Type<typeof ZodPluginConfig>;

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

interface FieldContext {
  readonly enums: Iterable<EnumEntity>;
  readonly extensions: readonly ExtensionInfo[];
  readonly enumStyle: "strings" | "enum";
  readonly typeReferences: "inline" | "separate";
}

/**
 * Apply nullable/optional/array modifiers to a base schema
 */
const applyFieldModifiers = (
  schema: n.Expression,
  field: Pick<Field, "isArray" | "nullable" | "optional">,
): n.Expression => {
  const modifiers: string[] = [];
  if (field.nullable) modifiers.push("nullable");
  if (field.optional) modifiers.push("optional");

  const withArray = field.isArray ? buildZodArray(schema) : schema;
  return modifiers.length > 0 ? chainZodMethods(withArray, modifiers) : withArray;
};

/**
 * Resolve a field to its Zod schema expression
 */
const resolveFieldZodSchema = (field: Field, ctx: FieldContext): n.Expression => {
  const resolved = resolveFieldType(field, ctx.enums, ctx.extensions);

  // Enum handling
  if (resolved.enumDef) {
    let enumSchema: n.Expression;
    
    if (ctx.typeReferences === "separate") {
      // Reference by name - the enum schema is imported
      enumSchema = conjure.id(resolved.enumDef.name).build();
    } else if (ctx.enumStyle === "enum") {
      // Inline native enum: z.nativeEnum(EnumName)
      // Note: This requires the TS enum to be generated separately
      enumSchema = conjure.id("z").method("nativeEnum", [
        conjure.id(resolved.enumDef.name).build()
      ]).build();
    } else {
      // Inline strings: z.enum(['a', 'b', 'c'])
      enumSchema = buildZodEnum(resolved.enumDef.values);
    }
    
    return applyFieldModifiers(enumSchema, field);
  }

  // UUID → z.string().uuid()
  if (isUuidType(field)) {
    return applyFieldModifiers(buildZodChain("string", ["uuid"]), field);
  }

  // Date/timestamp → z.coerce.date()
  if (isDateType(field)) {
    const dateSchema = conjure.id("z").prop("coerce").method("date").build();
    return applyFieldModifiers(dateSchema, field);
  }

  // Standard type mapping
  return applyFieldModifiers(buildZodChain(tsTypeToZodMethod(resolved.tsType), []), field);
};

// ============================================================================
// Shape → Statement Generation
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
  const symbolCtx = { capability: "schemas:zod", entity: entityName, shape: shapeKind };
  const schemaExpr = buildShapeZodObject(shape, ctx);

  const schemaStatement = exp.const(shape.name, symbolCtx, schemaExpr);

  if (!exportTypes) {
    return [schemaStatement];
  }

  // Generate: export type ShapeName = z.infer<typeof ShapeName>
  const inferType = ts.qualifiedRef("z", "infer", [ts.typeof(shape.name)]);
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
  const symbolCtx = { capability: "schemas:zod", entity: composite.name };
  const schemaExpr = buildCompositeZodObject(composite, ctx);

  const schemaStatement = exp.const(composite.name, symbolCtx, schemaExpr);

  if (!exportTypes) {
    return [schemaStatement];
  }

  // Generate: export type CompositeName = z.infer<typeof CompositeName>
  const inferType = ts.qualifiedRef("z", "infer", [ts.typeof(composite.name)]);
  const typeStatement = exp.type(composite.name, symbolCtx, inferType);

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
): readonly SymbolStatement[] => {
  const symbolCtx = { capability: "schemas:zod", entity: enumEntity.name };

  if (enumStyle === "enum") {
    // Generate: export enum EnumName { A = 'a', B = 'b', ... }
    // Then: export const EnumNameSchema = z.nativeEnum(EnumName)
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
        capability: "schemas:zod",
        entity: enumEntity.name,
        isType: true,
      },
    };

    const schemaName = `${enumEntity.name}Schema`;
    const schemaExpr = conjure.id("z").method("nativeEnum", [
      conjure.id(enumEntity.name).build()
    ]).build();
    const schemaStatement = exp.const(schemaName, symbolCtx, schemaExpr);

    return [enumStatement, schemaStatement];
  }

  // strings style: export const EnumName = z.enum(['a', 'b', ...])
  const schemaExpr = buildZodEnum(enumEntity.values);
  return [exp.const(enumEntity.name, symbolCtx, schemaExpr)];
};

/** Collect enum names used by fields */
const collectUsedEnums = (fields: readonly Field[], enums: readonly EnumEntity[]): Set<string> => {
  const enumNames = fields
    .filter(isEnumType)
    .flatMap(field => {
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
    ref: { capability: "schemas:zod", entity: enumName },
  }));

// ============================================================================
// Plugin Definition
// ============================================================================

/**
 * Zod Plugin
 *
 * Generates Zod schemas for each entity's shapes (base, Insert, Update)
 * with inferred TypeScript types.
 */
export const zodPlugin = definePlugin({
  name: "zod",
  provides: ["schemas:zod", "schemas"],
  configSchema: ZodPluginConfig,
  inflection: {
    outputFile: ctx => `${ctx.entityName}.ts`,
    symbolName: (entityName, artifactKind) => `${entityName}${artifactKind}`,
  },

  run: (ctx, config) => {
    const enumEntities = getEnumEntities(ctx.ir);
    const enumStyle = config.enumStyle ?? "strings";
    const typeReferences = config.typeReferences ?? "separate";
    
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
            .import({ kind: "package", names: ["z"], from: "zod" })
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
        const usedEnums = typeReferences === "separate"
          ? collectUsedEnums(allFields, Arr.fromIterable(fieldCtx.enums))
          : new Set<string>();

        const fileBuilder = ctx
          .file(filePath)
          .import({ kind: "package", names: ["z"], from: "zod" });

        // Add enum imports when using separate files
        buildEnumImports(usedEnums).forEach(ref => fileBuilder.import(ref));

        fileBuilder
          .ast(conjure.symbolProgram(...statements))
          .emit();
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
        const usedEnums = typeReferences === "separate"
          ? collectUsedEnums(composite.fields, Arr.fromIterable(fieldCtx.enums))
          : new Set<string>();

        const fileBuilder = ctx
          .file(filePath)
          .import({ kind: "package", names: ["z"], from: "zod" });

        buildEnumImports(usedEnums).forEach(ref => fileBuilder.import(ref));

        fileBuilder
          .ast(conjure.symbolProgram(...statements))
          .emit();
      });
  },
});

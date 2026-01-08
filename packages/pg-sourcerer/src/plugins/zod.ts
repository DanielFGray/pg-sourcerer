/**
 * Zod Plugin - Generate Zod schemas for entities
 *
 * Generates Zod schemas for Row, Insert, Update, and Patch shapes,
 * with inferred TypeScript types.
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

const ZodPluginConfig = S.Struct({
  /** Output directory relative to main outputDir */
  outputDir: S.String,
  /** Export inferred types alongside schemas */
  exportTypes: S.Boolean,
});

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

  // Enum → z.enum([...values])
  if (resolved.enumDef) {
    return applyFieldModifiers(buildZodEnum(resolved.enumDef.values), field);
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
    const fieldCtx: FieldContext = { enums: enumEntities, extensions: ctx.ir.extensions };

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

        ctx
          .file(filePath)
          .header("// This file is auto-generated. Do not edit.\n")
          .import({ kind: "package", names: ["z"], from: "zod" })
          .ast(conjure.symbolProgram(...statements))
          .emit();
      });
  },
});

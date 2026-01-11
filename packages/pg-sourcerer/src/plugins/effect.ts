/**
 * Effect Plugin - Unified @effect/sql + @effect/platform code generation
 *
 * Generates:
 * - Model classes (@effect/sql Model.Class with variants)
 * - Repositories (Model.makeRepository or SqlSchema/SqlResolver functions)
 * - HTTP API (@effect/platform HttpApi with full handlers)
 *
 * This plugin merges and replaces the deprecated effect-model plugin.
 */
import { Array as Arr, Option, pipe, Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";
import type { ExpressionKind } from "ast-types/lib/gen/kinds.js";
import { definePlugin, type PluginContext } from "../services/plugin.js";
import { inflect } from "../services/inflection.js";
import { findEnumByPgName, TsType } from "../services/pg-types.js";
import type { EnumLookupResult } from "../services/pg-types.js";
import type {
  Field,
  TableEntity,
  EnumEntity,
  ExtensionInfo,
  CompositeEntity,
} from "../ir/semantic-ir.js";
import {
  getEnumEntities,
  getTableEntities,
  getCompositeEntities,
} from "../ir/semantic-ir.js";
import { conjure } from "../lib/conjure.js";
import type { SymbolStatement } from "../lib/conjure.js";
import type { ImportRef } from "../services/file-builder.js";
import {
  isUuidType,
  isDateType,
  isBigIntType,
  isEnumType,
  getPgTypeName,
  resolveFieldType,
} from "../lib/field-utils.js";

const { ts, exp, obj } = conjure;

// ============================================================================
// Configuration
// ============================================================================

/**
 * HTTP API configuration
 */
const HttpConfigSchema = S.Struct({
  /** Enable HTTP API generation */
  enabled: S.optionalWith(S.Boolean, { default: () => true }),
  /** Output subdirectory for API files. Default: "api" */
  outputDir: S.optionalWith(S.String, { default: () => "api" }),
  /** Base path for all routes. Default: "/api" */
  basePath: S.optionalWith(S.String, { default: () => "/api" }),
  /** Enable Swagger/OpenAPI generation */
  swagger: S.optionalWith(S.Boolean, { default: () => true }),
});

/**
 * Configuration for the effect plugin
 */
export interface EffectConfig {
  /** Output directory relative to main outputDir. Default: "effect". Use "." for flat (no subfolder). */
  readonly outputDir?: string;
  /** Subdirectory for models/enums within outputDir. Default: undefined (flat). Example: "schema" */
  readonly schemaDir?: string;
  /** How to represent enum values: 'strings' uses S.Union(S.Literal(...)), 'enum' uses S.Enums(TsEnum) */
  readonly enumStyle?: "strings" | "enum";
  /** Where to define enum types: 'inline' embeds at usage, 'separate' generates enum files */
  readonly typeReferences?: "inline" | "separate";
  /** Export inferred types for composite schemas. Default: true */
  readonly exportTypes?: boolean;
  /** Query generation mode: 'repository' uses Model.makeRepository, 'resolvers' uses SqlSchema functions */
  readonly queryMode?: "repository" | "resolvers";
  /** HTTP API generation config. Set to false to disable. */
  readonly http?: false | {
    readonly enabled?: boolean;
    /** Output subdirectory for API files. Default: "api" */
    readonly outputDir?: string;
    readonly basePath?: string;
    readonly swagger?: boolean;
  };
}

const EffectConfigSchema = S.Struct({
  outputDir: S.optionalWith(S.String, { default: () => "effect" }),
  schemaDir: S.optional(S.String),
  enumStyle: S.optionalWith(
    S.Union(S.Literal("strings"), S.Literal("enum")),
    { default: () => "strings" as const }
  ),
  typeReferences: S.optionalWith(
    S.Union(S.Literal("inline"), S.Literal("separate")),
    { default: () => "separate" as const }
  ),
  exportTypes: S.optionalWith(S.Boolean, { default: () => true }),
  queryMode: S.optionalWith(
    S.Union(S.Literal("repository"), S.Literal("resolvers")),
    { default: () => "repository" as const }
  ),
  http: S.optionalWith(
    S.Union(S.Literal(false), HttpConfigSchema),
    { default: () => ({ enabled: true, outputDir: "api", basePath: "/api", swagger: true }) }
  ),
});

/**
 * Normalize outputDir: "." becomes "" for path joining
 */
const normalizeOutputDir = (dir: string): string =>
  dir === "." ? "" : dir;

/**
 * Build a file path, handling empty segments gracefully
 */
const buildPath = (...segments: (string | undefined)[]): string =>
  segments.filter((s) => s !== undefined && s !== "").join("/") + ".ts";

type ParsedEffectConfig = S.Schema.Type<typeof EffectConfigSchema>;

// ============================================================================
// Smart Tags
// ============================================================================

const EffectTagsSchema = S.Struct({
  /** Override insert optionality: "optional" or "required" */
  insert: S.optional(S.Union(S.Literal("optional"), S.Literal("required"))),
  /** Mark field as sensitive - excluded from json variants */
  sensitive: S.optional(S.Boolean),
  /** Exclude entity from HTTP API generation */
  http: S.optional(S.Union(S.Literal(false), S.Struct({
    operations: S.optional(S.Array(S.Union(
      S.Literal("list"),
      S.Literal("read"),
      S.Literal("create"),
      S.Literal("update"),
      S.Literal("delete"),
    ))),
    path: S.optional(S.String),
  }))),
  /** Skip repository generation for this entity */
  repo: S.optional(S.Literal(false)),
});

type EffectTags = S.Schema.Type<typeof EffectTagsSchema>;

const getEffectTags = (field: Field): EffectTags => {
  const pluginTags = field.tags["effect"];
  if (!pluginTags) return {};
  try {
    return S.decodeUnknownSync(EffectTagsSchema)(pluginTags);
  } catch {
    return {};
  }
};

const getEntityEffectTags = (entity: TableEntity): EffectTags => {
  const pluginTags = entity.tags["effect"];
  if (!pluginTags) return {};
  try {
    return S.decodeUnknownSync(EffectTagsSchema)(pluginTags);
  } catch {
    return {};
  }
};

// Also support legacy effect:model tags for backward compatibility
const getEffectModelTags = (field: Field): EffectTags => {
  const pluginTags = field.tags["effect:model"];
  if (!pluginTags) return {};
  try {
    return S.decodeUnknownSync(EffectTagsSchema)(pluginTags);
  } catch {
    return {};
  }
};

const isSensitive = (field: Field): boolean =>
  getEffectTags(field).sensitive === true || getEffectModelTags(field).sensitive === true;

const getInsertOverride = (field: Field): "optional" | "required" | undefined =>
  getEffectTags(field).insert ?? getEffectModelTags(field).insert;

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
      enumResult.values.map((v) =>
        conjure.id("S").method("Literal", [conjure.str(v)]).build()
      )
    )
    .build();

// ============================================================================
// Schema Wrappers
// ============================================================================

const wrapIf = (
  schema: n.Expression,
  condition: boolean,
  wrapper: (s: n.Expression) => n.Expression
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
  readonly enumStyle: "strings" | "enum";
  readonly typeReferences: "inline" | "separate";
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

  if (resolved.enumDef) {
    if (ctx.typeReferences === "separate") {
      // Reference by name - the enum schema is imported
      return conjure.id(resolved.enumDef.name).build();
    } else if (ctx.enumStyle === "enum") {
      // Inline native enum: S.Enums(EnumName)
      return conjure
        .id("S")
        .method("Enums", [conjure.id(resolved.enumDef.name).build()])
        .build();
    } else {
      // Inline strings: S.Union(S.Literal(...), ...)
      return buildEnumSchema(resolved.enumDef);
    }
  }

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
  if (autoTs === "insert")
    return conjure.id("Model").prop("DateTimeInsertFromDate").build();
  if (autoTs === "update")
    return conjure.id("Model").prop("DateTimeUpdateFromDate").build();

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
  ctx: FieldContext
): n.Expression => {
  // Build fields object from row shape
  const fieldsObj = entity.shapes.row.fields.reduce(
    (builder, field) => builder.prop(field.name, buildFieldSchema(field, ctx)),
    obj()
  );

  // Build: Model.Class<ClassName>("table_name")
  const modelClassRef = conjure.b.memberExpression(
    conjure.b.identifier("Model"),
    conjure.b.identifier("Class")
  );

  const modelClassWithType = conjure.b.callExpression(modelClassRef, [
    conjure.str(entity.pgName),
  ]);

  // Add type parameters: Model.Class<ClassName>
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
  ctx: FieldContext
): SymbolStatement => {
  const modelExpr = buildModelClass(entity, className, ctx);

  const classDecl = conjure.b.classDeclaration(
    conjure.b.identifier(className),
    conjure.b.classBody([]),
    toExprKind(modelExpr)
  );

  return {
    _tag: "SymbolStatement",
    node: conjure.b.exportNamedDeclaration(classDecl, []),
    symbol: {
      name: className,
      capability: "models",
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
    { capability: "models", entity: enumEntity.name },
    buildEnumSchema({
      name: enumEntity.name,
      pgName: enumEntity.pgName,
      values: enumEntity.values,
    })
  );

// ============================================================================
// Composite Type Generation
// ============================================================================

interface CompositeFieldContext {
  readonly enums: readonly EnumEntity[];
  readonly extensions: readonly ExtensionInfo[];
  readonly enumStyle: "strings" | "enum";
  readonly typeReferences: "inline" | "separate";
}

/**
 * Build the base Effect Schema type for a composite field (no Model wrappers)
 */
const buildCompositeFieldSchema = (
  field: Field,
  ctx: CompositeFieldContext
): n.Expression => {
  const resolved = resolveFieldType(field, ctx.enums, ctx.extensions);

  if (resolved.enumDef) {
    if (ctx.typeReferences === "separate") {
      return conjure.id(resolved.enumDef.name).build();
    } else if (ctx.enumStyle === "enum") {
      return conjure
        .id("S")
        .method("Enums", [conjure.id(resolved.enumDef.name).build()])
        .build();
    } else {
      return buildEnumSchema(resolved.enumDef);
    }
  }

  if (isUuidType(field)) return conjure.id("S").prop("UUID").build();
  if (isDateType(field)) return conjure.id("S").prop("Date").build();
  if (isBigIntType(field)) return conjure.id("S").prop("BigInt").build();

  return tsTypeToEffectSchema(resolved.tsType);
};

/**
 * Generate: export const CompositeName = S.Struct({ ... })
 * Optionally: export type CompositeName = S.Schema.Type<typeof CompositeName>
 */
const generateCompositeStatements = (
  composite: CompositeEntity,
  ctx: CompositeFieldContext,
  exportTypes: boolean
): readonly SymbolStatement[] => {
  // Build S.Struct({ ... }) for composite fields
  const fieldsObj = composite.fields.reduce((builder, field) => {
    let schema = buildCompositeFieldSchema(field, ctx);
    schema = wrapIf(schema, field.isArray, wrapArray);
    schema = wrapIf(schema, field.nullable, wrapNullable);
    return builder.prop(field.name, schema);
  }, obj());

  const structExpr = conjure
    .id("S")
    .method("Struct", [fieldsObj.build()])
    .build();
  const modelSymbolCtx = { capability: "models", entity: composite.name };

  const schemaStatement = exp.const(composite.name, modelSymbolCtx, structExpr);

  if (!exportTypes) {
    return [schemaStatement];
  }

  // Generate: export type CompositeName = S.Schema.Type<typeof CompositeName>
  const typeSymbolCtx = { capability: "types", entity: composite.name };
  const inferType = ts.qualifiedRefWithParams(
    ["S", "Schema", "Type"],
    [ts.typeof(composite.name)]
  );
  const typeStatement = exp.type(composite.name, typeSymbolCtx, inferType);

  return [schemaStatement, typeStatement];
};

// ============================================================================
// Enum Helpers
// ============================================================================

/** Collect enum names used by fields */
const collectUsedEnums = (
  fields: readonly Field[],
  enums: readonly EnumEntity[]
): Set<string> => {
  const enumNames = fields.filter(isEnumType).flatMap((field) => {
    const pgTypeName = getPgTypeName(field);
    if (!pgTypeName) return [];
    return pipe(
      findEnumByPgName(enums, pgTypeName),
      Option.map((e) => e.name),
      Option.toArray
    );
  });
  return new Set(enumNames);
};

/** Build import refs for used enums */
const buildEnumImports = (usedEnums: Set<string>): readonly ImportRef[] =>
  Arr.fromIterable(usedEnums).map((enumName) => ({
    kind: "symbol" as const,
    ref: { capability: "models", entity: enumName },
  }));

/**
 * Generate enum schema for native enum style.
 * Generates: export enum EnumName { A = 'a', ... } + export const EnumNameSchema = S.Enums(EnumName)
 */
const generateNativeEnumStatements = (
  enumEntity: EnumEntity
): readonly SymbolStatement[] => {
  const symbolCtx = { capability: "models", entity: enumEntity.name };

  // Generate: export enum EnumName { A = 'a', B = 'b', ... }
  const enumStatement = exp.tsEnum(
    enumEntity.name,
    symbolCtx,
    enumEntity.values
  );

  const schemaName = `${enumEntity.name}Schema`;
  const schemaExpr = conjure
    .id("S")
    .method("Enums", [conjure.id(enumEntity.name).build()])
    .build();
  const schemaStatement = exp.const(schemaName, symbolCtx, schemaExpr);

  return [enumStatement, schemaStatement];
};

// ============================================================================
// Model Generation
// ============================================================================

/**
 * Generate all Model class files
 */
const generateModels = (
  ctx: PluginContext,
  config: ParsedEffectConfig
): void => {
  const { ir, inflection } = ctx;
  const enumEntities = getEnumEntities(ir);
  const { enumStyle, typeReferences, schemaDir, queryMode } = config;
  const outputDir = normalizeOutputDir(config.outputDir);

  // Helper to build file path for models (in schemaDir if set, otherwise directly in outputDir)
  const buildModelPath = (entityName: string): string =>
    buildPath(outputDir, schemaDir, entityName);

  // Generate separate enum files if configured
  if (typeReferences === "separate") {
    enumEntities
      .filter((e) => e.tags.omit !== true)
      .forEach((enumEntity) => {
        const filePath = buildModelPath(enumEntity.name);

        const statements =
          enumStyle === "enum"
            ? generateNativeEnumStatements(enumEntity)
            : [generateEnumStatement(enumEntity)];

        ctx
          .file(filePath)
          .import({ kind: "package", names: ["Schema as S"], from: "effect" })
          .ast(conjure.symbolProgram(...statements))
          .emit();
      });
  }

  // Generate table/view entity model files
  getTableEntities(ir)
    .filter((entity) => entity.tags.omit !== true)
    .forEach((entity) => {
      const className = inflection.entityName(entity.pgClass, entity.tags);
      const fieldCtx: FieldContext = {
        entity,
        enums: enumEntities,
        extensions: ir.extensions,
        enumStyle,
        typeReferences,
      };

      const filePath = buildModelPath(className);

      // Collect enum usage for imports
      const usedEnums =
        typeReferences === "separate"
          ? collectUsedEnums(entity.shapes.row.fields, enumEntities)
          : new Set<string>();

      const fileBuilder = ctx
        .file(filePath)
        .import({ kind: "package", names: ["Model"], from: "@effect/sql" })
        .import({ kind: "package", names: ["Schema as S"], from: "effect" });

      buildEnumImports(usedEnums).forEach((ref) => fileBuilder.import(ref));

      // Build statements: Model class + optional Repo
      const statements: SymbolStatement[] = [
        generateModelStatement(entity, className, fieldCtx),
      ];

      // Add repo if: queryMode is 'repository', entity is a table with single-column PK, not skipped
      if (
        queryMode === "repository" &&
        entity.kind === "table" &&
        hasSingleColumnPrimaryKey(entity) &&
        !shouldSkipRepo(entity)
      ) {
        const idColumn = getPrimaryKeyColumn(entity);
        if (idColumn) {
          statements.push(generateRepoStatement(entity, className, idColumn));
        }
      }

      fileBuilder
        .ast(conjure.symbolProgram(...statements))
        .emit();
    });

  // Generate composite type schema files
  const compositeFieldCtx: CompositeFieldContext = {
    enums: enumEntities,
    extensions: ir.extensions,
    enumStyle,
    typeReferences,
  };

  getCompositeEntities(ir)
    .filter((composite) => composite.tags.omit !== true)
    .forEach((composite) => {
      const filePath = buildModelPath(composite.name);

      // Collect enum usage for imports
      const usedEnums =
        typeReferences === "separate"
          ? collectUsedEnums(composite.fields, enumEntities)
          : new Set<string>();

      const fileBuilder = ctx
        .file(filePath)
        .import({ kind: "package", names: ["Schema as S"], from: "effect" });

      buildEnumImports(usedEnums).forEach((ref) => fileBuilder.import(ref));

      fileBuilder
        .ast(
          conjure.symbolProgram(
            ...generateCompositeStatements(
              composite,
              compositeFieldCtx,
              config.exportTypes
            )
          )
        )
        .emit();
    });
};

// ============================================================================
// Repository Generation (Phase 2A)
// ============================================================================

/**
 * Get the qualified table name (schema.table)
 */
const getQualifiedTableName = (entity: TableEntity): string =>
  `${entity.schemaName}.${entity.pgName}`;

/**
 * Check if entity has a single-column primary key suitable for makeRepository
 */
const hasSingleColumnPrimaryKey = (entity: TableEntity): boolean =>
  entity.primaryKey !== undefined && entity.primaryKey.columns.length === 1;

/**
 * Get the primary key column name for an entity
 */
const getPrimaryKeyColumn = (entity: TableEntity): string | undefined =>
  entity.primaryKey?.columns[0];

/**
 * Check if entity should skip repository generation based on tags
 */
const shouldSkipRepo = (entity: TableEntity): boolean => {
  const pluginTags = entity.tags["effect"];
  if (!pluginTags) return false;
  try {
    const parsed = S.decodeUnknownSync(EffectTagsSchema)(pluginTags);
    return parsed.repo === false;
  } catch {
    return false;
  }
};

/**
 * Generate repository statement:
 * export const {Entity}Repo = Model.makeRepository({Entity}, { tableName, spanPrefix, idColumn })
 */
const generateRepoStatement = (
  entity: TableEntity,
  className: string,
  idColumn: string
): SymbolStatement => {
  const repoName = `${className}Repo`;
  const qualifiedTableName = getQualifiedTableName(entity);

  // Build: Model.makeRepository(Entity, { tableName: "...", spanPrefix: "...", idColumn: "..." })
  const makeRepoCall = conjure.b.callExpression(
    conjure.b.memberExpression(
      conjure.b.identifier("Model"),
      conjure.b.identifier("makeRepository")
    ),
    [
      conjure.b.identifier(className),
      obj()
        .prop("tableName", conjure.str(qualifiedTableName))
        .prop("spanPrefix", conjure.str(repoName))
        .prop("idColumn", conjure.str(idColumn))
        .build(),
    ]
  );

  return exp.const(repoName, { capability: "queries", entity: entity.name }, makeRepoCall);
};

/**
 * Generate repository files for entities with single-column primary keys
 * NOTE: Repos are now generated inline with models in generateModels()
 * This function is kept for potential future use (e.g., separate file mode)
 */
const generateRepositories = (
  _ctx: PluginContext,
  _config: ParsedEffectConfig
): void => {
  // Repos are now generated inline with models
};

// ============================================================================
// HTTP API Generation (Phase 3A)
// ============================================================================

/**
 * Get parsed HTTP config from entity tags
 */
const getEntityHttpConfig = (entity: TableEntity): { skip: boolean; operations?: string[]; path?: string } => {
  const pluginTags = entity.tags["effect"];
  if (!pluginTags) return { skip: false };
  try {
    const parsed = S.decodeUnknownSync(EffectTagsSchema)(pluginTags);
    if (parsed.http === false) return { skip: true };
    if (typeof parsed.http === "object") {
      return {
        skip: false,
        operations: parsed.http.operations ? [...parsed.http.operations] : undefined,
        path: parsed.http.path,
      };
    }
    return { skip: false };
  } catch {
    return { skip: false };
  }
};

/**
 * Get the schema type for the primary key (for path params)
 */
const getPrimaryKeySchemaType = (entity: TableEntity): string => {
  const pkColumn = entity.primaryKey?.columns[0];
  if (!pkColumn) return "S.String";

  const pkField = entity.shapes.row.fields.find((f) => f.columnName === pkColumn);
  if (!pkField) return "S.String";

  // Check the underlying type
  const pgType = pkField.pgAttribute.getType();
  if (!pgType) return "S.String";

  // Map common PK types
  switch (pgType.typname) {
    case "int2":
    case "int4":
    case "int8":
    case "serial":
    case "bigserial":
      return "S.NumberFromString";
    case "uuid":
      return "S.UUID";
    default:
      return "S.String";
  }
};

/**
 * Generate NotFound error class:
 * export class {Entity}NotFound extends S.TaggedError<{Entity}NotFound>()("{Entity}NotFound", { id: Schema }) {}
 */
const generateNotFoundError = (className: string, idSchemaType: string): SymbolStatement => {
  const errorName = `${className}NotFound`;

  // Build: S.TaggedError<ErrorName>()("ErrorName", { id: Schema })
  // This is complex AST - use a simpler approach with raw template
  const taggedErrorCall = conjure.b.callExpression(
    conjure.b.callExpression(
      conjure.b.memberExpression(
        conjure.b.identifier("S"),
        conjure.b.identifier("TaggedError")
      ),
      []
    ),
    [
      conjure.str(errorName),
      obj().prop("id", conjure.b.identifier(idSchemaType)).build(),
    ]
  );

  // Add type parameter to the first call: S.TaggedError<ErrorName>
  const innerCall = (taggedErrorCall as n.CallExpression).callee as n.CallExpression;
  (innerCall as { typeParameters?: unknown }).typeParameters =
    conjure.b.tsTypeParameterInstantiation([
      conjure.b.tsTypeReference(conjure.b.identifier(errorName)),
    ]);

  // Build class: class ErrorName extends S.TaggedError<ErrorName>()(...) {}
  const classDecl = conjure.b.classDeclaration(
    conjure.b.identifier(errorName),
    conjure.b.classBody([]),
    taggedErrorCall as ExpressionKind
  );

  return {
    _tag: "SymbolStatement",
    node: conjure.b.exportNamedDeclaration(classDecl, []),
    symbol: {
      name: errorName,
      capability: "http",
      entity: className,
      isType: false,
    },
  };
};

/**
 * Generate HttpApiGroup for an entity with CRUD endpoints
 */
const generateApiGroup = (
  entity: TableEntity,
  className: string,
  basePath: string,
  idSchemaType: string
): SymbolStatement => {
  const groupName = `${className}Api`;
  const errorName = `${className}NotFound`;
  // Convert snake_case to kebab-case: user_emails -> user-emails
  const kebabName = entity.pgName.replace(/_/g, "-");
  const pluralPath = inflect.pluralize(kebabName);
  const fullPath = `${basePath}/${pluralPath}`;

  // Build the id path param: HttpApiSchema.param("id", Schema)
  const idParam = conjure.b.callExpression(
    conjure.b.memberExpression(
      conjure.b.identifier("HttpApiSchema"),
      conjure.b.identifier("param")
    ),
    [conjure.str("id"), conjure.b.identifier(idSchemaType)]
  );

  // GET / - list endpoint
  const listEndpoint = conjure.b.callExpression(
    conjure.b.memberExpression(
      conjure.b.callExpression(
        conjure.b.memberExpression(
          conjure.b.identifier("HttpApiEndpoint"),
          conjure.b.identifier("get")
        ),
        [conjure.str("list"), conjure.str("/")]
      ),
      conjure.b.identifier("addSuccess")
    ),
    [
      conjure.b.callExpression(
        conjure.b.memberExpression(conjure.b.identifier("S"), conjure.b.identifier("Array")),
        [conjure.b.memberExpression(conjure.b.identifier(className), conjure.b.identifier("json"))]
      ),
    ]
  );

  // GET /:id - get endpoint (with template literal for path param)
  // HttpApiEndpoint.get("get")`/${idParam}`.addSuccess(Entity.json).addError(NotFound, { status: 404 })
  const getEndpointBase = conjure.b.taggedTemplateExpression(
    conjure.b.callExpression(
      conjure.b.memberExpression(
        conjure.b.identifier("HttpApiEndpoint"),
        conjure.b.identifier("get")
      ),
      [conjure.str("get")]
    ),
    conjure.b.templateLiteral(
      [
        conjure.b.templateElement({ raw: "/", cooked: "/" }, false),
        conjure.b.templateElement({ raw: "", cooked: "" }, true),
      ],
      [idParam]
    )
  );
  const getEndpointWithSuccess = conjure.b.callExpression(
    conjure.b.memberExpression(getEndpointBase, conjure.b.identifier("addSuccess")),
    [conjure.b.memberExpression(conjure.b.identifier(className), conjure.b.identifier("json"))]
  );
  const getEndpoint = conjure.b.callExpression(
    conjure.b.memberExpression(getEndpointWithSuccess, conjure.b.identifier("addError")),
    [conjure.b.identifier(errorName), obj().prop("status", conjure.b.literal(404)).build()]
  );

  // POST / - create endpoint
  const createEndpointBase = conjure.b.callExpression(
    conjure.b.memberExpression(
      conjure.b.identifier("HttpApiEndpoint"),
      conjure.b.identifier("post")
    ),
    [conjure.str("create"), conjure.str("/")]
  );
  const createEndpointWithPayload = conjure.b.callExpression(
    conjure.b.memberExpression(createEndpointBase, conjure.b.identifier("setPayload")),
    [conjure.b.memberExpression(conjure.b.identifier(className), conjure.b.identifier("jsonCreate"))]
  );
  const createEndpoint = conjure.b.callExpression(
    conjure.b.memberExpression(createEndpointWithPayload, conjure.b.identifier("addSuccess")),
    [conjure.b.memberExpression(conjure.b.identifier(className), conjure.b.identifier("json"))]
  );

  // PUT /:id - update endpoint
  const updateEndpointBase = conjure.b.taggedTemplateExpression(
    conjure.b.callExpression(
      conjure.b.memberExpression(
        conjure.b.identifier("HttpApiEndpoint"),
        conjure.b.identifier("put")
      ),
      [conjure.str("update")]
    ),
    conjure.b.templateLiteral(
      [
        conjure.b.templateElement({ raw: "/", cooked: "/" }, false),
        conjure.b.templateElement({ raw: "", cooked: "" }, true),
      ],
      [idParam]
    )
  );
  const updateEndpointWithPayload = conjure.b.callExpression(
    conjure.b.memberExpression(updateEndpointBase, conjure.b.identifier("setPayload")),
    [conjure.b.memberExpression(conjure.b.identifier(className), conjure.b.identifier("jsonUpdate"))]
  );
  const updateEndpointWithSuccess = conjure.b.callExpression(
    conjure.b.memberExpression(updateEndpointWithPayload, conjure.b.identifier("addSuccess")),
    [conjure.b.memberExpression(conjure.b.identifier(className), conjure.b.identifier("json"))]
  );
  const updateEndpoint = conjure.b.callExpression(
    conjure.b.memberExpression(updateEndpointWithSuccess, conjure.b.identifier("addError")),
    [conjure.b.identifier(errorName), obj().prop("status", conjure.b.literal(404)).build()]
  );

  // DELETE /:id - delete endpoint
  const deleteEndpointBase = conjure.b.taggedTemplateExpression(
    conjure.b.callExpression(
      conjure.b.memberExpression(
        conjure.b.identifier("HttpApiEndpoint"),
        conjure.b.identifier("del")
      ),
      [conjure.str("delete")]
    ),
    conjure.b.templateLiteral(
      [
        conjure.b.templateElement({ raw: "/", cooked: "/" }, false),
        conjure.b.templateElement({ raw: "", cooked: "" }, true),
      ],
      [idParam]
    )
  );
  const deleteEndpoint = conjure.b.callExpression(
    conjure.b.memberExpression(deleteEndpointBase, conjure.b.identifier("addError")),
    [conjure.b.identifier(errorName), obj().prop("status", conjure.b.literal(404)).build()]
  );

  // Build: HttpApiGroup.make("name").prefix("/path").add(...).add(...)
  let groupExpr: ExpressionKind = conjure.b.callExpression(
    conjure.b.memberExpression(
      conjure.b.identifier("HttpApiGroup"),
      conjure.b.identifier("make")
    ),
    [conjure.str(pluralPath)]
  );
  groupExpr = conjure.b.callExpression(
    conjure.b.memberExpression(groupExpr, conjure.b.identifier("prefix")),
    [conjure.str(fullPath)]
  );
  groupExpr = conjure.b.callExpression(
    conjure.b.memberExpression(groupExpr, conjure.b.identifier("add")),
    [listEndpoint]
  );
  groupExpr = conjure.b.callExpression(
    conjure.b.memberExpression(groupExpr, conjure.b.identifier("add")),
    [getEndpoint]
  );
  groupExpr = conjure.b.callExpression(
    conjure.b.memberExpression(groupExpr, conjure.b.identifier("add")),
    [createEndpoint]
  );
  groupExpr = conjure.b.callExpression(
    conjure.b.memberExpression(groupExpr, conjure.b.identifier("add")),
    [updateEndpoint]
  );
  groupExpr = conjure.b.callExpression(
    conjure.b.memberExpression(groupExpr, conjure.b.identifier("add")),
    [deleteEndpoint]
  );
  // Add InternalServerError for SQL errors
  groupExpr = conjure.b.callExpression(
    conjure.b.memberExpression(groupExpr, conjure.b.identifier("addError")),
    [
      conjure.b.memberExpression(
        conjure.b.identifier("HttpApiError"),
        conjure.b.identifier("InternalServerError")
      ),
    ]
  );

  return exp.const(groupName, { capability: "http", entity: entity.name }, groupExpr);
};

/**
 * Generate HTTP API files for each entity
 * Each file contains: NotFoundError, ApiGroup, and Handlers
 */
const generateHttpApi = (
  ctx: PluginContext,
  config: ParsedEffectConfig,
  entities: readonly ApiEntityInfo[]
): void => {
  const httpConfig = config.http;
  if (httpConfig === false || !httpConfig.enabled) return;
  if (entities.length === 0) return;

  const basePath = httpConfig.basePath;
  const outputDir = normalizeOutputDir(config.outputDir);
  const apiDir = httpConfig.outputDir;

  const buildApiPath = (entityName: string): string =>
    buildPath(outputDir, apiDir, entityName);

  for (const info of entities) {
    const idSchemaType = getPrimaryKeySchemaType(info.entity);
    const filePath = buildApiPath(info.className);

    const statements: SymbolStatement[] = [
      generateNotFoundError(info.className, idSchemaType),
      generateApiGroup(info.entity, info.className, basePath, idSchemaType),
      generateEntityHandlers(info),
    ];

    ctx
      .file(filePath)
      // API group imports
      .import({
        kind: "package",
        names: ["HttpApiBuilder", "HttpApiEndpoint", "HttpApiError", "HttpApiGroup", "HttpApiSchema"],
        from: "@effect/platform",
      })
      // Handler imports
      .import({ kind: "package", names: ["Model", "SqlClient"], from: "@effect/sql" })
      .import({ kind: "package", names: ["DateTime", "Effect", "Option", "Schema", "Schema as S"], from: "effect" })
      // Model and Repo
      .import({
        kind: "symbol",
        ref: { capability: "models", entity: info.entity.name },
      })
      .import({
        kind: "symbol",
        ref: { capability: "queries", entity: info.entity.name },
      })
      // Combined Api class
      .import({
        kind: "relative",
        names: ["Api"],
        from: "./Api.js",
      })
      .ast(conjure.symbolProgram(...statements))
      .emit();
  }
};

// ============================================================================
// HTTP API Index Generation (Phase 3B)
// ============================================================================

/**
 * Create a shorthand property for object patterns: { id } instead of { id: id }
 */
const shorthandProp = (name: string): n.Property => {
  const prop = conjure.b.property("init", conjure.b.identifier(name), conjure.b.identifier(name));
  prop.shorthand = true;
  return prop;
};

/**
 * Metadata for an entity that has HTTP API generation enabled
 */
interface ApiEntityInfo {
  readonly entity: TableEntity;
  readonly className: string;
  readonly groupName: string;
  readonly errorName: string;
  readonly repoName: string;
  readonly pluralName: string;
  readonly idColumn: string;
  /** Fields needing Model.Override(DateTime.unsafeNow()) on insert */
  readonly insertTimestampFields: readonly string[];
  /** Fields needing Model.Override(DateTime.unsafeNow()) on update */
  readonly updateTimestampFields: readonly string[];
}

/**
 * Collect entities eligible for HTTP API generation
 */
const collectApiEntities = (
  ir: PluginContext["ir"],
  inflection: PluginContext["inflection"]
): readonly ApiEntityInfo[] =>
  getTableEntities(ir)
    .filter((entity) => entity.tags.omit !== true)
    .filter((entity) => entity.kind === "table")
    .filter((entity) => hasSingleColumnPrimaryKey(entity))
    .filter((entity) => !getEntityHttpConfig(entity).skip)
    .map((entity) => {
      const className = inflection.entityName(entity.pgClass, entity.tags);
      const kebabName = entity.pgName.replace(/_/g, "-");
      const pluralName = inflect.pluralize(kebabName);
      const idColumn = getPrimaryKeyColumn(entity)!;

      // Find timestamp fields that need Model.Override(DateTime.unsafeNow())
      const insertTimestampFields: string[] = [];
      const updateTimestampFields: string[] = [];
      for (const field of entity.shapes.row.fields) {
        const autoTs = getAutoTimestamp(field);
        if (autoTs === "insert") {
          // created_at: needs timestamp on insert only
          insertTimestampFields.push(field.columnName);
        } else if (autoTs === "update") {
          // updated_at: needs timestamp on both insert and update
          insertTimestampFields.push(field.columnName);
          updateTimestampFields.push(field.columnName);
        }
      }

      return {
        entity,
        className,
        groupName: `${className}Api`,
        errorName: `${className}NotFound`,
        repoName: `${className}Repo`,
        pluralName,
        idColumn,
        insertTimestampFields,
        updateTimestampFields,
      };
    });

/**
 * Generate: export class Api extends HttpApi.make("api").add(Group1).add(Group2)... {}
 */
const generateCombinedApiClass = (entities: readonly ApiEntityInfo[]): SymbolStatement => {
  // Build: HttpApi.make("api").add(Group1).add(Group2)...
  let apiExpr: ExpressionKind = conjure.b.callExpression(
    conjure.b.memberExpression(
      conjure.b.identifier("HttpApi"),
      conjure.b.identifier("make")
    ),
    [conjure.str("api")]
  );

  for (const info of entities) {
    apiExpr = conjure.b.callExpression(
      conjure.b.memberExpression(apiExpr, conjure.b.identifier("add")),
      [conjure.b.identifier(info.groupName)]
    );
  }

  const classDecl = conjure.b.classDeclaration(
    conjure.b.identifier("Api"),
    conjure.b.classBody([]),
    apiExpr
  );

  return {
    _tag: "SymbolStatement",
    node: conjure.b.exportNamedDeclaration(classDecl, []),
    symbol: {
      name: "Api",
      capability: "http",
      entity: "Api",
      isType: false,
    },
  };
};

/**
 * Generate api/Api.ts with the combined Api class
 */
const generateHttpApiClass = (
  ctx: PluginContext,
  config: ParsedEffectConfig,
  entities: readonly ApiEntityInfo[]
): void => {
  if (entities.length === 0) return;
  const httpConfig = config.http;
  if (httpConfig === false || !httpConfig.enabled) return;

  const outputDir = normalizeOutputDir(config.outputDir);
  const apiDir = httpConfig.outputDir;
  const filePath = buildPath(outputDir, apiDir, "Api");

  const statements: SymbolStatement[] = [generateCombinedApiClass(entities)];

  const fileBuilder = ctx
    .file(filePath)
    .import({ kind: "package", names: ["HttpApi"], from: "@effect/platform" });

  // Import each entity's API group
  for (const info of entities) {
    fileBuilder.import({
      kind: "relative",
      names: [info.groupName],
      from: `./${info.className}.js`,
    });
  }

  fileBuilder.ast(conjure.symbolProgram(...statements)).emit();
};

/**
 * Build: Effect.catchTag("SqlError", () => Effect.fail(new HttpApiError.InternalServerError()))
 */
const buildSqlErrorCatch = (): ExpressionKind =>
  conjure.b.callExpression(
    conjure.b.memberExpression(
      conjure.b.identifier("Effect"),
      conjure.b.identifier("catchTag")
    ),
    [
      conjure.str("SqlError"),
      conjure.b.arrowFunctionExpression(
        [],
        conjure.b.callExpression(
          conjure.b.memberExpression(
            conjure.b.identifier("Effect"),
            conjure.b.identifier("fail")
          ),
          [
            conjure.b.newExpression(
              conjure.b.memberExpression(
                conjure.b.identifier("HttpApiError"),
                conjure.b.identifier("InternalServerError")
              ),
              []
            ),
          ]
        )
      ),
    ]
  );

/**
 * Build: expr.pipe(arg1, arg2, ...)
 */
const buildPipe = (expr: ExpressionKind, ...args: ExpressionKind[]): ExpressionKind =>
  conjure.b.callExpression(
    conjure.b.memberExpression(expr, conjure.b.identifier("pipe")),
    args
  );

/**
 * Generate handler for a single entity:
 * export const {Entity}Handlers = HttpApiBuilder.group(Api, "pluralName", (handlers) =>
 *   Effect.gen(function* () {
 *     const sql = yield* SqlClient;
 *     const repo = yield* {Entity}Repo;
 *     return handlers
 *       .handle("list", () => sql`SELECT * FROM table`)
 *       .handle("get", ({ path: { id } }) => ...)
 *       ...
 *   })
 * );
 */
const generateEntityHandlers = (info: ApiEntityInfo): SymbolStatement => {
  const handlersName = `${info.className}Handlers`;
  const qualifiedTable = `${info.entity.schemaName}.${info.entity.pgName}`;

  // Build Effect.gen body
  // const sql = yield* SqlClient;
  const sqlDecl = conjure.b.variableDeclaration("const", [
    conjure.b.variableDeclarator(
      conjure.b.identifier("sql"),
      conjure.b.yieldExpression(
        conjure.b.memberExpression(
          conjure.b.identifier("SqlClient"),
          conjure.b.identifier("SqlClient")
        ),
        true
      )
    ),
  ]);

  // const repo = yield* {Entity}Repo;
  const repoDecl = conjure.b.variableDeclaration("const", [
    conjure.b.variableDeclarator(
      conjure.b.identifier("repo"),
      conjure.b.yieldExpression(
        conjure.b.identifier(info.repoName),
        true // delegate (yield*)
      )
    ),
  ]);

  // Build handlers chain: handlers.handle("list", ...).handle("get", ...)...
  // Start with handlers reference
  let handlersChain: ExpressionKind = conjure.b.identifier("handlers");

  // .handle("list", () => sql`SELECT * FROM table`.pipe(
  //   Effect.flatMap(Schema.decodeUnknown(Schema.Array(Model))),
  //   Effect.catchAll(() => Effect.fail(new HttpApiError.InternalServerError()))
  // ))
  const listQuery = conjure.b.taggedTemplateExpression(
    conjure.b.identifier("sql"),
    conjure.b.templateLiteral(
      [conjure.b.templateElement({ raw: `SELECT * FROM ${qualifiedTable}`, cooked: `SELECT * FROM ${qualifiedTable}` }, true)],
      []
    )
  );
  // Schema.decodeUnknown(Schema.Array(Model))
  const decodeArray = conjure.b.callExpression(
    conjure.b.memberExpression(conjure.b.identifier("Schema"), conjure.b.identifier("decodeUnknown")),
    [
      conjure.b.callExpression(
        conjure.b.memberExpression(conjure.b.identifier("Schema"), conjure.b.identifier("Array")),
        [conjure.b.identifier(info.className)]
      ),
    ]
  );
  // Effect.flatMap(decodeArray)
  const flatMapDecode = conjure.b.callExpression(
    conjure.b.memberExpression(conjure.b.identifier("Effect"), conjure.b.identifier("flatMap")),
    [decodeArray]
  );
  // Effect.catchAll(() => Effect.fail(new HttpApiError.InternalServerError()))
  const catchAll = conjure.b.callExpression(
    conjure.b.memberExpression(conjure.b.identifier("Effect"), conjure.b.identifier("catchAll")),
    [
      conjure.b.arrowFunctionExpression(
        [],
        conjure.b.callExpression(
          conjure.b.memberExpression(conjure.b.identifier("Effect"), conjure.b.identifier("fail")),
          [
            conjure.b.newExpression(
              conjure.b.memberExpression(conjure.b.identifier("HttpApiError"), conjure.b.identifier("InternalServerError")),
              []
            ),
          ]
        )
      ),
    ]
  );
  const listQueryWithErrorHandling = buildPipe(listQuery, flatMapDecode, catchAll);
  handlersChain = conjure.b.callExpression(
    conjure.b.memberExpression(handlersChain, conjure.b.identifier("handle")),
    [
      conjure.str("list"),
      conjure.b.arrowFunctionExpression([], listQueryWithErrorHandling),
    ]
  );

  // .handle("get", ({ path: { id } }) => repo.findById(id).pipe(Effect.flatMap(Option.match(...))))
  const getHandler = conjure.b.arrowFunctionExpression(
    [
      conjure.b.objectPattern([
        conjure.b.property(
          "init",
          conjure.b.identifier("path"),
          conjure.b.objectPattern([shorthandProp("id")])
        ),
      ]),
    ],
    // repo.findById(id).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.fail(new Error({ id })), onSome: Effect.succeed })))
    conjure.b.callExpression(
      conjure.b.memberExpression(
        conjure.b.callExpression(
          conjure.b.memberExpression(
            conjure.b.identifier("repo"),
            conjure.b.identifier("findById")
          ),
          [conjure.b.identifier("id")]
        ),
        conjure.b.identifier("pipe")
      ),
      [
        conjure.b.callExpression(
          conjure.b.memberExpression(
            conjure.b.identifier("Effect"),
            conjure.b.identifier("flatMap")
          ),
          [
            conjure.b.callExpression(
              conjure.b.memberExpression(
                conjure.b.identifier("Option"),
                conjure.b.identifier("match")
              ),
              [
                obj()
                  .prop(
                    "onNone",
                    conjure.b.arrowFunctionExpression(
                      [],
                      conjure.b.callExpression(
                        conjure.b.memberExpression(
                          conjure.b.identifier("Effect"),
                          conjure.b.identifier("fail")
                        ),
                        [
                          conjure.b.newExpression(conjure.b.identifier(info.errorName), [
                            obj().prop("id", conjure.b.identifier("id")).build(),
                          ]),
                        ]
                      )
                    )
                  )
                  .prop("onSome", conjure.b.identifier("Effect.succeed"))
                  .build(),
              ]
            ),
          ]
        ),
      ]
    )
  );
  handlersChain = conjure.b.callExpression(
    conjure.b.memberExpression(handlersChain, conjure.b.identifier("handle")),
    [conjure.str("get"), getHandler]
  );

  // .handle("create", ({ payload }) => repo.insert({ ...payload, created_at: Model.Override(DateTime.unsafeNow()), ... }))
  // Build timestamp properties for insert: Model.Override(DateTime.unsafeNow())
  const timestampNow = conjure.b.callExpression(
    conjure.b.memberExpression(conjure.b.identifier("Model"), conjure.b.identifier("Override")),
    [
      conjure.b.callExpression(
        conjure.b.memberExpression(conjure.b.identifier("DateTime"), conjure.b.identifier("unsafeNow")),
        []
      ),
    ]
  );

  const insertTimestampProps = info.insertTimestampFields.map((fieldName) =>
    conjure.b.property("init", conjure.b.identifier(fieldName), timestampNow)
  );

  // Build insert argument: { ...payload, created_at: ..., updated_at: ... } or just payload if no timestamps
  const insertArg =
    insertTimestampProps.length > 0
      ? conjure.b.objectExpression([
          conjure.b.spreadProperty(conjure.b.identifier("payload")),
          ...insertTimestampProps,
        ])
      : conjure.b.identifier("payload");

  const createHandler = conjure.b.arrowFunctionExpression(
    [
      conjure.b.objectPattern([shorthandProp("payload")]),
    ],
    conjure.b.callExpression(
      conjure.b.memberExpression(conjure.b.identifier("repo"), conjure.b.identifier("insert")),
      [insertArg]
    )
  );
  handlersChain = conjure.b.callExpression(
    conjure.b.memberExpression(handlersChain, conjure.b.identifier("handle")),
    [conjure.str("create"), createHandler]
  );

  // .handle("update", ({ path: { id }, payload }) =>
  //   sql`UPDATE table SET ${sql.update({...payload, updated_at}, ["id"])} WHERE id = ${id} RETURNING *`.pipe(
  //     Effect.flatMap(Effect.head),
  //     Effect.flatMap(Option.match({ onNone: () => Effect.fail(NotFound), onSome: Schema.decodeUnknown(Model) })),
  //     Effect.catchTags({ ParseError: () => InternalServerError, SqlError: () => InternalServerError })
  //   )
  // )

  // Build update payload object: { ...payload, updated_at: DateTime.unsafeNow() }
  const updateTimestampProps = info.updateTimestampFields.map((fieldName) =>
    conjure.b.property(
      "init",
      conjure.b.identifier(fieldName),
      conjure.b.callExpression(
        conjure.b.memberExpression(conjure.b.identifier("DateTime"), conjure.b.identifier("unsafeNow")),
        []
      )
    )
  );
  const updatePayloadObj = conjure.b.objectExpression([
    conjure.b.spreadProperty(conjure.b.identifier("payload")),
    ...updateTimestampProps,
  ]);

  // sql.update(payload) - builds SET clause from payload object
  const sqlUpdateCall = conjure.b.callExpression(
    conjure.b.memberExpression(conjure.b.identifier("sql"), conjure.b.identifier("update")),
    [updatePayloadObj]
  );

  // Build template: sql`UPDATE table SET ${sql.update(...)} WHERE id = ${id} RETURNING *`
  const updateQuery = conjure.b.taggedTemplateExpression(
    conjure.b.identifier("sql"),
    conjure.b.templateLiteral(
      [
        conjure.b.templateElement({ raw: `UPDATE ${qualifiedTable} SET `, cooked: `UPDATE ${qualifiedTable} SET ` }, false),
        conjure.b.templateElement({ raw: ` WHERE ${info.idColumn} = `, cooked: ` WHERE ${info.idColumn} = ` }, false),
        conjure.b.templateElement({ raw: " RETURNING *", cooked: " RETURNING *" }, true),
      ],
      [sqlUpdateCall, conjure.b.identifier("id")]
    )
  );

  // Effect.head
  const effectHead = conjure.b.memberExpression(conjure.b.identifier("Effect"), conjure.b.identifier("head"));

  // Effect.flatMap(Schema.decodeUnknown(Model))
  const updateFlatMapDecode = conjure.b.callExpression(
    conjure.b.memberExpression(conjure.b.identifier("Effect"), conjure.b.identifier("flatMap")),
    [
      conjure.b.callExpression(
        conjure.b.memberExpression(conjure.b.identifier("Schema"), conjure.b.identifier("decodeUnknown")),
        [conjure.b.identifier(info.className)]
      ),
    ]
  );

  // Effect.catchTag("NoSuchElementException", () => Effect.fail(new NotFound({ id })))
  const catchNotFound = conjure.b.callExpression(
    conjure.b.memberExpression(conjure.b.identifier("Effect"), conjure.b.identifier("catchTag")),
    [
      conjure.str("NoSuchElementException"),
      conjure.b.arrowFunctionExpression(
        [],
        conjure.b.callExpression(
          conjure.b.memberExpression(conjure.b.identifier("Effect"), conjure.b.identifier("fail")),
          [
            conjure.b.newExpression(conjure.b.identifier(info.errorName), [
              obj().prop("id", conjure.b.identifier("id")).build(),
            ]),
          ]
        )
      ),
    ]
  );

  // Effect.catchTags({ ParseError: () => ..., SqlError: () => ... })
  const internalServerErrorFn = conjure.b.arrowFunctionExpression(
    [],
    conjure.b.callExpression(
      conjure.b.memberExpression(conjure.b.identifier("Effect"), conjure.b.identifier("fail")),
      [
        conjure.b.newExpression(
          conjure.b.memberExpression(conjure.b.identifier("HttpApiError"), conjure.b.identifier("InternalServerError")),
          []
        ),
      ]
    )
  );
  const catchTags = conjure.b.callExpression(
    conjure.b.memberExpression(conjure.b.identifier("Effect"), conjure.b.identifier("catchTags")),
    [
      obj()
        .prop("ParseError", internalServerErrorFn)
        .prop("SqlError", internalServerErrorFn)
        .build(),
    ]
  );

  // Full update pipeline
  const updateQueryWithPipe = buildPipe(
    updateQuery,
    effectHead,
    updateFlatMapDecode,
    catchNotFound,
    catchTags
  );

  const updateHandler = conjure.b.arrowFunctionExpression(
    [
      conjure.b.objectPattern([
        conjure.b.property(
          "init",
          conjure.b.identifier("path"),
          conjure.b.objectPattern([shorthandProp("id")])
        ),
        shorthandProp("payload"),
      ]),
    ],
    updateQueryWithPipe
  );
  handlersChain = conjure.b.callExpression(
    conjure.b.memberExpression(handlersChain, conjure.b.identifier("handle")),
    [conjure.str("update"), updateHandler]
  );

  // .handle("delete", ({ path: { id } }) => repo.delete(id))
  // delete returns void directly, no Option matching needed
  const deleteHandler = conjure.b.arrowFunctionExpression(
    [
      conjure.b.objectPattern([
        conjure.b.property(
          "init",
          conjure.b.identifier("path"),
          conjure.b.objectPattern([shorthandProp("id")])
        ),
      ]),
    ],
    conjure.b.callExpression(
      conjure.b.memberExpression(conjure.b.identifier("repo"), conjure.b.identifier("delete")),
      [conjure.b.identifier("id")]
    )
  );
  handlersChain = conjure.b.callExpression(
    conjure.b.memberExpression(handlersChain, conjure.b.identifier("handle")),
    [conjure.str("delete"), deleteHandler]
  );

  // return handlers chain
  const returnStmt = conjure.b.returnStatement(handlersChain);

  // Build the generator function body
  const genBody = conjure.b.blockStatement([sqlDecl, repoDecl, returnStmt]);

  // Build: function* () { ... }
  const genFunc = conjure.b.functionExpression(null, [], genBody);
  genFunc.generator = true;

  // Build: Effect.gen(function* () { ... })
  const effectGen = conjure.b.callExpression(
    conjure.b.memberExpression(conjure.b.identifier("Effect"), conjure.b.identifier("gen")),
    [genFunc]
  );

  // Build: (handlers) => Effect.gen(...)
  const handlersCallback = conjure.b.arrowFunctionExpression(
    [conjure.b.identifier("handlers")],
    effectGen
  );

  // Build: HttpApiBuilder.group(Api, "pluralName", callback)
  const groupCall = conjure.b.callExpression(
    conjure.b.memberExpression(conjure.b.identifier("HttpApiBuilder"), conjure.b.identifier("group")),
    [conjure.b.identifier("Api"), conjure.str(info.pluralName), handlersCallback]
  );

  return exp.const(handlersName, { capability: "http", entity: info.entity.name }, groupCall);
};

/**
 * Generate: export const ApiLive = HttpApiBuilder.api(Api).pipe(Layer.provide(...), ...)
 */
const generateApiLive = (entities: readonly ApiEntityInfo[]): SymbolStatement => {
  // Build: HttpApiBuilder.api(Api)
  let apiExpr: ExpressionKind = conjure.b.callExpression(
    conjure.b.memberExpression(conjure.b.identifier("HttpApiBuilder"), conjure.b.identifier("api")),
    [conjure.b.identifier("Api")]
  );

  // Chain .pipe(Layer.provide(Handler1), Layer.provide(Handler2), ...)
  if (entities.length > 0) {
    const pipeArgs = entities.map((info) =>
      conjure.b.callExpression(
        conjure.b.memberExpression(conjure.b.identifier("Layer"), conjure.b.identifier("provide")),
        [conjure.b.identifier(`${info.className}Handlers`)]
      )
    );

    apiExpr = conjure.b.callExpression(
      conjure.b.memberExpression(apiExpr, conjure.b.identifier("pipe")),
      pipeArgs
    );
  }

  return exp.const("ApiLive", { capability: "http", entity: "Api" }, apiExpr);
};

/**
 * Generate api/index.ts with just ApiLive composition
 */
const generateHttpApiIndex = (
  ctx: PluginContext,
  config: ParsedEffectConfig,
  entities: readonly ApiEntityInfo[]
): void => {
  if (entities.length === 0) return;
  const httpConfig = config.http;
  if (httpConfig === false || !httpConfig.enabled) return;

  const outputDir = normalizeOutputDir(config.outputDir);
  const apiDir = httpConfig.outputDir;
  const filePath = buildPath(outputDir, apiDir, "index");

  const statements: SymbolStatement[] = [generateApiLive(entities)];

  const fileBuilder = ctx
    .file(filePath)
    .import({ kind: "package", names: ["HttpApiBuilder"], from: "@effect/platform" })
    .import({ kind: "package", names: ["Layer"], from: "effect" })
    .import({ kind: "relative", names: ["Api"], from: "./Api.js" });

  // Import each entity's handlers
  for (const info of entities) {
    fileBuilder.import({
      kind: "relative",
      names: [`${info.className}Handlers`],
      from: `./${info.className}.js`,
    });
  }

  fileBuilder.ast(conjure.symbolProgram(...statements)).emit();
};

// ============================================================================
// Plugin Definition
// ============================================================================

/**
 * Effect Plugin
 *
 * Generates @effect/sql Model classes, repositories, and HTTP APIs.
 *
 * @example
 * ```typescript
 * import { effect } from "pg-sourcerer"
 *
 * export default defineConfig({
 *   plugins: [
 *     effect(),
 *     effect({
 *       outputDir: "generated/effect",
 *       queryMode: "resolvers",
 *       http: { basePath: "/api/v1" },
 *     }),
 *   ],
 * })
 * ```
 */
export function effect(config: EffectConfig = {}): ReturnType<typeof definePlugin> {
  const parsed = S.decodeUnknownSync(EffectConfigSchema)(config);

  return definePlugin({
    name: "effect",
    kind: "effect",
    singleton: true,

    canProvide: () => true,

    provide: (_params: unknown, _deps: readonly unknown[], ctx: PluginContext) => {
      // Phase 1: Generate Model classes
      generateModels(ctx, parsed);

      // Phase 2: Generate Repositories (if not disabled)
      generateRepositories(ctx, parsed);

      // Phase 3: Generate HTTP API (if enabled)
      const httpConfig = parsed.http;
      if (httpConfig !== false && httpConfig.enabled) {
        const entities = collectApiEntities(ctx.ir, ctx.inflection);
        if (entities.length > 0) {
          // Phase 3A: Generate api/Api.ts with combined Api class
          generateHttpApiClass(ctx, parsed, entities);
          // Phase 3B: Generate per-entity API groups + handlers
          generateHttpApi(ctx, parsed, entities);
          // Phase 3C: Generate api/index.ts with ApiLive
          generateHttpApiIndex(ctx, parsed, entities);
        }
      }

      return undefined;
    },
  });
}

/**
 * @deprecated Use `effect()` instead. This alias is provided for backward compatibility.
 */
export const effectPlugin = effect;

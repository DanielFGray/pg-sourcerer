/**
 * Shared utilities for Effect plugin suite
 */
import { Schema as S } from "effect";
import type { namedTypes as n } from "ast-types";
import type { ExpressionKind } from "ast-types/lib/gen/kinds.js";

import type { TableEntity, Field, EnumEntity } from "../../ir/semantic-ir.js";
import { conjure } from "../../conjure/index.js";
import type { FileNaming } from "../../runtime/file-assignment.js";
import type { UserModuleRef } from "../../user-module.js";

// =============================================================================
// Configuration
// =============================================================================

/**
 * HTTP API configuration schema (for Schema validation - simple types only)
 */
export const HttpConfigSchema = S.Struct({
  /** Enable HTTP API generation. Default: true */
  enabled: S.optionalWith(S.Boolean, { default: () => true }),
  /** Base path for all routes. Default: "/api" */
  basePath: S.optionalWith(S.String, { default: () => "/api" }),
});

export type ParsedHttpConfig = S.Schema.Type<typeof HttpConfigSchema> & {
  /** Output file for server aggregator. Resolved separately. */
  serverFile: FileNaming;
  /** User module providing the SqlClient layer. */
  sqlClientLayer?: UserModuleRef;
};

export const EffectConfigSchema = S.Struct({
  /** Export inferred TypeScript types alongside schemas. Default: true */
  exportTypes: S.optionalWith(S.Boolean, { default: () => true }),
  /** Generate Model.makeRepository for tables with single-column PKs. Default: true */
  repos: S.optionalWith(S.Boolean, { default: () => true }),
  /** HTTP API generation config. Set to false to disable. Default: enabled */
  http: S.optionalWith(
    S.Union(S.Literal(false), HttpConfigSchema),
    { default: () => ({ enabled: true, basePath: "/api" }) },
  ),
});

export type ParsedEffectConfig = Omit<S.Schema.Type<typeof EffectConfigSchema>, "http"> & {
  http: false | ParsedHttpConfig;
};

/**
 * HTTP API configuration
 */
export interface HttpConfig {
  /** Enable HTTP API generation. Default: true */
  enabled?: boolean;
  /** Base path for all routes. Default: "/api" */
  basePath?: string;
  /**
   * Output file for the server aggregator (ServerLive layer).
   * Can be a static string or a function receiving FileNamingContext.
   * @default "server.ts" (in root output dir)
   * @example "api/server.ts" - server in api subfolder
   * @example ({ folderName }) => `${folderName}/server.ts` - dynamic path
   */
  serverFile?: string | FileNaming;
  /**
   * User module providing the SqlClient layer for database access.
   * Use userModule() helper to specify the path relative to your config file.
   *
   * @example
   * ```typescript
   * import { effect, userModule } from "pg-sourcerer";
   *
   * effect({
   *   http: {
   *     sqlClientLayer: userModule("./db.ts", { named: ["SqlLive"] }),
   *   },
   * })
   * ```
   *
   * The imported layer will be provided to ServerLive:
   * ```typescript
   * export const ServerLive = HttpApiBuilder.serve().pipe(
   *   Layer.provide([...ApiLive layers...]),
   *   Layer.provide(SqlLive),  // <-- Your layer
   *   HttpServer.withLogAddress,
   * )
   * ```
   */
  sqlClientLayer?: UserModuleRef;
}

/**
 * Configuration for the Effect plugin.
 */
export interface EffectConfig {
  /** Export inferred TypeScript types alongside schemas. Default: true */
  exportTypes?: boolean;
  /** Generate Model.makeRepository for tables with single-column PKs. Default: true */
  repos?: boolean;
  /** HTTP API generation config. Set to false to disable. */
  http?: false | HttpConfig;
}

// =============================================================================
// PostgreSQL Type Sets
// =============================================================================

export const PG_STRING_TYPES = new Set([
  "uuid",
  "text",
  "varchar",
  "char",
  "character",
  "name",
  "bpchar",
  "citext",
]);

export const PG_NUMBER_TYPES = new Set([
  "int2",
  "int4",
  "int8",
  "integer",
  "smallint",
  "bigint",
  "numeric",
  "decimal",
  "real",
  "float4",
  "float8",
  "double",
]);

export const PG_BOOLEAN_TYPES = new Set(["bool", "boolean"]);

export const PG_DATE_TYPES = new Set(["timestamp", "timestamptz", "date", "time", "timetz"]);

export const PG_JSON_TYPES = new Set(["json", "jsonb"]);

// =============================================================================
// Type Mapping
// =============================================================================

export type EffectMapping =
  | { kind: "schema"; schema: n.Expression; enumRef?: undefined }
  | { kind: "enumRef"; enumRef: string; schema?: undefined };

export function fieldToEffectMapping(field: Field, enums: EnumEntity[]): EffectMapping {
  const pgType = field.pgAttribute.getType();

  if (!pgType) {
    return { kind: "schema", schema: conjure.id("S").prop("Unknown").build() };
  }

  let typeName: string;
  let typeInfo: { typcategory?: string | null; typtype?: string | null };

  if (pgType.typcategory === "A") {
    typeName = field.elementTypeName ?? "unknown";
    typeInfo = pgType;
  } else if (pgType.typtype === "d" && field.domainBaseType) {
    typeName = field.domainBaseType.typeName;
    typeInfo = { typcategory: field.domainBaseType.category };
  } else {
    typeName = pgType.typname;
    typeInfo = pgType;
  }

  const baseResult = baseTypeToEffectMapping(typeName, typeInfo, enums);

  if (baseResult.kind === "enumRef") {
    return baseResult;
  }

  let schema = baseResult.schema;

  // S.Array(elementType) - static method, not chained
  if (field.isArray) {
    schema = conjure.id("S").method("Array", [schema]).build();
  }

  if (field.nullable) {
    schema = conjure.id("S").method("NullOr", [schema]).build();
  }

  return { kind: "schema", schema };
}

function baseTypeToEffectMapping(
  typeName: string,
  pgType: { typcategory?: string | null; typtype?: string | null },
  enums: EnumEntity[],
): EffectMapping {
  const normalized = typeName.toLowerCase();

  if (PG_STRING_TYPES.has(normalized)) {
    if (normalized === "uuid") {
      return { kind: "schema", schema: conjure.id("S").prop("UUID").build() };
    }
    return { kind: "schema", schema: conjure.id("S").prop("String").build() };
  }

  if (PG_NUMBER_TYPES.has(normalized)) {
    if (normalized === "bigint" || normalized === "int8") {
      return { kind: "schema", schema: conjure.id("S").prop("BigInt").build() };
    }
    return { kind: "schema", schema: conjure.id("S").prop("Number").build() };
  }

  if (PG_BOOLEAN_TYPES.has(normalized)) {
    return { kind: "schema", schema: conjure.id("S").prop("Boolean").build() };
  }

  if (PG_DATE_TYPES.has(normalized)) {
    return { kind: "schema", schema: conjure.id("S").prop("DateFromSelf").build() };
  }

  if (PG_JSON_TYPES.has(normalized)) {
    return { kind: "schema", schema: conjure.id("S").prop("Unknown").build() };
  }

  if (pgType.typtype === "e" || pgType.typcategory === "E") {
    const enumEntity = enums.find(e => e.pgType.typname === typeName);
    if (enumEntity) {
      return { kind: "enumRef", enumRef: enumEntity.name };
    }
    return { kind: "schema", schema: conjure.id("S").prop("Unknown").build() };
  }

  return { kind: "schema", schema: conjure.id("S").prop("Unknown").build() };
}

// =============================================================================
// Entity Helpers
// =============================================================================

/**
 * Check if entity has a single-column primary key (required for makeRepository)
 */
export function hasSingleColumnPrimaryKey(entity: TableEntity): boolean {
  return entity.primaryKey !== undefined && entity.primaryKey.columns.length === 1;
}

/**
 * Get the primary key column name
 */
export function getPrimaryKeyColumn(entity: TableEntity): string | undefined {
  return entity.primaryKey?.columns[0];
}

/**
 * Check if a field should be treated as DB-generated.
 * Includes GENERATED ALWAYS, IDENTITY, and PK fields with defaults.
 */
export function isDbGenerated(field: Field, entity: TableEntity): boolean {
  return (
    field.isGenerated ||
    field.isIdentity ||
    (field.hasDefault && entity.primaryKey?.columns.includes(field.columnName) === true)
  );
}

/**
 * Check for auto-timestamp patterns (created_at, updated_at)
 */
export function getAutoTimestamp(field: Field): "insert" | "update" | undefined {
  if (!field.hasDefault) return undefined;
  const name = field.columnName.toLowerCase();
  if (name === "created_at" || name === "createdat") return "insert";
  if (name === "updated_at" || name === "updatedat") return "update";
  return undefined;
}

// =============================================================================
// AST Helpers  
// =============================================================================

export function toExpr(node: n.Expression): ExpressionKind {
  return node as ExpressionKind;
}

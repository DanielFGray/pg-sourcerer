/**
 * Configuration schema for pg-sourcerer
 */
import { Schema as S } from "effect"
import type { InflectionConfig } from "./services/inflection.js"

/**
 * Type hint match criteria
 */
export const TypeHintMatch = S.Struct({
  schema: S.optional(S.String),
  table: S.optional(S.String),
  column: S.optional(S.String),
  pgType: S.optional(S.String),
})
export type TypeHintMatch = S.Schema.Type<typeof TypeHintMatch>

/**
 * Type hint - user-configured type override
 */
export const TypeHint = S.Struct({
  match: TypeHintMatch,
  hints: S.Record({ key: S.String, value: S.Unknown }),
})
export type TypeHint = S.Schema.Type<typeof TypeHint>

/**
 * Main configuration schema
 *
 * Note: `inflection` is typed as `InflectionConfig | undefined` but stored
 * as S.Any in the schema since functions can't be validated at runtime.
 */
export const Config = S.Struct({
  /** Database connection string */
  connectionString: S.String,

  /** PostgreSQL schemas to introspect */
  schemas: S.optionalWith(S.Array(S.String), { default: () => ["public"] }),

  /** Output directory root */
  outputDir: S.optionalWith(S.String, { default: () => "src/generated" }),

  /** Type hints for custom type mapping */
  typeHints: S.optionalWith(S.Array(TypeHint), { default: () => [] }),

  /**
   * Inflection configuration for customizing naming conventions.
   * Each property is a function that transforms names.
   *
   * @example
   * ```typescript
   * inflection: {
   *   // Skip singularization for entity names
   *   entityName: (tableName) => Str.snakeToPascal(tableName),
   *   // Keep column names as snake_case
   *   fieldName: (columnName) => columnName,
   * }
   * ```
   */
  inflection: S.optional(S.Any),

  /** Plugins to run (validated individually per plugin) */
  plugins: S.Array(S.Any),
})

export type Config = S.Schema.Type<typeof Config>

/**
 * Resolved configuration with all defaults applied
 */
export interface ResolvedConfig {
  readonly connectionString: string
  readonly schemas: readonly string[]
  readonly outputDir: string
  readonly typeHints: readonly TypeHint[]
  readonly inflection?: InflectionConfig
  readonly plugins: readonly unknown[]
}

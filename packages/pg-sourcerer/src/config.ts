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
 * Note: `inflection` and `plugins` are typed as S.Any in the schema since
 * they contain complex types that can't be fully validated at runtime.
 * Use `ConfigInput` for typed user-facing config and `ResolvedConfig` for
 * the fully resolved configuration.
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

  /** Inflection configuration (validated as Any, properly typed in ConfigInput) */
  inflection: S.optional(S.Any),

  /** Plugins to run (validated individually per plugin) */
  plugins: S.Array(S.Any),
})

export type Config = S.Schema.Type<typeof Config>

/**
 * User-facing configuration input type.
 * 
 * This provides proper TypeScript types for `inflection` and `plugins`
 * which are stored as `S.Any` in the schema for runtime flexibility.
 * Use this type for `defineConfig()` to give users proper autocomplete.
 */
export interface ConfigInput {
  /** Database connection string */
  readonly connectionString: string

  /** PostgreSQL schemas to introspect (default: ["public"]) */
  readonly schemas?: readonly string[]

  /** Output directory root (default: "src/generated") */
  readonly outputDir?: string

  /** Type hints for custom type mapping */
  readonly typeHints?: readonly TypeHint[]

  /**
   * Inflection configuration for customizing naming conventions.
   * Each property is a function that transforms a name.
   *
   * @example
   * ```typescript
   * import { inflect } from "pg-sourcerer"
   * 
   * inflection: {
   *   entityName: (name) => inflect.pascalCase(inflect.singularize(name)), // users → User
   *   fieldName: inflect.camelCase,                   // created_at → createdAt
   *   enumName: inflect.pascalCase,                   // user_status → UserStatus
   * }
   * ```
   */
  readonly inflection?: InflectionConfig

  /** Plugins to run */
  readonly plugins: readonly unknown[]
}

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

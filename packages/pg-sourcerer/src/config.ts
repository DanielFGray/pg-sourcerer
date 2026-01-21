/**
 * Configuration schema for pg-sourcerer
 */
import { Schema as S } from "effect";
import type { InflectionConfig } from "./services/inflection.js";
import type { Plugin } from "./runtime/types.js";

/**
 * Type hint match criteria
 */
export const TypeHintMatch = S.Struct({
  schema: S.optional(S.String),
  table: S.optional(S.String),
  column: S.optional(S.String),
  pgType: S.optional(S.String),
});
export type TypeHintMatch = S.Schema.Type<typeof TypeHintMatch>;

/**
 * Type hint - user-configured type override
 */
export const TypeHint = S.Struct({
  match: TypeHintMatch,
  hints: S.Record({ key: S.String, value: S.Unknown }),
});
export type TypeHint = S.Schema.Type<typeof TypeHint>;

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
  connectionString: S.propertySignature(
    S.String.annotations({
      message: () => "must be a string - set DATABASE_URL env var or add connectionString to config",
    }),
  ).annotations({
    missingMessage: () => "is required - set DATABASE_URL env var or add connectionString to config",
  }),

  /** PostgreSQL role to assume during introspection (for RLS-aware generation) */
  role: S.optional(S.String),

  /** PostgreSQL schemas to introspect */
  schemas: S.optionalWith(S.Array(S.String), { default: () => ["public"] }),

  /** Output directory root */
  outputDir: S.optionalWith(S.String, { default: () => "src/generated" }),

  /** Type hints for custom type mapping */
  typeHints: S.optionalWith(S.Array(TypeHint), { default: () => [] }),

  /** Inflection configuration (validated as Any, properly typed in ConfigInput) */
  inflection: S.optional(S.Any),

  /** Plugins to run */
  plugins: S.propertySignature(S.Array(S.Any)).annotations({
    missingMessage: () => "is required - add at least one plugin to your config",
  }),

  /** Formatter callback to transform generated code before writing (validated as Any, properly typed in ConfigInput) */
  formatter: S.optional(S.String),

  /**
   * Default file name for symbols that don't match any rule.
   * Relative to outputDir. Default: "index.ts"
   */
  defaultFile: S.optional(S.String),
});

export type Config = S.Schema.Type<typeof Config>;

/**
 * User-facing configuration input type.
 *
 * This provides proper TypeScript types for `inflection` and `plugins`
 * which are stored as `S.Any` in the schema for runtime flexibility.
 * Use this type for `defineConfig()` to give users proper autocomplete.
 */
export interface ConfigInput {
  /** Database connection string */
  readonly connectionString: string;

  /** PostgreSQL role to assume during introspection (for RLS-aware generation) */
  readonly role?: string;

  /** PostgreSQL schemas to introspect (default: ["public"]) */
  readonly schemas?: readonly string[];

  /** Output directory root (default: "src/generated") */
  readonly outputDir?: string;

  /** Type hints for custom type mapping */
  readonly typeHints?: readonly TypeHint[];

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
  readonly inflection?: InflectionConfig;

  /**
   * Plugins to run.
   *
   * Accepts individual plugins or arrays of plugins (presets).
   * Arrays are flattened at runtime, allowing plugin functions to return
   * multiple sub-plugins that work together.
   *
   * @example
   * ```typescript
   * plugins: [
   *   types(),           // Single plugin
   *   effect(),          // Preset returning multiple plugins
   *   [zod(), kysely()], // Explicit array
   * ]
   * ```
   */
  readonly plugins: readonly (Plugin | readonly Plugin[])[];

  /**
   * Formatter command to run on generated files after writing.
   * The command will be run with the output directory as the argument.
   * Errors will fail generation.
   *
   * @example
   * ```typescript
   * formatter: "prettier --write"
   * // or
   * formatter: "biome format --write"
   * ```
   */
  readonly formatter?: string;

  /**
   * Default file name for symbols that don't match any rule.
   * Relative to outputDir. Default: "index.ts"
   */
  readonly defaultFile?: string;
}

/**
 * Resolved configuration with all defaults applied
 */
export interface ResolvedConfig {
  readonly connectionString: string;
  readonly role?: string;
  readonly schemas: readonly string[];
  readonly outputDir: string;
  readonly typeHints: readonly TypeHint[];
  readonly inflection?: InflectionConfig;
  /** Plugins after flattening presets */
  readonly plugins: readonly Plugin[];
  readonly formatter?: string;
  readonly defaultFile?: string;
  /**
   * Directory containing the config file.
   * Used to resolve relative paths in userModule() references.
   */
  readonly configDir?: string;
}

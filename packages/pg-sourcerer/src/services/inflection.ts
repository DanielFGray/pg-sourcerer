/**
 * Core Inflection Service - naming transformations
 *
 * Provides configurable naming conventions for entities, fields, enums, etc.
 * Users configure with simple string→string functions that compose naturally.
 */
import { Context, Layer, String as Str } from "effect";
import pluralize from "pluralize-esm";
import type { PgAttribute, PgClass, PgProc, PgType } from "@danielfgray/pg-introspection";
import type { SmartTags, ShapeKind } from "../ir/index.js";

// ============================================================================
// Reserved Words
// ============================================================================

const RESERVED_WORDS = new Set([
  // TypeScript/JavaScript reserved
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "abstract",
  "as",
  "async",
  "await",
  "constructor",
  "declare",
  "get",
  "is",
  "module",
  "namespace",
  "never",
  "readonly",
  "require",
  "number",
  "object",
  "set",
  "string",
  "symbol",
  "type",
  "undefined",
  "unique",
  "unknown",
  "from",
  "global",
  "keyof",
  "of",
  "infer",
  "any",
  "boolean",
  "bigint",
]);

// ============================================================================
// Inflection Helper Functions
// ============================================================================

/**
 * Inflection helper functions for use in configuration.
 *
 * Users can compose these in their config:
 * @example
 * ```typescript
 * import { inflect } from "pg-sourcerer"
 *
 * const config = {
 *   inflection: {
 *     entityName: (name) => inflect.pascalCase(inflect.singularize(name)),
 *     fieldName: inflect.camelCase,
 *   }
 * }
 * ```
 */
export const inflect = {
  /** Convert snake_case to camelCase */
  camelCase: Str.snakeToCamel,
  /** Convert snake_case to PascalCase */
  pascalCase: Str.snakeToPascal,
  /** Convert camelCase to snake_case */
  snakeCase: Str.camelToSnake,
  /** Singularize a word (users → user) */
  singularize: pluralize.singular,
  /** Pluralize a word (user → users) */
  pluralize: pluralize.plural,
  /** Capitalize first letter */
  capitalize: Str.capitalize,
  /** Uncapitalize first letter */
  uncapitalize: Str.uncapitalize,
  /** Convert to lowercase */
  lowercase: (s: string) => s.toLowerCase(),
  /** Convert to uppercase */
  uppercase: (s: string) => s.toUpperCase(),
} as const;

// ============================================================================
// Core Inflection Interface
// ============================================================================

/**
 * Core inflection interface - shared naming transformations
 */
export interface CoreInflection {
  readonly camelCase: (text: string) => string;
  readonly pascalCase: (text: string) => string;
  readonly pluralize: (text: string) => string;
  readonly singularize: (text: string) => string;
  readonly safeIdentifier: (text: string) => string;
  readonly entityName: (pgClass: PgClass, tags: SmartTags) => string;
  readonly shapeName: (entityName: string, kind: ShapeKind) => string;
  readonly fieldName: (pgAttribute: PgAttribute, tags: SmartTags) => string;
  readonly enumName: (pgType: PgType, tags: SmartTags) => string;
  readonly enumValueName: (value: string) => string;
  readonly relationName: (name: string) => string;
  readonly functionName: (pgProc: PgProc, tags: SmartTags) => string;
}

/** Service tag */
export class Inflection extends Context.Tag("Inflection")<Inflection, CoreInflection>() {}

// ============================================================================
// Inflection Configuration
// ============================================================================

/**
 * A simple string→string transform function.
 */
export type TransformFn = (input: string) => string;

/**
 * Configuration for customizing inflection behavior.
 *
 * Each property is an optional function that transforms a name.
 * If undefined, the identity function is used (name preserved as-is).
 * Smart tags (@name) always take precedence over configured transforms.
 *
 * @example
 * ```typescript
 * import { inflect } from "pg-sourcerer"
 *
 * const config: InflectionConfig = {
 *   // users → User
 *   entityName: (name) => inflect.pascalCase(inflect.singularize(name)),
 *
 *   // created_at → createdAt
 *   fieldName: inflect.camelCase,
 *
 *   // user_status → UserStatus
 *   enumName: inflect.pascalCase,
 *
 *   // row → Row
 *   shapeSuffix: inflect.capitalize,
 * }
 * ```
 */
export interface InflectionConfig {
  /**
   * Singularize a word (users → user).
   * Default: pluralize-esm library
   */
  readonly singularize?: TransformFn;

  /**
   * Pluralize a word (user → users).
   * Default: pluralize-esm library
   */
  readonly pluralize?: TransformFn;

  /**
   * Transform table/view name → entity name.
   * Default: singularize + PascalCase
   */
  readonly entityName?: TransformFn;

  /**
   * Transform column name → field name.
   * Default: identity (preserve column name)
   */
  readonly fieldName?: TransformFn;

  /**
   * Transform PostgreSQL enum type name → TypeScript enum name.
   * Default: PascalCase
   */
  readonly enumName?: TransformFn;

  /**
   * Transform enum values.
   * Default: identity (preserve value)
   */
  readonly enumValue?: TransformFn;

  /**
   * Transform shape kind suffix.
   * Default: capitalize ("row", "insert", etc.)
   */
  readonly shapeSuffix?: TransformFn;

  /**
   * Transform relation names.
   * Default: camelCase
   */
  readonly relationName?: TransformFn;

  /**
   * Transform function name for IR identification.
   * Default: camelCase (overloads are warned and skipped)
   */
  readonly functionName?: TransformFn;
}

// ============================================================================
// Default Inflection Transforms
// ============================================================================

/**
 * Default inflection transforms - applies common JS/TS naming conventions:
 * - Entity names: singularize + PascalCase (users → User)
 * - Field names: identity (preserved as snake_case to match DB)
 * - Enum names: PascalCase (user_status → UserStatus)
 * - Shape suffixes: capitalize (row → Row)
 * - Relation names: camelCase
 *
 * Note: Field names are NOT transformed to camelCase by default because
 * the generated types would not match what the database actually returns.
 * If you use a Kysely plugin that transforms column names, you can override
 * fieldName in your config.
 */
export const defaultTransforms: InflectionConfig = {
  entityName: name => inflect.pascalCase(inflect.singularize(name)),
  // fieldName: identity (default) - preserves snake_case from database
  enumName: inflect.pascalCase,
  shapeSuffix: inflect.capitalize,
  relationName: inflect.camelCase,
  functionName: inflect.camelCase,
};

/**
 * Default inflection implementation using standard JS/TS naming conventions.
 */
export const defaultInflection: CoreInflection = {
  // Primitive transforms (always available)
  camelCase: inflect.camelCase,
  pascalCase: inflect.pascalCase,
  pluralize: inflect.pluralize,
  singularize: inflect.singularize,
  safeIdentifier: text => (RESERVED_WORDS.has(text) ? text + "_" : text),

  // Configurable transforms (default to JS/TS conventions)
  entityName: (pgClass, tags) =>
    tags.name ?? (defaultTransforms.entityName ?? identity)(pgClass.relname),
  shapeName: (entityName, kind) =>
    kind === "row" ? entityName : entityName + (defaultTransforms.shapeSuffix ?? identity)(kind),
  fieldName: (pgAttribute, tags) =>
    tags.name ?? (defaultTransforms.fieldName ?? identity)(pgAttribute.attname),
  enumName: (pgType, tags) => tags.name ?? (defaultTransforms.enumName ?? identity)(pgType.typname),
  enumValueName: value => (defaultTransforms.enumValue ?? identity)(value),
  relationName: name => (defaultTransforms.relationName ?? identity)(name),
  functionName: (pgProc, tags) =>
    tags.name ?? (defaultTransforms.functionName ?? identity)(pgProc.proname),
};

// ============================================================================
// Factory Functions
// ============================================================================

/** Identity function - returns input unchanged */
const identity: TransformFn = s => s;

/**
 * Create a CoreInflection instance with optional configuration overrides.
 *
 * By default, applies standard JS/TS naming conventions (PascalCase entities,
 * camelCase relations, etc.). User config is merged on top of defaults.
 * Smart tags (@name) always take precedence over configured transforms.
 *
 * @example
 * ```typescript
 * import { inflect } from "pg-sourcerer"
 *
 * // Use defaults (standard JS/TS conventions)
 * const inflection = createInflection()
 *
 * // Override specific transforms
 * const inflection = createInflection({
 *   fieldName: inflect.camelCase,  // Also camelCase fields
 * })
 *
 * // Use identity (raw DB names) for everything
 * const inflection = createInflection({
 *   entityName: (name) => name,
 *   fieldName: (name) => name,
 *   enumName: (name) => name,
 *   shapeSuffix: (name) => name,
 *   relationName: (name) => name,
 * })
 * ```
 */
export function createInflection(config?: InflectionConfig): CoreInflection {
  if (!config) return defaultInflection;

  // Primitive transforms (user can override singularize/pluralize)
  const singularizeFn = config.singularize ?? inflect.singularize;
  const pluralizeFn = config.pluralize ?? inflect.pluralize;

  // Build entityName default using the configured singularize
  const defaultEntityName = (name: string) => inflect.pascalCase(singularizeFn(name));

  // Merge user config on top of defaults
  const entityFn = config.entityName ?? defaultEntityName;
  const fieldFn = config.fieldName ?? defaultTransforms.fieldName ?? identity;
  const enumNameFn = config.enumName ?? defaultTransforms.enumName ?? identity;
  const enumValueFn = config.enumValue ?? defaultTransforms.enumValue ?? identity;
  const shapeSuffixFn = config.shapeSuffix ?? defaultTransforms.shapeSuffix ?? identity;
  const relationFn = config.relationName ?? defaultTransforms.relationName ?? identity;
  const functionFn = config.functionName ?? defaultTransforms.functionName ?? identity;

  return {
    // Primitive transforms (configurable)
    camelCase: defaultInflection.camelCase,
    pascalCase: defaultInflection.pascalCase,
    pluralize: pluralizeFn,
    singularize: singularizeFn,
    safeIdentifier: defaultInflection.safeIdentifier,

    // Configurable transforms (smart tags take precedence)
    entityName: (pgClass, tags) => tags.name ?? entityFn(pgClass.relname),

    shapeName: (entityName, kind) =>
      kind === "row" ? entityName : entityName + shapeSuffixFn(kind),

    fieldName: (pgAttribute, tags) => tags.name ?? fieldFn(pgAttribute.attname),

    enumName: (pgType, tags) => tags.name ?? enumNameFn(pgType.typname),

    enumValueName: value => enumValueFn(value),

    relationName: name => relationFn(name),

    functionName: (pgProc, tags) => tags.name ?? functionFn(pgProc.proname),
  };
}

/**
 * Create an Effect Layer that provides inflection with optional configuration overrides.
 *
 * By default, applies standard JS/TS naming conventions. User config is merged on top.
 *
 * @example
 * ```typescript
 * import { inflect } from "pg-sourcerer"
 *
 * // Default layer (standard JS/TS conventions)
 * const layer = makeInflectionLayer()
 *
 * // Override specific transforms
 * const layer = makeInflectionLayer({
 *   fieldName: inflect.camelCase,  // Also camelCase fields
 * })
 * ```
 */
export function makeInflectionLayer(config?: InflectionConfig): Layer.Layer<Inflection> {
  return Layer.succeed(Inflection, createInflection(config));
}

// ============================================================================
// Convenience Exports
// ============================================================================

/** Default inflection layer (standard JS/TS naming conventions) */
export const InflectionLive = makeInflectionLayer();

// ============================================================================
// Inflection Composition
// ============================================================================

/**
 * Compose two transform functions: plugin runs first, then user refines.
 */
const composeFns = (
  pluginFn: TransformFn | undefined,
  userFn: TransformFn | undefined,
): TransformFn | undefined => {
  if (!pluginFn && !userFn) return undefined;
  if (!pluginFn) return userFn;
  if (!userFn) return pluginFn;
  return name => userFn(pluginFn(name));
};

/**
 * Compose plugin inflection defaults with user-configured inflection.
 *
 * Plugin defaults are applied first, then user config refines the result.
 * This allows plugins to set baseline conventions while users can customize.
 *
 * @example
 * ```typescript
 * // Plugin wants PascalCase
 * const pluginDefaults = { entityName: inflect.pascalCase }
 *
 * // User wants singular names
 * const userConfig = { entityName: inflect.singularize }
 *
 * // Composed: "users" → "Users" → "User"
 * const composed = composeInflectionConfigs(pluginDefaults, userConfig)
 * ```
 *
 * @param pluginDefaults - Plugin's baseline inflection (applied first)
 * @param userConfig - User's refinement config (applied second)
 * @returns Merged InflectionConfig with composed functions
 */
export function composeInflectionConfigs(
  pluginDefaults: InflectionConfig | undefined,
  userConfig: InflectionConfig | undefined,
): InflectionConfig {
  if (!pluginDefaults && !userConfig) return {};
  if (!pluginDefaults) return userConfig!;
  if (!userConfig) return pluginDefaults;

  return Object.fromEntries(
    Object.entries({
      singularize: composeFns(pluginDefaults.singularize, userConfig.singularize),
      pluralize: composeFns(pluginDefaults.pluralize, userConfig.pluralize),
      entityName: composeFns(pluginDefaults.entityName, userConfig.entityName),
      fieldName: composeFns(pluginDefaults.fieldName, userConfig.fieldName),
      enumName: composeFns(pluginDefaults.enumName, userConfig.enumName),
      enumValue: composeFns(pluginDefaults.enumValue, userConfig.enumValue),
      shapeSuffix: composeFns(pluginDefaults.shapeSuffix, userConfig.shapeSuffix),
      relationName: composeFns(pluginDefaults.relationName, userConfig.relationName),
      functionName: composeFns(pluginDefaults.functionName, userConfig.functionName),
    }).filter(([, v]) => v !== undefined),
  ) as InflectionConfig;
}

/**
 * Compose a CoreInflection with plugin defaults.
 *
 * This is used by PluginRunner to merge plugin's inflectionDefaults
 * with the user's configured inflection.
 *
 * @param baseInflection - The user's CoreInflection instance
 * @param pluginDefaults - Plugin's default transforms to apply first
 * @returns New CoreInflection with composed behavior
 */
export function composeInflection(
  baseInflection: CoreInflection,
  pluginDefaults: InflectionConfig | undefined,
): CoreInflection {
  if (!pluginDefaults) return baseInflection;

  const singularizeFn = pluginDefaults.singularize;
  const pluralizeFn = pluginDefaults.pluralize;
  const entityFn = pluginDefaults.entityName;
  const fieldFn = pluginDefaults.fieldName;
  const enumNameFn = pluginDefaults.enumName;
  const enumValueFn = pluginDefaults.enumValue;
  const shapeSuffixFn = pluginDefaults.shapeSuffix;
  const relationFn = pluginDefaults.relationName;
  const functionFn = pluginDefaults.functionName;

  // If no transforms defined, return base unchanged
  if (
    !singularizeFn &&
    !pluralizeFn &&
    !entityFn &&
    !fieldFn &&
    !enumNameFn &&
    !enumValueFn &&
    !shapeSuffixFn &&
    !relationFn &&
    !functionFn
  ) {
    return baseInflection;
  }

  // Compose primitives: plugin first, then base
  const composedSingularize = singularizeFn
    ? (word: string) => baseInflection.singularize(singularizeFn(word))
    : baseInflection.singularize;
  const composedPluralize = pluralizeFn
    ? (word: string) => baseInflection.pluralize(pluralizeFn(word))
    : baseInflection.pluralize;

  return {
    // Primitive transforms (composed if plugin provides them)
    camelCase: baseInflection.camelCase,
    pascalCase: baseInflection.pascalCase,
    pluralize: composedPluralize,
    singularize: composedSingularize,
    safeIdentifier: baseInflection.safeIdentifier,

    // Compose: plugin transforms first, then base transforms
    entityName: (pgClass, tags) => {
      if (tags.name) return tags.name;
      const afterPlugin = entityFn ? entityFn(pgClass.relname) : pgClass.relname;
      // Now apply base inflection's transform to the result
      // We simulate this by calling base with a fake pgClass that has the transformed name
      return baseInflection.entityName({ ...pgClass, relname: afterPlugin }, {});
    },

    shapeName: (entityName, kind) => {
      if (kind === "row") return entityName;
      const afterPlugin = shapeSuffixFn ? shapeSuffixFn(kind) : kind;
      // Base's shapeName concatenates, so we need to handle carefully
      // Actually base just does: entityName + kind, so we transform kind first
      return entityName + afterPlugin;
    },

    fieldName: (pgAttribute, tags) => {
      if (tags.name) return tags.name;
      const afterPlugin = fieldFn ? fieldFn(pgAttribute.attname) : pgAttribute.attname;
      return baseInflection.fieldName({ ...pgAttribute, attname: afterPlugin }, {});
    },

    enumName: (pgType, tags) => {
      if (tags.name) return tags.name;
      const afterPlugin = enumNameFn ? enumNameFn(pgType.typname) : pgType.typname;
      return baseInflection.enumName({ ...pgType, typname: afterPlugin }, {});
    },

    enumValueName: value => {
      const afterPlugin = enumValueFn ? enumValueFn(value) : value;
      return baseInflection.enumValueName(afterPlugin);
    },

    relationName: name => {
      const afterPlugin = relationFn ? relationFn(name) : name;
      return baseInflection.relationName(afterPlugin);
    },

    functionName: (pgProc, tags) => {
      if (tags.name) return tags.name;
      const afterPlugin = functionFn ? functionFn(pgProc.proname) : pgProc.proname;
      return baseInflection.functionName({ ...pgProc, proname: afterPlugin }, {});
    },
  };
}

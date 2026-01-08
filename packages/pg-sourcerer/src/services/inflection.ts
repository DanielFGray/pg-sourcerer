/**
 * Core Inflection Service - naming transformations
 *
 * Provides configurable naming conventions for entities, fields, enums, etc.
 * Users configure with simple string→string functions that compose naturally.
 */
import { Context, Layer, String as Str } from "effect"
import type { PgAttribute, PgClass, PgProc, PgType } from "@danielfgray/pg-introspection"
import type { SmartTags, ShapeKind } from "../ir/index.js"

// ============================================================================
// Reserved Words
// ============================================================================

const RESERVED_WORDS = new Set([
  // TypeScript/JavaScript reserved
  "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for",
  "function", "if", "import", "in", "instanceof", "new", "null", "return", "super",
  "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with",
  "yield", "let", "static", "implements", "interface", "package", "private",
  "protected", "public", "abstract", "as", "async", "await", "constructor", "declare",
  "get", "is", "module", "namespace", "never", "readonly", "require", "number",
  "object", "set", "string", "symbol", "type", "undefined", "unique", "unknown",
  "from", "global", "keyof", "of", "infer", "any", "boolean", "bigint",
])

// ============================================================================
// Inflection Helper Functions
// ============================================================================

/**
 * Simple pluralization (naive, covers common cases)
 */
const pluralize = (word: string): string => {
  if (
    word.endsWith("s") ||
    word.endsWith("x") ||
    word.endsWith("z") ||
    word.endsWith("ch") ||
    word.endsWith("sh")
  ) {
    return word + "es"
  }
  if (word.endsWith("y") && !/[aeiou]y$/i.test(word)) {
    return word.slice(0, -1) + "ies"
  }
  return word + "s"
}

/**
 * Simple singularization (naive, covers common cases)
 */
const singularize = (word: string): string => {
  if (word.endsWith("ies") && word.length > 3) {
    return word.slice(0, -3) + "y"
  }
  if (
    word.endsWith("es") &&
    (word.endsWith("sses") ||
      word.endsWith("xes") ||
      word.endsWith("zes") ||
      word.endsWith("ches") ||
      word.endsWith("shes"))
  ) {
    return word.slice(0, -2)
  }
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 1) {
    return word.slice(0, -1)
  }
  return word
}

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
  singularize,
  /** Pluralize a word (user → users) */
  pluralize,
  /** Capitalize first letter */
  capitalize: Str.capitalize,
  /** Uncapitalize first letter */
  uncapitalize: Str.uncapitalize,
  /** Convert to lowercase */
  lowercase: (s: string) => s.toLowerCase(),
  /** Convert to uppercase */
  uppercase: (s: string) => s.toUpperCase(),
} as const

// ============================================================================
// Core Inflection Interface
// ============================================================================

/**
 * Core inflection interface - shared naming transformations
 */
export interface CoreInflection {
  readonly camelCase: (text: string) => string
  readonly pascalCase: (text: string) => string
  readonly pluralize: (text: string) => string
  readonly singularize: (text: string) => string
  readonly safeIdentifier: (text: string) => string
  readonly entityName: (pgClass: PgClass, tags: SmartTags) => string
  readonly shapeName: (entityName: string, kind: ShapeKind) => string
  readonly fieldName: (pgAttribute: PgAttribute, tags: SmartTags) => string
  readonly enumName: (pgType: PgType, tags: SmartTags) => string
  readonly enumValueName: (value: string) => string
  readonly relationName: (name: string) => string
  readonly functionName: (pgProc: PgProc, tags: SmartTags) => string
}

/** Service tag */
export class Inflection extends Context.Tag("Inflection")<Inflection, CoreInflection>() {}

// ============================================================================
// Inflection Configuration
// ============================================================================

/**
 * A simple string→string transform function.
 */
export type TransformFn = (input: string) => string

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
   * Transform table/view name → entity name.
   * Default: identity (preserve table name)
   */
  readonly entityName?: TransformFn

  /**
   * Transform column name → field name.
   * Default: identity (preserve column name)
   */
  readonly fieldName?: TransformFn

  /**
   * Transform PostgreSQL enum type name → TypeScript enum name.
   * Default: identity (preserve type name)
   */
  readonly enumName?: TransformFn

  /**
   * Transform enum values.
   * Default: identity (preserve value)
   */
  readonly enumValue?: TransformFn

  /**
   * Transform shape kind suffix.
   * Default: identity ("row", "insert", etc.)
   */
  readonly shapeSuffix?: TransformFn

  /**
   * Transform relation names.
   * Default: identity (preserve name)
   */
  readonly relationName?: TransformFn

  /**
   * Transform function name.
   * Default: "{name}_{argCount}" for overload disambiguation
   */
  readonly functionName?: TransformFn
}

// ============================================================================
// Default Inflection (identity - no transforms)
// ============================================================================

/**
 * Default inflection implementation.
 * Preserves PostgreSQL names as-is (identity transforms).
 */
export const defaultInflection: CoreInflection = {
  // Primitive transforms (always available)
  camelCase: inflect.camelCase,
  pascalCase: inflect.pascalCase,
  pluralize: inflect.pluralize,
  singularize: inflect.singularize,
  safeIdentifier: (text) => (RESERVED_WORDS.has(text) ? text + "_" : text),

  // Configurable transforms (default to identity)
  entityName: (pgClass, tags) => tags.name ?? pgClass.relname,
  shapeName: (entityName, kind) => kind === "row" ? entityName : entityName + kind,
  fieldName: (pgAttribute, tags) => tags.name ?? pgAttribute.attname,
  enumName: (pgType, tags) => tags.name ?? pgType.typname,
  enumValueName: (value) => value,
  relationName: (name) => name,
  functionName: (pgProc, tags) => tags.name ?? `${pgProc.proname}_${pgProc.pronargs}`,
}

// ============================================================================
// Factory Functions
// ============================================================================

/** Identity function - returns input unchanged */
const identity: TransformFn = (s) => s

/**
 * Create a CoreInflection instance with optional configuration.
 *
 * Smart tags (@name) always take precedence over configured transforms.
 *
 * @example
 * ```typescript
 * import { inflect } from "pg-sourcerer"
 * 
 * // Use defaults (identity - preserve names)
 * const inflection = createInflection()
 *
 * // Common JS/TS conventions
 * const inflection = createInflection({
 *   entityName: (name) => inflect.pascalCase(inflect.singularize(name)),
 *   fieldName: inflect.camelCase,
 *   enumName: inflect.pascalCase,
 *   shapeSuffix: inflect.capitalize,
 * })
 * ```
 */
export function createInflection(config?: InflectionConfig): CoreInflection {
  if (!config) return defaultInflection

  const entityFn = config.entityName ?? identity
  const fieldFn = config.fieldName ?? identity
  const enumNameFn = config.enumName ?? identity
  const enumValueFn = config.enumValue ?? identity
  const shapeSuffixFn = config.shapeSuffix ?? identity
  const relationFn = config.relationName ?? identity
  const functionFn = config.functionName ?? identity

  return {
    // Primitive transforms unchanged
    camelCase: defaultInflection.camelCase,
    pascalCase: defaultInflection.pascalCase,
    pluralize: defaultInflection.pluralize,
    singularize: defaultInflection.singularize,
    safeIdentifier: defaultInflection.safeIdentifier,

    // Configurable transforms (smart tags take precedence)
    entityName: (pgClass, tags) =>
      tags.name ?? entityFn(pgClass.relname),

    shapeName: (entityName, kind) =>
      kind === "row" ? entityName : entityName + shapeSuffixFn(kind),

    fieldName: (pgAttribute, tags) =>
      tags.name ?? fieldFn(pgAttribute.attname),

    enumName: (pgType, tags) =>
      tags.name ?? enumNameFn(pgType.typname),

    enumValueName: (value) => enumValueFn(value),

    relationName: (name) => relationFn(name),

    functionName: (pgProc, tags) =>
      tags.name ?? functionFn(`${pgProc.proname}_${pgProc.pronargs}`),
  }
}

/**
 * Create an Effect Layer that provides inflection with optional configuration.
 *
 * @example
 * ```typescript
 * import { inflect } from "pg-sourcerer"
 * 
 * // Default layer (identity transforms)
 * const layer = makeInflectionLayer()
 *
 * // Configured layer
 * const layer = makeInflectionLayer({
 *   entityName: (name) => inflect.pascalCase(inflect.singularize(name)),
 *   fieldName: inflect.camelCase,
 * })
 * ```
 */
export function makeInflectionLayer(config?: InflectionConfig): Layer.Layer<Inflection> {
  return Layer.succeed(Inflection, createInflection(config))
}

// ============================================================================
// Convenience Exports
// ============================================================================

/** Default inflection layer (identity - no transforms) */
export const InflectionLive = makeInflectionLayer()

/**
 * Classic inflection config - matches the "opinionated" defaults of many ORMs:
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
export const classicInflectionConfig: InflectionConfig = {
  entityName: (name) => inflect.pascalCase(inflect.singularize(name)),
  // fieldName: identity (default) - preserves snake_case from database
  enumName: inflect.pascalCase,
  shapeSuffix: inflect.capitalize,
  relationName: inflect.camelCase,
}

/** Classic inflection layer - applies traditional ORM naming conventions */
export const ClassicInflectionLive = makeInflectionLayer(classicInflectionConfig)

// ============================================================================
// Inflection Composition
// ============================================================================

/**
 * Compose two transform functions: plugin runs first, then user refines.
 */
const composeFns = (
  pluginFn: TransformFn | undefined,
  userFn: TransformFn | undefined
): TransformFn | undefined => {
  if (!pluginFn && !userFn) return undefined
  if (!pluginFn) return userFn
  if (!userFn) return pluginFn
  return (name) => userFn(pluginFn(name))
}

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
  userConfig: InflectionConfig | undefined
): InflectionConfig {
  if (!pluginDefaults && !userConfig) return {}
  if (!pluginDefaults) return userConfig!
  if (!userConfig) return pluginDefaults

  return Object.fromEntries(
    Object.entries({
      entityName: composeFns(pluginDefaults.entityName, userConfig.entityName),
      fieldName: composeFns(pluginDefaults.fieldName, userConfig.fieldName),
      enumName: composeFns(pluginDefaults.enumName, userConfig.enumName),
      enumValue: composeFns(pluginDefaults.enumValue, userConfig.enumValue),
      shapeSuffix: composeFns(pluginDefaults.shapeSuffix, userConfig.shapeSuffix),
      relationName: composeFns(pluginDefaults.relationName, userConfig.relationName),
      functionName: composeFns(pluginDefaults.functionName, userConfig.functionName),
    }).filter(([, v]) => v !== undefined)
  ) as InflectionConfig
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
  pluginDefaults: InflectionConfig | undefined
): CoreInflection {
  if (!pluginDefaults) return baseInflection

  const entityFn = pluginDefaults.entityName
  const fieldFn = pluginDefaults.fieldName
  const enumNameFn = pluginDefaults.enumName
  const enumValueFn = pluginDefaults.enumValue
  const shapeSuffixFn = pluginDefaults.shapeSuffix
  const relationFn = pluginDefaults.relationName
  const functionFn = pluginDefaults.functionName

  // If no transforms defined, return base unchanged
  if (!entityFn && !fieldFn && !enumNameFn && !enumValueFn && !shapeSuffixFn && !relationFn && !functionFn) {
    return baseInflection
  }

  return {
    // Primitive transforms unchanged
    camelCase: baseInflection.camelCase,
    pascalCase: baseInflection.pascalCase,
    pluralize: baseInflection.pluralize,
    singularize: baseInflection.singularize,
    safeIdentifier: baseInflection.safeIdentifier,

    // Compose: plugin transforms first, then base transforms
    entityName: (pgClass, tags) => {
      if (tags.name) return tags.name
      const afterPlugin = entityFn ? entityFn(pgClass.relname) : pgClass.relname
      // Now apply base inflection's transform to the result
      // We simulate this by calling base with a fake pgClass that has the transformed name
      return baseInflection.entityName({ ...pgClass, relname: afterPlugin }, {})
    },

    shapeName: (entityName, kind) => {
      if (kind === "row") return entityName
      const afterPlugin = shapeSuffixFn ? shapeSuffixFn(kind) : kind
      // Base's shapeName concatenates, so we need to handle carefully
      // Actually base just does: entityName + kind, so we transform kind first
      return entityName + afterPlugin
    },

    fieldName: (pgAttribute, tags) => {
      if (tags.name) return tags.name
      const afterPlugin = fieldFn ? fieldFn(pgAttribute.attname) : pgAttribute.attname
      return baseInflection.fieldName({ ...pgAttribute, attname: afterPlugin }, {})
    },

    enumName: (pgType, tags) => {
      if (tags.name) return tags.name
      const afterPlugin = enumNameFn ? enumNameFn(pgType.typname) : pgType.typname
      return baseInflection.enumName({ ...pgType, typname: afterPlugin }, {})
    },

    enumValueName: (value) => {
      const afterPlugin = enumValueFn ? enumValueFn(value) : value
      return baseInflection.enumValueName(afterPlugin)
    },

    relationName: (name) => {
      const afterPlugin = relationFn ? relationFn(name) : name
      return baseInflection.relationName(afterPlugin)
    },

    functionName: (pgProc, tags) => {
      if (tags.name) return tags.name
      const baseName = `${pgProc.proname}_${pgProc.pronargs}`
      const afterPlugin = functionFn ? functionFn(baseName) : baseName
      return baseInflection.functionName({ ...pgProc, proname: afterPlugin }, {})
    },
  }
}

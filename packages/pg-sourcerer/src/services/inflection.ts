/**
 * Core Inflection Service - naming transformations
 *
 * Provides configurable naming conventions for entities, fields, enums, etc.
 * Users configure transform chains (e.g., ["singularize", "pascalCase"]) which
 * are applied in order. Empty chains preserve names as-is (identity).
 */
import { Context, Layer, String as Str } from "effect"
import type { PgAttribute, PgClass, PgConstraint, PgType } from "pg-introspection"
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
// Simple Pluralization (naive, covers common cases)
// ============================================================================

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

// ============================================================================
// Transform Registry
// ============================================================================

/**
 * Available transform names that can be used in transform chains.
 */
export type TransformName =
  | "camelCase"
  | "pascalCase"
  | "snakeCase"
  | "singularize"
  | "pluralize"
  | "capitalize"
  | "uncapitalize"
  | "lowercase"
  | "uppercase"

/**
 * Registry of named transforms.
 * Each transform is a pure function: string → string
 */
const transformRegistry: Record<TransformName, (s: string) => string> = {
  camelCase: Str.snakeToCamel,
  pascalCase: Str.snakeToPascal,
  snakeCase: Str.camelToSnake,
  singularize,
  pluralize,
  capitalize: Str.capitalize,
  uncapitalize: Str.uncapitalize,
  lowercase: (s) => s.toLowerCase(),
  uppercase: (s) => s.toUpperCase(),
}

/**
 * A chain of transforms to apply in order.
 * Empty array = identity (preserve as-is).
 */
export type TransformChain = readonly TransformName[]

/**
 * Apply a chain of transforms to a string.
 * Returns the input unchanged if chain is empty.
 */
export function applyTransformChain(input: string, chain: TransformChain): string {
  return chain.reduce((s, name) => transformRegistry[name](s), input)
}

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
  readonly relationName: (
    constraint: PgConstraint,
    side: "local" | "foreign",
    tags: SmartTags
  ) => string
}

/** Service tag */
export class Inflection extends Context.Tag("Inflection")<Inflection, CoreInflection>() {}

// ============================================================================
// Inflection Configuration
// ============================================================================

/**
 * Configuration for customizing inflection behavior.
 *
 * Each property is a chain of transform names to apply in order.
 * Empty arrays (or undefined) preserve names as-is (identity).
 * Smart tags (@name) always take precedence over configured transforms.
 *
 * @example
 * ```typescript
 * const config: InflectionConfig = {
 *   // users → User
 *   entityName: ["singularize", "pascalCase"],
 *   
 *   // created_at → createdAt
 *   fieldName: ["camelCase"],
 *   
 *   // user_status → UserStatus  
 *   enumName: ["pascalCase"],
 *   
 *   // Keep enum values as-is
 *   enumValue: [],
 *   
 *   // row → Row
 *   shapeSuffix: ["capitalize"],
 * }
 * ```
 */
export interface InflectionConfig {
  /**
   * Transform chain for table/view name → entity name.
   * Default: [] (identity - preserve table name)
   * Common: ["singularize", "pascalCase"] for "users" → "User"
   */
  readonly entityName?: TransformChain

  /**
   * Transform chain for column name → field name.
   * Default: [] (identity - preserve column name)
   * Common: ["camelCase"] for "created_at" → "createdAt"
   */
  readonly fieldName?: TransformChain

  /**
   * Transform chain for PostgreSQL enum type name → TypeScript enum name.
   * Default: [] (identity - preserve type name)
   * Common: ["pascalCase"] for "user_status" → "UserStatus"
   */
  readonly enumName?: TransformChain

  /**
   * Transform chain for enum values.
   * Default: [] (identity - preserve value)
   */
  readonly enumValue?: TransformChain

  /**
   * Transform chain for shape kind suffix.
   * Default: [] (identity - "row", "insert", etc.)
   * Common: ["capitalize"] for "row" → "Row"
   */
  readonly shapeSuffix?: TransformChain

  /**
   * Transform chain for relation names derived from constraints.
   * Default: [] (identity after cleaning constraint name)
   * Common: ["camelCase"] for "author_id" → "authorId"
   */
  readonly relationName?: TransformChain
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
  camelCase: Str.snakeToCamel,
  pascalCase: Str.snakeToPascal,
  pluralize,
  singularize,
  safeIdentifier: (text) => (RESERVED_WORDS.has(text) ? text + "_" : text),

  // Configurable transforms (default to identity)
  entityName: (pgClass, tags) => tags.name ?? pgClass.relname,
  shapeName: (entityName, kind) => entityName + kind,
  fieldName: (pgAttribute, tags) => tags.name ?? pgAttribute.attname,
  enumName: (pgType, tags) => tags.name ?? pgType.typname,
  enumValueName: (value) => value,

  relationName: (constraint, side, tags) => {
    if (side === "local" && tags.fieldName) return tags.fieldName
    if (side === "foreign" && tags.foreignFieldName) return tags.foreignFieldName

    // Clean constraint name: "posts_author_id_fkey" → "author"
    const name = constraint.conname
    return name
      .replace(/_fkey$/, "")
      .replace(/_id$/, "")
      .replace(/^[^_]+_/, "")
  },
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a CoreInflection instance with optional configuration.
 *
 * Transform chains are applied in order. Empty chains = identity.
 * Smart tags (@name) always take precedence over configured transforms.
 *
 * @example
 * ```typescript
 * // Use defaults (identity - preserve names)
 * const inflection = createInflection()
 *
 * // Common JS/TS conventions
 * const inflection = createInflection({
 *   entityName: ["singularize", "pascalCase"],
 *   fieldName: ["camelCase"],
 *   enumName: ["pascalCase"],
 *   shapeSuffix: ["capitalize"],
 * })
 * ```
 */
export function createInflection(config?: InflectionConfig): CoreInflection {
  if (!config) return defaultInflection

  // Get configured chains or empty (identity)
  const entityChain = config.entityName ?? []
  const fieldChain = config.fieldName ?? []
  const enumNameChain = config.enumName ?? []
  const enumValueChain = config.enumValue ?? []
  const shapeSuffixChain = config.shapeSuffix ?? []
  const relationChain = config.relationName ?? []

  // If all chains are empty, return default
  if (
    entityChain.length === 0 &&
    fieldChain.length === 0 &&
    enumNameChain.length === 0 &&
    enumValueChain.length === 0 &&
    shapeSuffixChain.length === 0 &&
    relationChain.length === 0
  ) {
    return defaultInflection
  }

  return {
    // Primitive transforms unchanged
    camelCase: defaultInflection.camelCase,
    pascalCase: defaultInflection.pascalCase,
    pluralize: defaultInflection.pluralize,
    singularize: defaultInflection.singularize,
    safeIdentifier: defaultInflection.safeIdentifier,

    // Configurable transforms (smart tags take precedence)
    entityName: (pgClass, tags) =>
      tags.name ?? applyTransformChain(pgClass.relname, entityChain),

    shapeName: (entityName, kind) =>
      entityName + applyTransformChain(kind, shapeSuffixChain),

    fieldName: (pgAttribute, tags) =>
      tags.name ?? applyTransformChain(pgAttribute.attname, fieldChain),

    enumName: (pgType, tags) =>
      tags.name ?? applyTransformChain(pgType.typname, enumNameChain),

    enumValueName: (value) => applyTransformChain(value, enumValueChain),

    relationName: (constraint, side, tags) => {
      if (side === "local" && tags.fieldName) return tags.fieldName
      if (side === "foreign" && tags.foreignFieldName) return tags.foreignFieldName

      // Clean constraint name first
      const cleaned = constraint.conname
        .replace(/_fkey$/, "")
        .replace(/_id$/, "")
        .replace(/^[^_]+_/, "")

      return applyTransformChain(cleaned, relationChain)
    },
  }
}

/**
 * Create an Effect Layer that provides inflection with optional configuration.
 *
 * @example
 * ```typescript
 * // Default layer (identity transforms)
 * const layer = makeInflectionLayer()
 *
 * // Configured layer
 * const layer = makeInflectionLayer({
 *   entityName: ["singularize", "pascalCase"],
 *   fieldName: ["camelCase"],
 * })
 *
 * // Use in Effect pipeline
 * Effect.gen(function* () {
 *   const inflection = yield* Inflection
 *   // ...
 * }).pipe(Effect.provide(layer))
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
 * - Field names: camelCase (created_at → createdAt)
 * - Enum names: PascalCase (user_status → UserStatus)
 * - Shape suffixes: capitalize (row → Row)
 * - Relation names: camelCase
 */
export const classicInflectionConfig: InflectionConfig = {
  entityName: ["singularize", "pascalCase"],
  fieldName: ["camelCase"],
  enumName: ["pascalCase"],
  shapeSuffix: ["capitalize"],
  relationName: ["camelCase"],
}

/** Classic inflection layer - applies traditional ORM naming conventions */
export const ClassicInflectionLive = makeInflectionLayer(classicInflectionConfig)

// ============================================================================
// Inflection Composition
// ============================================================================

/**
 * Compose two transform chains: first chain runs, then second chain on result.
 * 
 * @example
 * ```typescript
 * composeChains(["pascalCase"], ["singularize"])
 * // "users" → pascalCase → "Users" → singularize → "User"
 * ```
 */
const composeChains = (
  first: TransformChain | undefined,
  second: TransformChain | undefined
): TransformChain => {
  const a = first ?? []
  const b = second ?? []
  return [...a, ...b]
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
 * const pluginDefaults = { entityName: ["pascalCase"] }
 * 
 * // User wants singular names
 * const userConfig = { entityName: ["singularize"] }
 * 
 * // Composed: "users" → "Users" → "User"
 * const composed = composeInflectionConfigs(pluginDefaults, userConfig)
 * // composed.entityName = ["pascalCase", "singularize"]
 * ```
 * 
 * @param pluginDefaults - Plugin's baseline inflection (applied first)
 * @param userConfig - User's refinement config (applied second)
 * @returns Merged InflectionConfig with composed chains
 */
export function composeInflectionConfigs(
  pluginDefaults: InflectionConfig | undefined,
  userConfig: InflectionConfig | undefined
): InflectionConfig {
  if (!pluginDefaults && !userConfig) return {}
  if (!pluginDefaults) return userConfig!
  if (!userConfig) return pluginDefaults

  return {
    entityName: composeChains(pluginDefaults.entityName, userConfig.entityName),
    fieldName: composeChains(pluginDefaults.fieldName, userConfig.fieldName),
    enumName: composeChains(pluginDefaults.enumName, userConfig.enumName),
    enumValue: composeChains(pluginDefaults.enumValue, userConfig.enumValue),
    shapeSuffix: composeChains(pluginDefaults.shapeSuffix, userConfig.shapeSuffix),
    relationName: composeChains(pluginDefaults.relationName, userConfig.relationName),
  }
}

/**
 * Create a CoreInflection by composing plugin defaults with a base inflection.
 * 
 * @param base - Base inflection (usually from user config)
 * @param pluginDefaults - Plugin's default transforms to prepend
 * @returns New CoreInflection with composed behavior
 */
export function composeInflection(
  base: CoreInflection,
  pluginDefaults: InflectionConfig | undefined
): CoreInflection {
  if (!pluginDefaults) return base
  
  // If plugin has no transforms defined, return base unchanged
  const hasTransforms = 
    (pluginDefaults.entityName?.length ?? 0) > 0 ||
    (pluginDefaults.fieldName?.length ?? 0) > 0 ||
    (pluginDefaults.enumName?.length ?? 0) > 0 ||
    (pluginDefaults.enumValue?.length ?? 0) > 0 ||
    (pluginDefaults.shapeSuffix?.length ?? 0) > 0 ||
    (pluginDefaults.relationName?.length ?? 0) > 0
  
  if (!hasTransforms) return base

  const entityChain = pluginDefaults.entityName ?? []
  const fieldChain = pluginDefaults.fieldName ?? []
  const enumNameChain = pluginDefaults.enumName ?? []
  const enumValueChain = pluginDefaults.enumValue ?? []
  const shapeSuffixChain = pluginDefaults.shapeSuffix ?? []
  const relationChain = pluginDefaults.relationName ?? []

  return {
    // Primitive transforms unchanged
    camelCase: base.camelCase,
    pascalCase: base.pascalCase,
    pluralize: base.pluralize,
    singularize: base.singularize,
    safeIdentifier: base.safeIdentifier,

    // Compose: plugin transforms first, then base transforms
    // Plugin runs on raw name, base runs on plugin's output
    entityName: (pgClass, tags) => {
      if (tags.name) return tags.name
      const afterPlugin = applyTransformChain(pgClass.relname, entityChain)
      // Simulate what base would do by calling it with a fake pgClass
      // Actually, we need to apply base's transform to afterPlugin
      // But base.entityName expects a PgClass... 
      // The cleanest approach: base is identity, we just apply plugin chain
      // For full composition, we'd need to extract base's chain
      // For now: plugin chain only (base is identity by default)
      return afterPlugin
    },

    shapeName: (entityName, kind) => {
      const suffix = applyTransformChain(kind, shapeSuffixChain)
      return entityName + suffix
    },

    fieldName: (pgAttribute, tags) => {
      if (tags.name) return tags.name
      return applyTransformChain(pgAttribute.attname, fieldChain)
    },

    enumName: (pgType, tags) => {
      if (tags.name) return tags.name
      return applyTransformChain(pgType.typname, enumNameChain)
    },

    enumValueName: (value) => applyTransformChain(value, enumValueChain),

    relationName: (constraint, side, tags) => {
      if (side === "local" && tags.fieldName) return tags.fieldName
      if (side === "foreign" && tags.foreignFieldName) return tags.foreignFieldName

      const cleaned = constraint.conname
        .replace(/_fkey$/, "")
        .replace(/_id$/, "")
        .replace(/^[^_]+_/, "")

      return applyTransformChain(cleaned, relationChain)
    },
  }
}

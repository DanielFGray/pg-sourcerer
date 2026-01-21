/**
 * Core Inflection Service - naming transformations
 *
 * Provides configurable naming conventions for entities, fields, enums, etc.
 * Users configure with simple string→string functions that compose naturally.
 *
 * ## Inflection Registry
 *
 * The registry tracks the provenance of inflected names, allowing the file
 * assignment system to determine which base entity a derived name belongs to.
 *
 * Example: `UserInsert` → base entity `User`, variant `insert`
 *
 * This solves the problem where schemas for `UserInsert` would incorrectly
 * go to `generated/userinsert/` instead of `generated/user/`.
 */
import { Context, Layer, String as Str } from "effect";
import pluralize from "pluralize-esm";
import type { PgAttribute, PgClass, PgProc, PgType } from "@danielfgray/pg-introspection";
import type { SmartTags, ShapeKind } from "../ir/index.js";

// ============================================================================
// Inflection Registry Types
// ============================================================================

/**
 * The kind of name variant being registered.
 * Extends ShapeKind with additional categories for enums, composites, etc.
 */
export type NameVariant = ShapeKind | "enum" | "composite" | "domain" | "function" | "entity";

/**
 * Information about an inflected name and its provenance.
 */
export interface InflectedName {
  /** The inflected name (e.g., "UserInsert") */
  readonly name: string;
  /** Base entity this derives from (e.g., "User") */
  readonly baseEntity: string;
  /** What kind of variant this is */
  readonly variant: NameVariant;
  /** Origin for debugging (e.g., "shapeName(User, insert)") */
  readonly origin: string;
}

/**
 * Registry for tracking inflected names and their provenance.
 *
 * Used by the file assignment system to determine which base entity
 * a derived name (like "UserInsert") belongs to.
 */
export interface InflectionRegistry {
  /** Record an inflected name with its provenance */
  register(info: InflectedName): void;

  /** Look up provenance by inflected name */
  lookup(name: string): InflectedName | undefined;

  /** Get all names registered for a base entity */
  getVariants(baseEntity: string): readonly InflectedName[];

  /** Check if a name has already been registered (potential conflict) */
  hasConflict(name: string): boolean;

  /** Get all registered names (for debugging) */
  getAll(): ReadonlyMap<string, InflectedName>;
}

/**
 * Create a new InflectionRegistry instance.
 */
export function createInflectionRegistry(): InflectionRegistry {
  const byName = new Map<string, InflectedName>();
  const byBaseEntity = new Map<string, InflectedName[]>();

  return {
    register(info: InflectedName): void {
      // Check for conflicts (same name, different base entity)
      const existing = byName.get(info.name);
      if (existing && existing.baseEntity !== info.baseEntity) {
        // Log warning but allow override - last registration wins
        console.warn(
          `[InflectionRegistry] Name conflict: "${info.name}" registered for ` +
            `"${existing.baseEntity}" (${existing.origin}) and "${info.baseEntity}" (${info.origin}). ` +
            `Using "${info.baseEntity}".`,
        );
      }

      byName.set(info.name, info);

      // Index by base entity
      const variants = byBaseEntity.get(info.baseEntity);
      if (variants) {
        // Replace existing variant of same kind, or add new
        const idx = variants.findIndex((v) => v.variant === info.variant);
        if (idx >= 0) {
          variants[idx] = info;
        } else {
          variants.push(info);
        }
      } else {
        byBaseEntity.set(info.baseEntity, [info]);
      }
    },

    lookup(name: string): InflectedName | undefined {
      return byName.get(name);
    },

    getVariants(baseEntity: string): readonly InflectedName[] {
      return byBaseEntity.get(baseEntity) ?? [];
    },

    hasConflict(name: string): boolean {
      return byName.has(name);
    },

    getAll(): ReadonlyMap<string, InflectedName> {
      return byName;
    },
  };
}

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
/**
 * Convert PascalCase or camelCase to kebab-case.
 * UserProfile → user-profile, createdAt → created-at
 */
const toKebabCase = (str: string): string =>
  str
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();

export const inflect = {
  /** Convert snake_case to camelCase */
  camelCase: Str.snakeToCamel,
  /** Convert snake_case to PascalCase */
  pascalCase: Str.snakeToPascal,
  /** Convert camelCase to snake_case */
  snakeCase: Str.camelToSnake,
  /** Convert PascalCase/camelCase to kebab-case */
  kebabCase: toKebabCase,
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
 * Core inflection interface - shared naming transformations.
 *
 * Includes a registry that tracks the provenance of inflected names,
 * allowing file assignment to correctly group derived names (like UserInsert)
 * with their base entity (User).
 *
 * ## Semantic vs Mechanical Methods
 *
 * Plugins should use SEMANTIC methods that express intent:
 * - entityRoutePath(entity) → "/users"
 *
 * NOT mechanical methods that assume casing:
 * - toCamelCase(entityName) + "Create" ❌
 *
 * This allows users to customize naming conventions without plugins
 * having to understand the transformations.
 */
export interface CoreInflection {
  // ---------------------------------------------------------------------------
  // Primitive transforms (for advanced use cases only)
  // ---------------------------------------------------------------------------
  readonly camelCase: (text: string) => string;
  readonly pascalCase: (text: string) => string;
  readonly kebabCase: (text: string) => string;
  readonly pluralize: (text: string) => string;
  readonly singularize: (text: string) => string;
  readonly safeIdentifier: (text: string) => string;

  /**
   * Build a variable name from entity and suffix.
   * @example variableName("User", "Router") → "userRouter"
   * @example variableName("User", "ElysiaRoutes") → "userElysiaRoutes"
   */
  readonly variableName: (entityName: string, suffix: string) => string;

  // ---------------------------------------------------------------------------
  // IR Building (used during introspection)
  // ---------------------------------------------------------------------------
  readonly entityName: (pgClass: PgClass, tags: SmartTags) => string;
  readonly shapeName: (entityName: string, kind: ShapeKind) => string;
  readonly fieldName: (pgAttribute: PgAttribute, tags: SmartTags) => string;
  readonly enumName: (pgType: PgType, tags: SmartTags) => string;
  readonly enumValueName: (value: string) => string;
  readonly relationName: (name: string) => string;
  readonly functionName: (pgProc: PgProc, tags: SmartTags) => string;
  readonly folderName: (entityName: string) => string;

  // ---------------------------------------------------------------------------
  // Route Paths (for HTTP plugins)
  // ---------------------------------------------------------------------------

  /**
   * Base route path for an entity (plural, kebab-case).
   * @example entityRoutePath("User") → "/users"
   * @example entityRoutePath("BlogPost") → "/blog-posts"
   */
  readonly entityRoutePath: (entityName: string) => string;

  /**
   * Route path segment for cursor pagination.
   * @example cursorRoutePath("created_at") → "/by-created-at"
   * @example cursorRoutePath("updatedAt") → "/by-updated-at"
   */
  readonly cursorRoutePath: (columnName: string) => string;

  /**
   * Route path for indexed column lookup (with param).
   * @example lookupRoutePath("email", "email") → "/by-email/:email"
   * @example lookupRoutePath("user_id", "userId") → "/by-user-id/:userId"
   */
  readonly lookupRoutePath: (columnName: string, paramName: string) => string;

  /**
   * Route path for a custom function.
   * @example functionRoutePath("calculateTotal") → "/calculate-total"
   */
  readonly functionRoutePath: (fnName: string) => string;

  // ---------------------------------------------------------------------------
  // Registry
  // ---------------------------------------------------------------------------

  /**
   * Registry tracking the provenance of inflected names.
   * Auto-populated when shapeName(), entityName(), enumName() are called.
   * Used by file assignment to determine base entity for derived names.
   */
  readonly registry: InflectionRegistry;
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

  /**
   * Transform entity name → folder name for file output.
   * Default: uncapitalize (User → user, UserEmail → userEmail)
   */
  readonly folderName?: TransformFn;
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
  folderName: inflect.uncapitalize,
};

// ============================================================================
// Factory Functions
// ============================================================================

/** Identity function - returns input unchanged */
const identity: TransformFn = s => s;

/**
 * Create a CoreInflection instance with its own registry and optional config.
 *
 * Each instance gets a fresh InflectionRegistry that tracks name provenance
 * for file assignment purposes. The registry is auto-populated when
 * shapeName(), entityName(), enumName(), and functionName() are called.
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
 * // Look up provenance later
 * const info = inflection.registry.lookup("UserInsert")
 * // → { name: "UserInsert", baseEntity: "User", variant: "insert", ... }
 * ```
 */
export function createInflection(config?: InflectionConfig): CoreInflection {
  // Each instance gets its own registry
  const registry = createInflectionRegistry();

  // Primitive transforms (user can override singularize/pluralize)
  const singularizeFn = config?.singularize ?? inflect.singularize;
  const pluralizeFn = config?.pluralize ?? inflect.pluralize;

  // Build entityName default using the configured singularize
  const defaultEntityName = (name: string) => inflect.pascalCase(singularizeFn(name));

  // Merge user config on top of defaults
  const entityFn = config?.entityName ?? defaultEntityName;
  const fieldFn = config?.fieldName ?? defaultTransforms.fieldName ?? identity;
  const enumNameFn = config?.enumName ?? defaultTransforms.enumName ?? identity;
  const enumValueFn = config?.enumValue ?? defaultTransforms.enumValue ?? identity;
  const shapeSuffixFn = config?.shapeSuffix ?? defaultTransforms.shapeSuffix ?? identity;
  const relationFn = config?.relationName ?? defaultTransforms.relationName ?? identity;
  const functionFn = config?.functionName ?? defaultTransforms.functionName ?? identity;
  const folderFn = config?.folderName ?? defaultTransforms.folderName ?? identity;

  return {
    registry,

    // Primitive transforms (configurable)
    camelCase: inflect.camelCase,
    pascalCase: inflect.pascalCase,
    pluralize: pluralizeFn,
    singularize: singularizeFn,
    safeIdentifier: (text: string) => (RESERVED_WORDS.has(text) ? text + "_" : text),

    // Entity name - register with variant "entity"
    entityName: (pgClass, tags) => {
      const name = tags.name ?? entityFn(pgClass.relname);
      registry.register({
        name,
        baseEntity: name, // Entity is its own base
        variant: "entity",
        origin: `entityName(${pgClass.relname})`,
      });
      return name;
    },

    // Shape name - register with the shape kind as variant
    shapeName: (entityName, kind) => {
      const name = kind === "row" ? entityName : entityName + shapeSuffixFn(kind);
      registry.register({
        name,
        baseEntity: entityName,
        variant: kind,
        origin: `shapeName(${entityName}, ${kind})`,
      });
      return name;
    },

    fieldName: (pgAttribute, tags) => tags.name ?? fieldFn(pgAttribute.attname),

    // Enum name - register with variant "enum"
    enumName: (pgType, tags) => {
      const name = tags.name ?? enumNameFn(pgType.typname);
      registry.register({
        name,
        baseEntity: name, // Enum is its own base
        variant: "enum",
        origin: `enumName(${pgType.typname})`,
      });
      return name;
    },

    enumValueName: value => enumValueFn(value),

    relationName: name => relationFn(name),

    // Function name - register with variant "function"
    functionName: (pgProc, tags) => {
      const name = tags.name ?? functionFn(pgProc.proname);
      registry.register({
        name,
        baseEntity: name, // Function is its own base
        variant: "function",
        origin: `functionName(${pgProc.proname})`,
      });
      return name;
    },

    folderName: entityName => folderFn(entityName),

    // -------------------------------------------------------------------------
    // Semantic methods for plugins
    // -------------------------------------------------------------------------

    kebabCase: inflect.kebabCase,
    variableName: (entityName, suffix) => inflect.uncapitalize(entityName) + suffix,

    // Route paths
    entityRoutePath: entityName => {
      const kebab = inflect.kebabCase(entityName);
      const plural = pluralizeFn(kebab);
      return `/${plural}`;
    },

    cursorRoutePath: columnName => {
      const kebab = inflect.kebabCase(inflect.pascalCase(columnName));
      return `/by-${kebab}`;
    },

    lookupRoutePath: (columnName, paramName) => {
      const kebab = inflect.kebabCase(inflect.pascalCase(columnName));
      return `/by-${kebab}/:${paramName}`;
    },

    functionRoutePath: fnName => {
      const kebab = inflect.kebabCase(fnName);
      return `/${kebab}`;
    },
  };
}

/**
 * Default inflection instance - creates a new instance with standard conventions.
 *
 * Note: This is a getter that returns a fresh instance each time to ensure
 * each usage gets its own registry. For most cases, use createInflection()
 * or makeInflectionLayer() directly.
 */
export const defaultInflection: CoreInflection = createInflection();

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
      folderName: composeFns(pluginDefaults.folderName, userConfig.folderName),
    }).filter(([, v]) => v !== undefined),
  ) as InflectionConfig;
}

/**
 * Compose a CoreInflection with plugin defaults.
 *
 * This is used by PluginRunner to merge plugin's inflectionDefaults
 * with the user's configured inflection.
 *
 * The composed inflection shares the base inflection's registry, so all
 * registrations go to the same place regardless of composition.
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
  const folderFn = pluginDefaults.folderName;

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
    !functionFn &&
    !folderFn
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
    // Share the base inflection's registry
    registry: baseInflection.registry,

    // Primitive transforms (composed if plugin provides them)
    camelCase: baseInflection.camelCase,
    pascalCase: baseInflection.pascalCase,
    pluralize: composedPluralize,
    singularize: composedSingularize,
    safeIdentifier: baseInflection.safeIdentifier,

    // Compose: plugin transforms first, then base transforms
    // Note: base transforms handle registration, so we delegate to them
    entityName: (pgClass, tags) => {
      if (tags.name) return tags.name;
      const afterPlugin = entityFn ? entityFn(pgClass.relname) : pgClass.relname;
      // Delegate to base which handles registration
      return baseInflection.entityName({ ...pgClass, relname: afterPlugin }, {});
    },

    shapeName: (entityName, kind) => {
      // Delegate to base which handles registration
      if (shapeSuffixFn && kind !== "row") {
        // Plugin wants to transform the suffix, but we need base to register
        // We call base shapeName and let it register, but the suffix will be different
        // This is a limitation - plugin suffix transforms bypass registration
        // For now, just return the composed name and register manually
        const name = entityName + shapeSuffixFn(kind);
        baseInflection.registry.register({
          name,
          baseEntity: entityName,
          variant: kind,
          origin: `composed.shapeName(${entityName}, ${kind})`,
        });
        return name;
      }
      return baseInflection.shapeName(entityName, kind);
    },

    fieldName: (pgAttribute, tags) => {
      if (tags.name) return tags.name;
      const afterPlugin = fieldFn ? fieldFn(pgAttribute.attname) : pgAttribute.attname;
      return baseInflection.fieldName({ ...pgAttribute, attname: afterPlugin }, {});
    },

    enumName: (pgType, tags) => {
      if (tags.name) return tags.name;
      const afterPlugin = enumNameFn ? enumNameFn(pgType.typname) : pgType.typname;
      // Delegate to base which handles registration
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
      // Delegate to base which handles registration
      return baseInflection.functionName({ ...pgProc, proname: afterPlugin }, {});
    },

    folderName: entityName => {
      const afterPlugin = folderFn ? folderFn(entityName) : entityName;
      return baseInflection.folderName(afterPlugin);
    },

    // -------------------------------------------------------------------------
    // Semantic methods - delegate to base (these use the composed primitives)
    // -------------------------------------------------------------------------

    kebabCase: baseInflection.kebabCase,
    variableName: baseInflection.variableName,
    entityRoutePath: baseInflection.entityRoutePath,
    cursorRoutePath: baseInflection.cursorRoutePath,
    lookupRoutePath: baseInflection.lookupRoutePath,
    functionRoutePath: baseInflection.functionRoutePath,
  };
}

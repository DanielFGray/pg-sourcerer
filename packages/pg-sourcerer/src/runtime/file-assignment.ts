/**
 * File assignment - assigns symbols to output files based on config rules
 *
 * Key insight: config controls file layout, not plugins. Plugins just declare
 * symbols; this module decides where they go based on capability patterns.
 *
 * The inflection registry is used to determine the base entity for derived
 * names like "UserInsert" → base entity "User". This ensures all shapes
 * for an entity go to the same folder.
 *
 * Users can configure file naming via functions that receive entity info:
 * { pattern: "type:", fileNaming: ({ name, schema }) => `${name.toLowerCase()}.ts` }
 */
import { pipe, Array as Arr, Option } from "effect";
import type { SymbolDeclaration, RenderedSymbol, Capability } from "./types.js";
import type { CoreInflection } from "../services/inflection.js";

/**
 * Minimal input for file assignment.
 * Both SymbolDeclaration and RenderedSymbol satisfy this interface.
 */
export interface FileAssignmentInput {
  readonly name: string;
  readonly capability: Capability;
  readonly baseEntityName?: string;
}

/**
 * Context provided to file naming functions
 */
export interface FileNamingContext {
  /** The symbol name (e.g., "User", "findUserById") */
  readonly name: string;
  /** The entity name extracted from capability (e.g., "User") */
  readonly entityName: string;
  /**
   * The base entity name for file grouping.
   * For shapes like "CommentInsert", this is "Comment".
   * Falls back to entityName if not explicitly set.
   */
  readonly baseEntityName: string;
  /**
   * The folder name derived from baseEntityName via inflection.
   * Default: uncapitalized baseEntityName (User → user, UserEmail → userEmail)
   */
  readonly folderName: string;
  /**
   * The shape variant, if this is a derived name (e.g., "insert", "update").
   * Undefined for base entities, enums, functions.
   */
  readonly variant?: string;
  /** The schema the entity belongs to */
  readonly schema: string;
  /** The full capability string */
  readonly capability: Capability;
}

/**
 * Function that determines the output file path for a symbol.
 * Returns a path relative to the output directory.
 */
export type FileNaming = (context: FileNamingContext) => string;

/**
 * Normalize a file naming option to a FileNaming function.
 * Accepts either a static string or a function.
 * Used by plugins to support flexible config options.
 */
export function normalizeFileNaming(
  option: string | FileNaming | undefined,
  defaultValue: string,
): FileNaming {
  if (option === undefined) return () => defaultValue;
  if (typeof option === "string") return () => option;
  return option;
}

/**
 * A symbol with its assigned output file path.
 */
export interface AssignedSymbol<T extends FileAssignmentInput = SymbolDeclaration> {
  readonly declaration: T;
  readonly filePath: string;
}

/**
 * Configuration for file assignment.
 */
export interface FileAssignmentConfig {
  /** Base output directory */
  readonly outputDir: string;

  /**
   * Rules for assigning capabilities to files.
   * Pattern matches capability prefix, first match wins.
   */
  readonly rules: readonly FileRule[];

  /** Default file naming for unmatched symbols (relative to outputDir) */
  readonly defaultFile?: string;

  /**
   * Inflection service with registry for name lookups.
   * The registry is used to determine baseEntityName for derived names.
   * folderName() transforms baseEntityName to folder format.
   */
  readonly inflection: CoreInflection;
}

/**
 * A rule mapping capability patterns to output files.
 */
export interface FileRule {
  /** Capability pattern to match (prefix matching) */
  readonly pattern: string;
  /** Output subdirectory for this rule's files (relative to outputDir) */
  readonly outputDir?: string;
  /** Function to generate file name from entity info */
  readonly fileNaming: FileNaming;
}

/**
 * Input type for file rules that can be either a simple string or a full FileRule.
 * Used for user config where simple patterns like "types.ts" are more convenient.
 */
export type FileRuleInput =
  | ({ pattern: string; file: string; outputDir?: string })
  | ({ pattern: string; file: FileNaming; outputDir?: string });

/**
 * Convert a FileRuleInput to a full FileRule.
 * If file is a string, creates a function that returns that string.
 */
export function normalizeFileRule(input: FileRuleInput): FileRule {
  const fileValue = input.file;
  if (typeof fileValue === "string") {
    return {
      pattern: input.pattern,
      outputDir: input.outputDir,
      fileNaming: () => fileValue,
    };
  }
  return {
    pattern: input.pattern,
    outputDir: input.outputDir,
    fileNaming: fileValue,
  };
}

/**
 * Merge file rules from plugins with user overrides.
 * User overrides take precedence for matching patterns.
 */
export function mergeFileRules(
  pluginDefaults: readonly FileRule[],
  userOverrides: readonly FileRuleInput[],
): readonly FileRule[] {
  const overridePatterns = new Set(userOverrides.map((o) => o.pattern));

  return [
    ...pluginDefaults.filter((rule) => !overridePatterns.has(rule.pattern)),
    ...userOverrides.map(normalizeFileRule),
  ];
}

/**
 * Extract entity name and schema from a capability string.
 *
 * Capability patterns:
 * - "type:User" → entity is "User"
 * - "type:public.User" → entity is "User", schema is "public"
 * - "types:kysely:User" → entity is "User"
 * - "queries:kysely:User:findById" → entity is "User"
 * - "schema:zod:User" → entity is "User"
 * - "http-routes:elysia:Post" → entity is "Post"
 *
 * The entity is the first PascalCase part after known prefixes and provider names.
 */
export function parseCapabilityInfo(capability: Capability): {
  entityName: string;
  schema: string;
} {
  const parts = capability.split(":");

  // Known category prefixes that should be skipped
  const knownCategories = new Set([
    "type", "types", "schema", "schemas", "query", "queries",
    "http-routes", "http-router", "http",
  ]);

  // Known provider names that should be skipped
  const knownProviders = new Set([
    "kysely", "drizzle", "effect-sql", "sql", "prisma",
    "zod", "arktype", "effect", "valibot", "yup", "typebox",
    "elysia", "hono", "fastify", "express", "trpc",
  ]);

  const isKnownPart = (part: string): boolean => {
    const lower = part.toLowerCase();
    return knownCategories.has(lower) || knownProviders.has(lower);
  };

  // Find the first part that looks like an entity name (not a known prefix/provider)
  return pipe(
    parts,
    Arr.findFirst(part => !isKnownPart(part)),
    Option.map(part => {
      // Check if part contains a schema qualifier (e.g., "public.User")
      if (part.includes(".")) {
        const [schemaPart, entityNamePart] = part.split(".");
        return { entityName: entityNamePart ?? part, schema: schemaPart ?? "public" };
      }
      return { entityName: part, schema: "public" };
    }),
    // Fallback: use the last part
    Option.getOrElse(() => ({
      entityName: parts[parts.length - 1] ?? capability,
      schema: "public",
    })),
  );
}

/**
 * Assign symbols to output files based on config rules.
 *
 * @example
 * const config = {
 *   outputDir: "src/generated",
 *   rules: [
 *     { pattern: "type:", fileNaming: ({ name }) => `${name.toLowerCase()}.ts` },
 *     { pattern: "schema:", fileNaming: ({ name }) => `schemas/${name.toLowerCase()}.ts` },
 *   ],
 * }
 * assignSymbolsToFiles(declarations, config)
 */
export function assignSymbolsToFiles<T extends FileAssignmentInput>(
  declarations: readonly T[],
  config: FileAssignmentConfig,
): readonly AssignedSymbol<T>[] {
  return declarations.map((declaration): AssignedSymbol<T> => {
    const filePath = getFileForCapability(declaration, config);
    return { declaration, filePath };
  });
}

/**
 * Group assigned symbols by file path.
 */
export function groupByFile<T extends FileAssignmentInput>(
  assigned: readonly AssignedSymbol<T>[],
): ReadonlyMap<string, readonly AssignedSymbol<T>[]> {
  return pipe(
    assigned,
    Arr.groupBy(item => item.filePath),
    groups => new Map(Object.entries(groups)),
  );
}

/** Info resolved from registry or capability for file assignment */
interface ResolvedEntityInfo {
  readonly entityName: string;
  readonly baseEntityName: string;
  readonly variant: string | undefined;
  readonly schema: string;
}

/**
 * Resolve entity info from registry or capability parsing.
 */
function resolveEntityInfo(
  declaration: FileAssignmentInput,
  inflection: CoreInflection,
): ResolvedEntityInfo {
  // Try to get entity info from registry first (most accurate)
  const registryInfo = inflection.registry.lookup(declaration.name);

  if (registryInfo) {
    // Registry has accurate info
    const parsed = parseCapabilityInfo(declaration.capability);
    return {
      baseEntityName: registryInfo.baseEntity,
      variant: registryInfo.variant !== "entity" ? registryInfo.variant : undefined,
      entityName: parsed.entityName,
      schema: parsed.schema,
    };
  }

  if (declaration.baseEntityName) {
    // Declaration has explicit baseEntityName - use it for both
    const parsed = parseCapabilityInfo(declaration.capability);
    return {
      baseEntityName: declaration.baseEntityName,
      entityName: declaration.baseEntityName,
      variant: undefined,
      schema: parsed.schema,
    };
  }

  // Fallback: parse from capability (legacy behavior)
  const parsed = parseCapabilityInfo(declaration.capability);
  return {
    entityName: parsed.entityName,
    baseEntityName: parsed.entityName,
    variant: undefined,
    schema: parsed.schema,
  };
}

/**
 * Find which file a capability would be assigned to.
 * Returns a path relative to the output directory.
 *
 * Uses the inflection registry to determine the base entity for derived names.
 * For example, "UserInsert" → baseEntity "User", so all User shapes go to
 * the same folder.
 */
export function getFileForCapability(
  declaration: FileAssignmentInput & { outputPath?: string },
  config: FileAssignmentConfig,
): string {
  // If declaration has explicit outputPath, use it directly (SymbolDeclaration only)
  if ("outputPath" in declaration && declaration.outputPath) {
    return declaration.outputPath;
  }

  const { entityName, baseEntityName, variant, schema } = resolveEntityInfo(
    declaration,
    config.inflection,
  );

  // Compute folderName via inflection
  const folderName = config.inflection.folderName(baseEntityName);

  const context: FileNamingContext = {
    name: declaration.name,
    entityName,
    baseEntityName,
    folderName,
    variant,
    schema,
    capability: declaration.capability,
  };

  return pipe(
    config.rules,
    Arr.findFirst(rule => declaration.capability.startsWith(rule.pattern)),
    Option.map(rule => {
      const fileName = rule.fileNaming(context);
      const baseDir = rule.outputDir ?? "";
      return baseDir ? `${baseDir}/${fileName}` : fileName;
    }),
    Option.orElse(() => Option.fromNullable(config.defaultFile)),
    Option.getOrElse(() => {
      throw new Error(
        `No file rule matches capability "${declaration.capability}" and no default file is configured`,
      );
    }),
  );
}

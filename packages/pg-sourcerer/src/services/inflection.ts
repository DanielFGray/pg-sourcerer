/**
 * Core Inflection Service - naming transformations
 */
import { Context, Layer, String as Str } from "effect";
import type { PgAttribute, PgClass, PgConstraint, PgType } from "pg-introspection";
import type { SmartTags, ShapeKind } from "../ir/index.js";

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
  readonly relationName: (
    constraint: PgConstraint,
    side: "local" | "foreign",
    tags: SmartTags,
  ) => string;
}

/** Service tag */
export class Inflection extends Context.Tag("Inflection")<Inflection, CoreInflection>() {}

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
    return word + "es";
  }
  if (word.endsWith("y") && !/[aeiou]y$/i.test(word)) {
    return word.slice(0, -1) + "ies";
  }
  return word + "s";
};

const singularize = (word: string): string => {
  if (word.endsWith("ies") && word.length > 3) {
    return word.slice(0, -3) + "y";
  }
  if (
    word.endsWith("es") &&
    (word.endsWith("sses") ||
      word.endsWith("xes") ||
      word.endsWith("zes") ||
      word.endsWith("ches") ||
      word.endsWith("shes"))
  ) {
    return word.slice(0, -2);
  }
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 1) {
    return word.slice(0, -1);
  }
  return word;
};

// ============================================================================
// Live Implementation
// ============================================================================

export const liveInflection: CoreInflection = {
  camelCase: Str.snakeToCamel,

  pascalCase: Str.snakeToPascal,

  pluralize,

  singularize,

  safeIdentifier: text => (RESERVED_WORDS.has(text) ? text + "_" : text),

  entityName: (pgClass, tags) => tags.name ?? Str.snakeToPascal(singularize(pgClass.relname)),

  shapeName: (entityName, kind) => entityName + Str.capitalize(kind),

  fieldName: (pgAttribute, tags) => tags.name ?? Str.snakeToCamel(pgAttribute.attname),

  enumName: (pgType, tags) => tags.name ?? Str.snakeToPascal(pgType.typname),

  enumValueName: value => value, // Keep original value

  relationName: (constraint, side, tags) => {
    // Use explicit tag if provided
    if (side === "local" && tags.fieldName) return tags.fieldName;
    if (side === "foreign" && tags.foreignFieldName) return tags.foreignFieldName;

    // Derive from constraint name (e.g., "posts_author_id_fkey" → "author")
    const name = constraint.conname;
    // Remove common suffixes and table prefixes
    const cleaned = name
      .replace(/_fkey$/, "")
      .replace(/_id$/, "")
      .replace(/^[^_]+_/, ""); // Remove table prefix

    return Str.snakeToCamel(cleaned);
  },
};

export const InflectionLive = Layer.succeed(Inflection, liveInflection);

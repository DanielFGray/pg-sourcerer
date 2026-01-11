/**
 * Shared utilities for Kysely code generation
 */
import type { namedTypes as n } from "ast-types"
import { conjure } from "../../lib/conjure.js"

const { ts } = conjure

// ============================================================================
// PostgreSQL Type Mappings (ported from kysely-codegen postgres-adapter)
// ============================================================================

/**
 * Simple scalar mappings: PG type name → TS type
 * These don't need ColumnType wrapper.
 */
export const SCALAR_TYPES: Record<string, () => n.TSType> = {
  // Boolean
  bool: ts.boolean,

  // Integers → number
  int2: ts.number,
  int4: ts.number,
  float4: ts.number,
  float8: ts.number,
  oid: ts.number,

  // Text types → string
  text: ts.string,
  varchar: ts.string,
  bpchar: ts.string, // blank-padded char
  char: ts.string,
  name: ts.string,
  bit: ts.string,
  varbit: ts.string,
  xml: ts.string,

  // UUID → string
  uuid: ts.string,

  // Network types → string
  inet: ts.string,
  cidr: ts.string,
  macaddr: ts.string,
  macaddr8: ts.string,

  // Geometric types → string (typically serialized)
  line: ts.string,
  lseg: ts.string,
  box: ts.string,
  path: ts.string,
  polygon: ts.string,

  // Time without date → string
  time: ts.string,
  timetz: ts.string,

  // Full-text search → string
  tsvector: ts.string,
  tsquery: ts.string,
  txid_snapshot: ts.string,

  // Money → string
  money: ts.string,

  // Binary → Buffer
  bytea: () => ts.ref("Buffer"),
}

/**
 * Complex types that need ColumnType<Select, Insert, Update> wrapper.
 * These have different types for select vs insert/update.
 */
export interface ComplexTypeMapping {
  /** Select type (what you get back) */
  readonly select: () => n.TSType
  /** Insert type (what you can provide) */
  readonly insert: () => n.TSType
  /** Update type (what you can provide) */
  readonly update: () => n.TSType
  /** External import required */
  readonly import?: { name: string; from: string }
}

export const COMPLEX_TYPES: Record<string, ComplexTypeMapping> = {
  // int8/bigint: returns string (to avoid precision loss), accepts string|number|bigint
  int8: {
    select: ts.string,
    insert: () => ts.union(ts.string(), ts.number(), ts.bigint()),
    update: () => ts.union(ts.string(), ts.number(), ts.bigint()),
  },

  // numeric/decimal: returns string, accepts number|string
  numeric: {
    select: ts.string,
    insert: () => ts.union(ts.number(), ts.string()),
    update: () => ts.union(ts.number(), ts.string()),
  },

  // Timestamps: returns Date, accepts Date|string
  date: {
    select: () => ts.ref("Date"),
    insert: () => ts.union(ts.ref("Date"), ts.string()),
    update: () => ts.union(ts.ref("Date"), ts.string()),
  },
  timestamp: {
    select: () => ts.ref("Date"),
    insert: () => ts.union(ts.ref("Date"), ts.string()),
    update: () => ts.union(ts.ref("Date"), ts.string()),
  },
  timestamptz: {
    select: () => ts.ref("Date"),
    insert: () => ts.union(ts.ref("Date"), ts.string()),
    update: () => ts.union(ts.ref("Date"), ts.string()),
  },

  // Interval: For now, defer to string until we decide on postgres-interval
  interval: {
    select: ts.string,
    insert: () => ts.union(ts.string(), ts.number()),
    update: () => ts.union(ts.string(), ts.number()),
  },

  // JSON: returns JsonValue, accepts JsonValue
  json: {
    select: () => ts.ref("JsonValue"),
    insert: () => ts.ref("JsonValue"),
    update: () => ts.ref("JsonValue"),
  },
  jsonb: {
    select: () => ts.ref("JsonValue"),
    insert: () => ts.ref("JsonValue"),
    update: () => ts.ref("JsonValue"),
  },

  // Geometric: Point and Circle have object representations
  point: {
    select: () =>
      ts.objectType([
        { name: "x", type: ts.number() },
        { name: "y", type: ts.number() },
      ]),
    insert: () =>
      ts.objectType([
        { name: "x", type: ts.number() },
        { name: "y", type: ts.number() },
      ]),
    update: () =>
      ts.objectType([
        { name: "x", type: ts.number() },
        { name: "y", type: ts.number() },
      ]),
  },
  circle: {
    select: () =>
      ts.objectType([
        { name: "x", type: ts.number() },
        { name: "y", type: ts.number() },
        { name: "radius", type: ts.number() },
      ]),
    insert: () =>
      ts.objectType([
        { name: "x", type: ts.number() },
        { name: "y", type: ts.number() },
        { name: "radius", type: ts.number() },
      ]),
    update: () =>
      ts.objectType([
        { name: "x", type: ts.number() },
        { name: "y", type: ts.number() },
        { name: "radius", type: ts.number() },
      ]),
  },
}

// ============================================================================
// Helper Type Definitions (ported from kysely-codegen)
// ============================================================================

/**
 * Build Generated<T> type alias as raw TypeScript string.
 *
 * Generated marks columns that have defaults and don't need to be provided on insert.
 *
 * type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
 *   ? ColumnType<S, I | undefined, U>
 *   : ColumnType<T, T | undefined, T>;
 */
export const GENERATED_TYPE_DEF = `T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>`

/**
 * Build ArrayType<T> helper for complex array types.
 *
 * type ArrayType<T> = ArrayTypeImpl<T> extends (infer U)[]
 *   ? U[]
 *   : ArrayTypeImpl<T>;
 */
export const ARRAY_TYPE_DEF = `ArrayTypeImpl<T> extends (infer U)[]
  ? U[]
  : ArrayTypeImpl<T>`

/**
 * Build ArrayTypeImpl<T> helper.
 *
 * type ArrayTypeImpl<T> = T extends ColumnType<infer S, infer I, infer U>
 *   ? ColumnType<S[], I[], U[]>
 *   : T[];
 */
export const ARRAY_TYPE_IMPL_DEF = `T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S[], I[], U[]>
  : T[]`

// ============================================================================
// PostgreSQL Type Name to TypeScript Mapping (for queries)
// ============================================================================

/**
 * Map PostgreSQL type name to TypeScript type string.
 * Used for function argument and return type resolution.
 */
export const pgTypeNameToTs = (typeName: string): string => {
  // Normalize: strip schema prefix if present
  const baseName = typeName.includes(".") ? typeName.split(".").pop()! : typeName

  switch (baseName) {
    // Boolean
    case "bool":
    case "boolean":
      return "boolean"

    // Integer types → number
    case "int2":
    case "smallint":
    case "int4":
    case "integer":
    case "int":
    case "oid":
    case "float4":
    case "real":
    case "float8":
    case "double precision":
      return "number"

    // Big integers/numeric → string (to avoid precision loss)
    case "int8":
    case "bigint":
    case "numeric":
    case "decimal":
    case "money":
      return "string"

    // Text types → string
    case "text":
    case "varchar":
    case "character varying":
    case "char":
    case "character":
    case "bpchar":
    case "name":
    case "xml":
    case "bit":
    case "varbit":
    case "bit varying":
    case "uuid":
    case "inet":
    case "cidr":
    case "macaddr":
    case "macaddr8":
    case "time":
    case "timetz":
    case "time with time zone":
    case "time without time zone":
    case "interval":
      return "string"

    // Date/Time with date component → Date
    case "date":
    case "timestamp":
    case "timestamptz":
    case "timestamp with time zone":
    case "timestamp without time zone":
      return "Date"

    // JSON → unknown
    case "json":
    case "jsonb":
    case "jsonpath":
      return "unknown"

    // Binary → Buffer
    case "bytea":
      return "Buffer"

    // Void
    case "void":
      return "void"

    // Default to unknown
    default:
      return "unknown"
  }
}

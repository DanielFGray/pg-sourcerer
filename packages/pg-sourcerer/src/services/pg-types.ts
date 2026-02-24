/**
 * PostgreSQL Type Mapping Utilities
 *
 * Provides well-known PostgreSQL type OIDs and a default mapping to TypeScript types.
 * Plugins can use these as a starting point and override as needed.
 */
import { Array as Arr, Option, pipe, Match } from "effect";

/**
 * Well-known PostgreSQL built-in type OIDs.
 * These are stable across PostgreSQL versions.
 */
export const PgTypeOid = {
  // Boolean
  Bool: 16,

  // Numeric
  Int2: 21,
  Int4: 23,
  Int8: 20,
  Float4: 700,
  Float8: 701,
  Numeric: 1700,

  // Text
  Char: 18,
  BpChar: 1042, // blank-padded char
  VarChar: 1043,
  Text: 25,
  Name: 19,

  // Binary
  Bytea: 17,

  // Date/Time
  Date: 1082,
  Time: 1083,
  TimeTz: 1266,
  Timestamp: 1114,
  TimestampTz: 1184,
  Interval: 1186,

  // Network
  Inet: 869,
  Cidr: 650,
  MacAddr: 829,
  MacAddr8: 774,

  // UUID
  Uuid: 2950,

  // JSON
  Json: 114,
  JsonB: 3802,
  JsonPath: 4072,

  // Geometric
  Point: 600,
  Line: 628,
  LSeg: 601,
  Box: 603,
  Path: 602,
  Polygon: 604,
  Circle: 718,

  // Ranges
  Int4Range: 3904,
  Int8Range: 3926,
  NumRange: 3906,
  TsRange: 3908,
  TsTzRange: 3910,
  DateRange: 3912,

  // Other
  Oid: 26,
  Xml: 142,
  Money: 790,
  Bit: 1560,
  VarBit: 1562,
  TsVector: 3614,
  TsQuery: 3615,
} as const;

export type PgTypeOid = (typeof PgTypeOid)[keyof typeof PgTypeOid];

/**
 * TypeScript primitive types for code generation
 */
export const TsType = {
  String: "string",
  Number: "number",
  Boolean: "boolean",
  BigInt: "bigint",
  Date: "Date",
  Buffer: "Buffer",
  Unknown: "unknown",
  Null: "null",
} as const;

export type TsType = (typeof TsType)[keyof typeof TsType];

/**
 * Result of resolving a PostgreSQL type to TypeScript
 */
export interface TypeMappingResult {
  /** The TypeScript type string */
  readonly tsType: string;
  /** Whether this is an enum type from the IR */
  readonly isEnum: boolean;
  /** If isEnum, the enum name from IR */
  readonly enumName?: string;
  /** Whether this is an array type */
  readonly isArray: boolean;
}

/**
 * Declarative mapping from PostgreSQL type OID to TypeScript type.
 * Organized by category for maintainability.
 */
const PgToTsMapping: ReadonlyMap<number, TsType> = new Map([
  // Boolean
  [PgTypeOid.Bool, TsType.Boolean],

  // Integer types → number
  [PgTypeOid.Int2, TsType.Number],
  [PgTypeOid.Int4, TsType.Number],
  [PgTypeOid.Oid, TsType.Number],

  // Floating point → number
  [PgTypeOid.Float4, TsType.Number],
  [PgTypeOid.Float8, TsType.Number],

  // Big integers → string (to avoid precision loss)
  // Plugins like Kysely may override to bigint
  [PgTypeOid.Int8, TsType.String],
  [PgTypeOid.Numeric, TsType.String],
  [PgTypeOid.Money, TsType.String],

  // Text types → string
  [PgTypeOid.Char, TsType.String],
  [PgTypeOid.BpChar, TsType.String],
  [PgTypeOid.VarChar, TsType.String],
  [PgTypeOid.Text, TsType.String],
  [PgTypeOid.Name, TsType.String],
  [PgTypeOid.Xml, TsType.String],
  [PgTypeOid.Bit, TsType.String],
  [PgTypeOid.VarBit, TsType.String],

  // UUID → string
  [PgTypeOid.Uuid, TsType.String],

  // Network types → string
  [PgTypeOid.Inet, TsType.String],
  [PgTypeOid.Cidr, TsType.String],
  [PgTypeOid.MacAddr, TsType.String],
  [PgTypeOid.MacAddr8, TsType.String],

  // Date/Time with date component → Date
  [PgTypeOid.Date, TsType.Date],
  [PgTypeOid.Timestamp, TsType.Date],
  [PgTypeOid.TimestampTz, TsType.Date],

  // Time without date → string
  [PgTypeOid.Time, TsType.String],
  [PgTypeOid.TimeTz, TsType.String],
  [PgTypeOid.Interval, TsType.String],

  // JSON → unknown
  [PgTypeOid.Json, TsType.Unknown],
  [PgTypeOid.JsonB, TsType.Unknown],
  [PgTypeOid.JsonPath, TsType.Unknown],

  // Binary → Buffer
  [PgTypeOid.Bytea, TsType.Buffer],

  // Geometric types → string (typically serialized)
  [PgTypeOid.Point, TsType.String],
  [PgTypeOid.Line, TsType.String],
  [PgTypeOid.LSeg, TsType.String],
  [PgTypeOid.Box, TsType.String],
  [PgTypeOid.Path, TsType.String],
  [PgTypeOid.Polygon, TsType.String],
  [PgTypeOid.Circle, TsType.String],

  // Range types → string
  [PgTypeOid.Int4Range, TsType.String],
  [PgTypeOid.Int8Range, TsType.String],
  [PgTypeOid.NumRange, TsType.String],
  [PgTypeOid.TsRange, TsType.String],
  [PgTypeOid.TsTzRange, TsType.String],
  [PgTypeOid.DateRange, TsType.String],

  // Full-text search → string
  [PgTypeOid.TsVector, TsType.String],
  [PgTypeOid.TsQuery, TsType.String],
]);

/**
 * Default mapping from PostgreSQL type OID to TypeScript type.
 *
 * Plugins can use this as a base and override specific mappings.
 * Returns undefined for unmapped types (enums, domains, custom types).
 */
export function defaultPgToTs(oid: number): Option.Option<TsType> {
  return Option.fromNullable(PgToTsMapping.get(oid));
}

/**
 * Type mapper function signature.
 * Takes an OID and returns an Option of TypeScript type string.
 */
export type TypeMapper = (oid: number) => Option.Option<string>;

/**
 * Compose multiple type mappers into one.
 * Earlier mappers take precedence (first Some wins).
 *
 * @example
 * ```typescript
 * const kyselyMapper = composeMappers(
 *   // Override bigint handling
 *   (oid) => oid === PgTypeOid.Int8 ? Option.some("bigint") : Option.none(),
 *   // Fall back to defaults
 *   defaultPgToTs
 * )
 * ```
 */
export function composeMappers(...mappers: TypeMapper[]): TypeMapper {
  return (oid: number) =>
    pipe(
      mappers,
      Arr.findFirst(mapper => Option.isSome(mapper(oid))),
      Option.flatMap(mapper => mapper(oid)),
    );
}

/**
 * Wrap a type string as an array type if needed.
 */
export function wrapArrayType(baseType: string, isArray: boolean): string {
  return isArray ? `${baseType}[]` : baseType;
}

/**
 * Wrap a type string as nullable if needed.
 */
export function wrapNullable(
  baseType: string,
  nullable: boolean,
  style: "union" | "optional" = "union",
): string {
  if (!nullable) return baseType;
  return style === "union" ? `${baseType} | null` : `${baseType}?`;
}

/**
 * Result of looking up an enum in the IR
 */
export interface EnumLookupResult {
  /** The inflected TypeScript enum name */
  readonly name: string;
  /** The original PostgreSQL enum name */
  readonly pgName: string;
  /** The enum values */
  readonly values: readonly string[];
}

// ============================================================================
// Extension Type Mapping
// ============================================================================

/**
 * Minimal extension info needed for type mapping
 */
export interface ExtensionInfo {
  readonly name: string;
  readonly namespaceOid: string;
}

/**
 * Known PostgreSQL extension types and their TypeScript mappings.
 * Key is extension name, value maps type names to TS types.
 */
export const ExtensionTypeMap: Readonly<Record<string, Readonly<Record<string, TsType>>>> = {
  citext: {
    citext: TsType.String,
  },
  // Add more extensions as needed (hstore, ltree, postgis, etc.)
};

/**
 * Look up a type's TypeScript mapping by checking if it belongs to a known extension.
 *
 * This handles extension types like citext where OIDs are dynamically assigned
 * and not stable across PostgreSQL installations.
 *
 * @param typeName - The PostgreSQL type name (e.g., "citext")
 * @param typeNamespaceOid - The namespace OID of the type
 * @param extensions - Array of extension info from introspection
 * @returns The TypeScript type if found, undefined otherwise
 *
 * @example
 * ```typescript
 * const pgType = field.pgAttribute.getType()
 * if (pgType) {
 *   const tsType = getExtensionTypeMapping(
 *     pgType.typname,
 *     String(pgType.typnamespace),
 *     ir.extensions
 *   )
 *   if (tsType) {
 *     // Use tsType for code generation
 *   }
 * }
 * ```
 */
export function getExtensionTypeMapping(
  typeName: string,
  typeNamespaceOid: string,
  extensions: readonly ExtensionInfo[],
): Option.Option<TsType> {
  return pipe(
    extensions,
    Arr.filter(ext => ext.namespaceOid === typeNamespaceOid),
    Arr.findFirst(ext => {
      const extTypeMap = ExtensionTypeMap[ext.name];
      return extTypeMap !== undefined && extTypeMap[typeName] !== undefined;
    }),
    Option.flatMap(ext => Option.fromNullable(ExtensionTypeMap[ext.name])),
    Option.flatMap(extTypeMap => Option.fromNullable(extTypeMap[typeName])),
  );
}

// ============================================================================
// Enum Lookup
// ============================================================================

/**
 * Find an enum in the IR by its PostgreSQL type name.
 *
 * @param enums - Array of enum entities or iterable of enums
 * @param pgTypeName - The PostgreSQL type name (e.g., "user_role")
 * @returns The enum definition if found, undefined otherwise
 *
 * @example
 * ```typescript
 * const pgType = field.pgAttribute.getType()
 * if (pgType?.typtype === 'e') {
 *   const enumDef = findEnumByPgName(getEnumEntities(ir), pgType.typname)
 *   if (enumDef) {
 *     return enumDef.name // Use inflected name like "UserRole"
 *   }
 * }
 * ```
 */
export function findEnumByPgName(
  enums: Iterable<{
    readonly pgName: string;
    readonly name: string;
    readonly values: readonly string[];
  }>,
  pgTypeName: string,
): Option.Option<EnumLookupResult> {
  return pipe(
    Array.from(enums),
    Arr.findFirst(enumDef => enumDef.pgName === pgTypeName),
    Option.map(enumDef => ({
      name: enumDef.name,
      pgName: enumDef.pgName,
      values: enumDef.values,
    })),
  );
}

// ============================================================================
// Composite Lookup
// ============================================================================

/**
 * Result of looking up a composite in the IR
 */
export interface CompositeLookupResult {
  /** The inflected TypeScript type name */
  readonly name: string;
  /** The original PostgreSQL composite type name */
  readonly pgName: string;
}

/**
 * Find a composite type in the IR by its PostgreSQL type name.
 *
 * @param composites - Iterable of composite entities
 * @param pgTypeName - The PostgreSQL type name (e.g., "username_search")
 * @returns The composite definition if found, None otherwise
 *
 * @example
 * ```typescript
 * const pgType = field.pgAttribute.getType()
 * if (pgType?.typtype === 'c') {
 *   const compositeDef = findCompositeByPgName(getCompositeEntities(ir), pgType.typname)
 *   if (Option.isSome(compositeDef)) {
 *     return compositeDef.value.name // Use inflected name like "UsernameSearch"
 *   }
 * }
 * ```
 */
export function findCompositeByPgName(
  composites: Iterable<{ readonly pgName: string; readonly name: string }>,
  pgTypeName: string,
): Option.Option<CompositeLookupResult> {
  return pipe(
    Array.from(composites),
    Arr.findFirst(composite => composite.pgName === pgTypeName),
    Option.map(composite => ({
      name: composite.name,
      pgName: composite.pgName,
    })),
  );
}

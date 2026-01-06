/**
 * PostgreSQL Type Mapping Utilities
 *
 * Provides well-known PostgreSQL type OIDs and a default mapping to TypeScript types.
 * Plugins can use these as a starting point and override as needed.
 */

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
} as const

export type PgTypeOid = (typeof PgTypeOid)[keyof typeof PgTypeOid]

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
} as const

export type TsType = (typeof TsType)[keyof typeof TsType]

/**
 * Result of resolving a PostgreSQL type to TypeScript
 */
export interface TypeMappingResult {
  /** The TypeScript type string */
  readonly tsType: string
  /** Whether this is an enum type from the IR */
  readonly isEnum: boolean
  /** If isEnum, the enum name from IR */
  readonly enumName?: string
  /** Whether this is an array type */
  readonly isArray: boolean
}

/**
 * Default mapping from PostgreSQL type OID to TypeScript type.
 *
 * Plugins can use this as a base and override specific mappings.
 * Returns undefined for unmapped types (enums, domains, custom types).
 */
export function defaultPgToTs(oid: number): TsType | undefined {
  switch (oid) {
    // Boolean
    case PgTypeOid.Bool:
      return TsType.Boolean

    // Integer types → number
    case PgTypeOid.Int2:
    case PgTypeOid.Int4:
    case PgTypeOid.Oid:
      return TsType.Number

    // Floating point → number
    case PgTypeOid.Float4:
    case PgTypeOid.Float8:
      return TsType.Number

    // Big integers → string (to avoid precision loss)
    // Plugins like Kysely may override to bigint
    case PgTypeOid.Int8:
    case PgTypeOid.Numeric:
    case PgTypeOid.Money:
      return TsType.String

    // Text types → string
    case PgTypeOid.Char:
    case PgTypeOid.BpChar:
    case PgTypeOid.VarChar:
    case PgTypeOid.Text:
    case PgTypeOid.Name:
    case PgTypeOid.Xml:
    case PgTypeOid.Bit:
    case PgTypeOid.VarBit:
      return TsType.String

    // UUID → string
    case PgTypeOid.Uuid:
      return TsType.String

    // Network types → string
    case PgTypeOid.Inet:
    case PgTypeOid.Cidr:
    case PgTypeOid.MacAddr:
    case PgTypeOid.MacAddr8:
      return TsType.String

    // Date/Time with date component → Date
    case PgTypeOid.Date:
    case PgTypeOid.Timestamp:
    case PgTypeOid.TimestampTz:
      return TsType.Date

    // Time without date → string
    case PgTypeOid.Time:
    case PgTypeOid.TimeTz:
    case PgTypeOid.Interval:
      return TsType.String

    // JSON → unknown
    case PgTypeOid.Json:
    case PgTypeOid.JsonB:
    case PgTypeOid.JsonPath:
      return TsType.Unknown

    // Binary → Buffer
    case PgTypeOid.Bytea:
      return TsType.Buffer

    // Geometric types → string (typically serialized)
    case PgTypeOid.Point:
    case PgTypeOid.Line:
    case PgTypeOid.LSeg:
    case PgTypeOid.Box:
    case PgTypeOid.Path:
    case PgTypeOid.Polygon:
    case PgTypeOid.Circle:
      return TsType.String

    // Range types → string
    case PgTypeOid.Int4Range:
    case PgTypeOid.Int8Range:
    case PgTypeOid.NumRange:
    case PgTypeOid.TsRange:
    case PgTypeOid.TsTzRange:
    case PgTypeOid.DateRange:
      return TsType.String

    // Full-text search → string
    case PgTypeOid.TsVector:
    case PgTypeOid.TsQuery:
      return TsType.String

    default:
      return undefined
  }
}

/**
 * Type mapper function signature.
 * Takes an OID and returns a TypeScript type string, or undefined to fall through.
 */
export type TypeMapper = (oid: number) => string | undefined

/**
 * Compose multiple type mappers into one.
 * Earlier mappers take precedence (first non-undefined wins).
 *
 * @example
 * ```typescript
 * const kyselyMapper = composeMappers(
 *   // Override bigint handling
 *   (oid) => oid === PgTypeOid.Int8 ? "bigint" : undefined,
 *   // Fall back to defaults
 *   defaultPgToTs
 * )
 * ```
 */
export function composeMappers(...mappers: TypeMapper[]): TypeMapper {
  return (oid: number) => {
    for (const mapper of mappers) {
      const result = mapper(oid)
      if (result !== undefined) {
        return result
      }
    }
    return undefined
  }
}

/**
 * Wrap a type string as an array type if needed.
 */
export function wrapArrayType(baseType: string, isArray: boolean): string {
  return isArray ? `${baseType}[]` : baseType
}

/**
 * Wrap a type string as nullable if needed.
 */
export function wrapNullable(
  baseType: string,
  nullable: boolean,
  style: "union" | "optional" = "union"
): string {
  if (!nullable) return baseType
  return style === "union" ? `${baseType} | null` : `${baseType}?`
}

/**
 * Result of looking up an enum in the IR
 */
export interface EnumLookupResult {
  /** The inflected TypeScript enum name */
  readonly name: string
  /** The original PostgreSQL enum name */
  readonly pgName: string
  /** The enum values */
  readonly values: readonly string[]
}

// ============================================================================
// Extension Type Mapping
// ============================================================================

/**
 * Minimal extension info needed for type mapping
 */
export interface ExtensionInfo {
  readonly name: string
  readonly namespaceOid: string
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
}

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
  extensions: ReadonlyArray<ExtensionInfo>
): TsType | undefined {
  // Find extension that owns this namespace and has a mapping for this type
  for (const ext of extensions) {
    if (ext.namespaceOid === typeNamespaceOid) {
      const extTypeMap = ExtensionTypeMap[ext.name]
      if (extTypeMap && typeName in extTypeMap) {
        return extTypeMap[typeName]
      }
    }
  }
  return undefined
}

// ============================================================================
// Enum Lookup
// ============================================================================

/**
 * Find an enum in the IR by its PostgreSQL type name.
 *
 * @param enums - The enums map from SemanticIR
 * @param pgTypeName - The PostgreSQL type name (e.g., "user_role")
 * @returns The enum definition if found, undefined otherwise
 *
 * @example
 * ```typescript
 * const pgType = field.pgAttribute.getType()
 * if (pgType?.typtype === 'e') {
 *   const enumDef = findEnumByPgName(ctx.ir.enums, pgType.typname)
 *   if (enumDef) {
 *     return enumDef.name // Use inflected name like "UserRole"
 *   }
 * }
 * ```
 */
export function findEnumByPgName(
  enums: ReadonlyMap<string, { readonly pgName: string; readonly name: string; readonly values: readonly string[] }>,
  pgTypeName: string
): EnumLookupResult | undefined {
  for (const enumDef of enums.values()) {
    if (enumDef.pgName === pgTypeName) {
      return {
        name: enumDef.name,
        pgName: enumDef.pgName,
        values: enumDef.values,
      }
    }
  }
  return undefined
}

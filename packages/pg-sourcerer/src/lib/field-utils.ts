/**
 * Field Utilities - Shared helpers for inspecting Field types
 *
 * These utilities extract type information from Field objects for use
 * by code generation plugins. Each plugin transforms the resolved types
 * into their specific output format (TypeScript types, Zod schemas, etc.)
 */
import { Option, pipe } from "effect"
import type { Field, EnumDef, ExtensionInfo } from "../ir/semantic-ir.js"
import {
  defaultPgToTs,
  findEnumByPgName,
  getExtensionTypeMapping,
  TsType,
  PgTypeOid,
} from "../services/pg-types.js"
import type { EnumLookupResult } from "../services/pg-types.js"

// =============================================================================
// Field Inspection - Basic type checks
// =============================================================================

/**
 * Get the PostgreSQL type OID from a field's pg attribute
 */
export function getTypeOid(field: Field): number | undefined {
  const pgType = field.pgAttribute.getType()
  if (!pgType?._id) return undefined
  return Number(pgType._id)
}

/**
 * Check if a field's type is an enum
 */
export function isEnumType(field: Field): boolean {
  const pgType = field.pgAttribute.getType()
  return pgType?.typtype === "e"
}

/**
 * Get the PostgreSQL type name from a field.
 * For arrays, returns the element type name (not the array type like _int4).
 */
export function getPgTypeName(field: Field): string | undefined {
  if (field.isArray && field.elementTypeName) {
    return field.elementTypeName
  }
  return field.pgAttribute.getType()?.typname
}

/**
 * Check if this field is a UUID type
 */
export function isUuidType(field: Field): boolean {
  const oid = getTypeOid(field)
  return oid === PgTypeOid.Uuid
}

/**
 * Check if this field is a date/timestamp type
 */
export function isDateType(field: Field): boolean {
  const oid = getTypeOid(field)
  return oid === PgTypeOid.Date || oid === PgTypeOid.Timestamp || oid === PgTypeOid.TimestampTz
}

/**
 * Check if this field is a bigint type (int8)
 */
export function isBigIntType(field: Field): boolean {
  const oid = getTypeOid(field)
  return oid === PgTypeOid.Int8
}

// =============================================================================
// Type Resolution - Determine the TypeScript type for a field
// =============================================================================

/**
 * Result of resolving a field's type
 */
export interface ResolvedType {
  /** The resolved TypeScript type */
  tsType: TsType
  /** If resolved to an enum, the enum lookup result */
  enumDef?: EnumLookupResult
}

/**
 * Resolve a field to its TypeScript type.
 *
 * Resolution order:
 * 1. Enum type
 * 2. OID-based mapping (built-in PostgreSQL types)
 * 3. Domain base type mapping
 * 4. Extension type mapping (e.g., citext, ltree)
 * 5. Array element type mapping
 * 6. Fallback to unknown
 *
 * Note: This returns the base type. Callers handle:
 * - Array wrapping (field.isArray)
 * - Nullability (field.nullable)
 * - Optionality (field.optional)
 */
export function resolveFieldType(
  field: Field,
  enums: Iterable<EnumDef>,
  extensions: readonly ExtensionInfo[]
): ResolvedType {
  // 1. Check for enum
  if (isEnumType(field)) {
    const enumResult = pipe(
      Option.fromNullable(getPgTypeName(field)),
      Option.flatMap((pgTypeName) => findEnumByPgName(enums, pgTypeName)),
      Option.map((enumDef): ResolvedType => ({
        // Enum types don't have a TsType - they're custom types
        // Return Unknown as placeholder, caller uses enumDef
        tsType: TsType.Unknown,
        enumDef,
      }))
    )
    if (Option.isSome(enumResult)) {
      return enumResult.value
    }
  }

  // 2. Try OID-based mapping (built-in PostgreSQL types)
  const oid = getTypeOid(field)
  if (oid !== undefined) {
    const tsTypeOpt = defaultPgToTs(oid)
    if (Option.isSome(tsTypeOpt)) {
      return { tsType: tsTypeOpt.value }
    }
  }

  // 3. Try domain base type mapping
  if (field.domainBaseType) {
    const tsTypeOpt = defaultPgToTs(field.domainBaseType.typeOid)
    if (Option.isSome(tsTypeOpt)) {
      return { tsType: tsTypeOpt.value }
    }
  }

  // 4. Try extension-based mapping for the direct type
  const pgType = field.pgAttribute.getType()
  if (pgType) {
    const tsTypeOpt = getExtensionTypeMapping(
      pgType.typname,
      String(pgType.typnamespace),
      extensions
    )
    if (Option.isSome(tsTypeOpt)) {
      return { tsType: tsTypeOpt.value }
    }
  }

  // Try extension-based mapping for domain base types
  if (field.domainBaseType) {
    const tsTypeOpt = getExtensionTypeMapping(
      field.domainBaseType.typeName,
      field.domainBaseType.namespaceOid,
      extensions
    )
    if (Option.isSome(tsTypeOpt)) {
      return { tsType: tsTypeOpt.value }
    }
  }

  // 5. For arrays, try to resolve element type
  if (field.isArray && field.elementTypeName) {
    // Check if element is an enum
    const enumDefOpt = findEnumByPgName(enums, field.elementTypeName)
    if (Option.isSome(enumDefOpt)) {
      return { tsType: TsType.Unknown, enumDef: enumDefOpt.value }
    }

    // Try extension-based mapping for array element type
    if (pgType?.typnamespace) {
      const tsTypeOpt = getExtensionTypeMapping(
        field.elementTypeName,
        String(pgType.typnamespace),
        extensions
      )
      if (Option.isSome(tsTypeOpt)) {
        return { tsType: tsTypeOpt.value }
      }
    }
  }

  // 6. Fallback to unknown
  return { tsType: TsType.Unknown }
}

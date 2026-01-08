/**
 * Field Utilities - Shared helpers for inspecting Field types
 *
 * These utilities extract type information from Field objects for use
 * by code generation plugins. Each plugin transforms the resolved types
 * into their specific output format (TypeScript types, Zod schemas, etc.)
 */
import { Option, pipe } from "effect"
import type { namedTypes as n } from "ast-types"
import type { Field, EnumEntity, ExtensionInfo } from "../ir/semantic-ir.js"
import {
  defaultPgToTs,
  findEnumByPgName,
  getExtensionTypeMapping,
  TsType,
  PgTypeOid,
} from "../services/pg-types.js"
import type { EnumLookupResult } from "../services/pg-types.js"
import { conjure } from "./conjure.js"

const { ts } = conjure

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
 * Convert TsType enum to AST type node.
 * Shared by plugins that generate TypeScript types.
 */
export function tsTypeToAst(tsType: TsType): n.TSType {
  switch (tsType) {
    case TsType.String:
      return ts.string()
    case TsType.Number:
      return ts.number()
    case TsType.Boolean:
      return ts.boolean()
    case TsType.BigInt:
      return ts.bigint()
    case TsType.Date:
      return ts.ref("Date")
    case TsType.Buffer:
      return ts.ref("Buffer")
    case TsType.Unknown:
    default:
      return ts.unknown()
  }
}

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
  enums: Iterable<EnumEntity>,
  extensions: readonly ExtensionInfo[]
): ResolvedType {
  const pgType = field.pgAttribute.getType()

  // Helper to wrap TsType in ResolvedType
  const fromTsType = (tsType: TsType): ResolvedType => ({ tsType })

  // Try each resolution strategy in order, return first Some
  return pipe(
    // 1. Check for enum
    Option.liftPredicate(field, isEnumType),
    Option.flatMap(() => Option.fromNullable(getPgTypeName(field))),
    Option.flatMap((pgTypeName) => findEnumByPgName(enums, pgTypeName)),
    Option.map((enumDef): ResolvedType => ({ tsType: TsType.Unknown, enumDef })),

    // 2. Try OID-based mapping (built-in PostgreSQL types)
    Option.orElse(() =>
      pipe(
        Option.fromNullable(getTypeOid(field)),
        Option.flatMap(defaultPgToTs),
        Option.map(fromTsType)
      )
    ),

    // 3. Try domain base type mapping
    Option.orElse(() =>
      pipe(
        Option.fromNullable(field.domainBaseType),
        Option.flatMap((d) => defaultPgToTs(d.typeOid)),
        Option.map(fromTsType)
      )
    ),

    // 4. Try extension-based mapping for the direct type
    Option.orElse(() =>
      pipe(
        Option.fromNullable(pgType),
        Option.flatMap((t) =>
          getExtensionTypeMapping(t.typname, String(t.typnamespace), extensions)
        ),
        Option.map(fromTsType)
      )
    ),

    // 4b. Try extension-based mapping for domain base types
    Option.orElse(() =>
      pipe(
        Option.fromNullable(field.domainBaseType),
        Option.flatMap((d) =>
          getExtensionTypeMapping(d.typeName, d.namespaceOid, extensions)
        ),
        Option.map(fromTsType)
      )
    ),

    // 5. For arrays, try to resolve element type (enum first, then extension)
    Option.orElse(() =>
      pipe(
        Option.liftPredicate(field, (f) => f.isArray && !!f.elementTypeName),
        Option.flatMap((f) => {
          // Check if element is an enum
          const enumOpt = pipe(
            findEnumByPgName(enums, f.elementTypeName!),
            Option.map((enumDef): ResolvedType => ({ tsType: TsType.Unknown, enumDef }))
          )
          if (Option.isSome(enumOpt)) return enumOpt

          // Try extension-based mapping for array element type
          return pipe(
            Option.fromNullable(pgType?.typnamespace),
            Option.flatMap((ns) =>
              getExtensionTypeMapping(f.elementTypeName!, String(ns), extensions)
            ),
            Option.map(fromTsType)
          )
        })
      )
    ),

    // 6. Fallback to unknown
    Option.getOrElse((): ResolvedType => ({ tsType: TsType.Unknown }))
  )
}

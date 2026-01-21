/**
 * Mock Factories for pg-introspection Types
 *
 * Provides factory functions for creating test doubles of PgAttribute,
 * PgClass, and PgType from the @danielfgray/pg-introspection package.
 *
 * These factories create minimal but properly typed mock objects for testing,
 * eliminating the need for `as any` casts in test code.
 */
import type { PgAttribute, PgClass, PgType } from "@danielfgray/pg-introspection";

/**
 * Create a mock PgAttribute with sensible defaults.
 *
 * @example
 * ```ts
 * const attr = mockPgAttribute({ attname: "user_id" })
 * const attr = mockPgAttribute({ attname: "email", attnotnull: false })
 * ```
 */
export function mockPgAttribute(overrides: Partial<PgAttribute> = {}): PgAttribute {
  const baseType = mockPgType();
  
  return {
    attname: overrides.attname ?? "id",
    attnotnull: overrides.attnotnull ?? true,
    atthasdef: overrides.atthasdef ?? false,
    attgenerated: overrides.attgenerated ?? "",
    attidentity: overrides.attidentity ?? "",
    getType: overrides.getType ?? (() => baseType),
    ...overrides,
  } as PgAttribute;
}

/**
 * Create a mock PgClass with sensible defaults.
 *
 * @example
 * ```ts
 * const pgClass = mockPgClass({ relname: "users" })
 * ```
 */
export function mockPgClass(overrides: Partial<PgClass> = {}): PgClass {
  return {
    relname: overrides.relname ?? "table_name",
    ...overrides,
  } as PgClass;
}

/**
 * Create a mock PgType with sensible defaults.
 *
 * @example
 * ```ts
 * const type = mockPgType({ typname: "uuid", typcategory: "U" })
 * const enumType = mockPgType({ typname: "status", typtype: "e" })
 * ```
 */
export function mockPgType(overrides: Partial<PgType> = {}): PgType {
  return {
    typname: overrides.typname ?? "text",
    typcategory: overrides.typcategory ?? "S",
    typtype: overrides.typtype ?? "b",
    ...overrides,
  } as PgType;
}

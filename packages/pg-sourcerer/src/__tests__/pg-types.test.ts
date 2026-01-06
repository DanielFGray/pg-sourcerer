/**
 * Tests for PostgreSQL type mapping utilities
 *
 * These tests focus on behavior that plugins rely on, not implementation details.
 */
import { describe, expect, it } from "vitest"
import {
  PgTypeOid,
  TsType,
  defaultPgToTs,
  composeMappers,
  wrapArrayType,
  wrapNullable,
  findEnumByPgName,
} from "../services/pg-types.js"

describe("defaultPgToTs", () => {
  describe("maps common PostgreSQL types to TypeScript", () => {
    it("maps integer types to number", () => {
      expect(defaultPgToTs(PgTypeOid.Int4)).toBe("number")
      expect(defaultPgToTs(PgTypeOid.Int2)).toBe("number")
    })

    it("maps floating point types to number", () => {
      expect(defaultPgToTs(PgTypeOid.Float8)).toBe("number")
    })

    it("maps text types to string", () => {
      expect(defaultPgToTs(PgTypeOid.Text)).toBe("string")
      expect(defaultPgToTs(PgTypeOid.VarChar)).toBe("string")
      expect(defaultPgToTs(PgTypeOid.Uuid)).toBe("string")
    })

    it("maps boolean to boolean", () => {
      expect(defaultPgToTs(PgTypeOid.Bool)).toBe("boolean")
    })

    it("maps timestamp types to Date", () => {
      expect(defaultPgToTs(PgTypeOid.Timestamp)).toBe("Date")
      expect(defaultPgToTs(PgTypeOid.TimestampTz)).toBe("Date")
      expect(defaultPgToTs(PgTypeOid.Date)).toBe("Date")
    })

    it("maps json types to unknown", () => {
      expect(defaultPgToTs(PgTypeOid.Json)).toBe("unknown")
      expect(defaultPgToTs(PgTypeOid.JsonB)).toBe("unknown")
    })

    it("maps bigint to string to avoid precision loss", () => {
      // This is a deliberate design choice - plugins can override to bigint
      expect(defaultPgToTs(PgTypeOid.Int8)).toBe("string")
    })

    it("maps bytea to Buffer", () => {
      expect(defaultPgToTs(PgTypeOid.Bytea)).toBe("Buffer")
    })
  })

  describe("returns undefined for unknown types", () => {
    it("returns undefined for unrecognized OIDs", () => {
      expect(defaultPgToTs(99999)).toBeUndefined()
    })

    it("allows plugins to handle enums, domains, and custom types", () => {
      // A hypothetical enum OID would not be in the default map
      const hypotheticalEnumOid = 100000
      expect(defaultPgToTs(hypotheticalEnumOid)).toBeUndefined()
    })
  })
})

describe("composeMappers", () => {
  it("allows overriding default mappings", () => {
    // A plugin wants bigint instead of string for int8
    const kyselyMapper = (oid: number) =>
      oid === PgTypeOid.Int8 ? "bigint" : undefined

    const composed = composeMappers(kyselyMapper, defaultPgToTs)

    // Override is applied
    expect(composed(PgTypeOid.Int8)).toBe("bigint")
    // Defaults still work for non-overridden types
    expect(composed(PgTypeOid.Text)).toBe("string")
  })

  it("respects priority order - first match wins", () => {
    const highPriority = (oid: number) =>
      oid === PgTypeOid.JsonB ? "JsonValue" : undefined
    const lowPriority = (oid: number) =>
      oid === PgTypeOid.JsonB ? "object" : undefined

    const composed = composeMappers(highPriority, lowPriority, defaultPgToTs)

    expect(composed(PgTypeOid.JsonB)).toBe("JsonValue")
  })

  it("falls through to next mapper when current returns undefined", () => {
    const partialMapper = (oid: number) =>
      oid === PgTypeOid.Uuid ? "UUID" : undefined

    const composed = composeMappers(partialMapper, defaultPgToTs)

    // Partial mapper handles UUID
    expect(composed(PgTypeOid.Uuid)).toBe("UUID")
    // Falls through to default for others
    expect(composed(PgTypeOid.Int4)).toBe("number")
  })

  it("returns undefined when no mapper matches", () => {
    const composed = composeMappers(defaultPgToTs)
    expect(composed(99999)).toBeUndefined()
  })
})

describe("wrapArrayType", () => {
  it("appends [] to type when isArray is true", () => {
    expect(wrapArrayType("string", true)).toBe("string[]")
    expect(wrapArrayType("number", true)).toBe("number[]")
  })

  it("returns type unchanged when isArray is false", () => {
    expect(wrapArrayType("string", false)).toBe("string")
  })
})

describe("wrapNullable", () => {
  it("adds union with null by default", () => {
    expect(wrapNullable("string", true)).toBe("string | null")
  })

  it("returns type unchanged when not nullable", () => {
    expect(wrapNullable("string", false)).toBe("string")
  })

  it("supports optional style for interface properties", () => {
    expect(wrapNullable("string", true, "optional")).toBe("string?")
  })
})

describe("TsType constants", () => {
  it("provides standard TypeScript type strings", () => {
    // Plugins can use these constants for consistency
    expect(TsType.String).toBe("string")
    expect(TsType.Number).toBe("number")
    expect(TsType.Boolean).toBe("boolean")
    expect(TsType.Date).toBe("Date")
    expect(TsType.Unknown).toBe("unknown")
  })
})

describe("findEnumByPgName", () => {
  const mockEnums = new Map([
    [
      "UserRole",
      { name: "UserRole", pgName: "user_role", values: ["admin", "user", "guest"] },
    ],
    [
      "Status",
      { name: "Status", pgName: "status", values: ["active", "inactive"] },
    ],
  ])

  it("finds enum by PostgreSQL type name", () => {
    const result = findEnumByPgName(mockEnums, "user_role")
    expect(result).toEqual({
      name: "UserRole",
      pgName: "user_role",
      values: ["admin", "user", "guest"],
    })
  })

  it("returns undefined when enum not found", () => {
    const result = findEnumByPgName(mockEnums, "nonexistent")
    expect(result).toBeUndefined()
  })

  it("returns the inflected name for use in generated code", () => {
    const result = findEnumByPgName(mockEnums, "status")
    expect(result?.name).toBe("Status")
  })

  it("works with empty enums map", () => {
    const result = findEnumByPgName(new Map(), "user_role")
    expect(result).toBeUndefined()
  })
})

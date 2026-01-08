/**
 * Tests for PostgreSQL type mapping utilities
 *
 * These tests focus on behavior that plugins rely on, not implementation details.
 */
import { describe, expect, it } from "vitest"
import { Option } from "effect"
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
      expect(Option.getOrNull(defaultPgToTs(PgTypeOid.Int4))).toBe("number")
      expect(Option.getOrNull(defaultPgToTs(PgTypeOid.Int2))).toBe("number")
    })

    it("maps floating point types to number", () => {
      expect(Option.getOrNull(defaultPgToTs(PgTypeOid.Float8))).toBe("number")
    })

    it("maps text types to string", () => {
      expect(Option.getOrNull(defaultPgToTs(PgTypeOid.Text))).toBe("string")
      expect(Option.getOrNull(defaultPgToTs(PgTypeOid.VarChar))).toBe("string")
      expect(Option.getOrNull(defaultPgToTs(PgTypeOid.Uuid))).toBe("string")
    })

    it("maps boolean to boolean", () => {
      expect(Option.getOrNull(defaultPgToTs(PgTypeOid.Bool))).toBe("boolean")
    })

    it("maps timestamp types to Date", () => {
      expect(Option.getOrNull(defaultPgToTs(PgTypeOid.Timestamp))).toBe("Date")
      expect(Option.getOrNull(defaultPgToTs(PgTypeOid.TimestampTz))).toBe("Date")
      expect(Option.getOrNull(defaultPgToTs(PgTypeOid.Date))).toBe("Date")
    })

    it("maps json types to unknown", () => {
      expect(Option.getOrNull(defaultPgToTs(PgTypeOid.Json))).toBe("unknown")
      expect(Option.getOrNull(defaultPgToTs(PgTypeOid.JsonB))).toBe("unknown")
    })

    it("maps bigint to string to avoid precision loss", () => {
      // This is a deliberate design choice - plugins can override to bigint
      expect(Option.getOrNull(defaultPgToTs(PgTypeOid.Int8))).toBe("string")
    })

    it("maps bytea to Buffer", () => {
      expect(Option.getOrNull(defaultPgToTs(PgTypeOid.Bytea))).toBe("Buffer")
    })
  })

  describe("returns None for unknown types", () => {
    it("returns None for unrecognized OIDs", () => {
      expect(Option.isNone(defaultPgToTs(99999))).toBe(true)
    })

    it("allows plugins to handle enums, domains, and custom types", () => {
      // A hypothetical enum OID would not be in the default map
      const hypotheticalEnumOid = 100000
      expect(Option.isNone(defaultPgToTs(hypotheticalEnumOid))).toBe(true)
    })
  })
})

describe("composeMappers", () => {
  it("allows overriding default mappings", () => {
    // A plugin wants bigint instead of string for int8
    const kyselyMapper = (oid: number) =>
      oid === PgTypeOid.Int8 ? Option.some("bigint") : Option.none()

    const composed = composeMappers(kyselyMapper, defaultPgToTs)

    // Override is applied
    expect(Option.getOrNull(composed(PgTypeOid.Int8))).toBe("bigint")
    // Defaults still work for non-overridden types
    expect(Option.getOrNull(composed(PgTypeOid.Text))).toBe("string")
  })

  it("respects priority order - first match wins", () => {
    const highPriority = (oid: number) =>
      oid === PgTypeOid.JsonB ? Option.some("JsonValue") : Option.none()
    const lowPriority = (oid: number) =>
      oid === PgTypeOid.JsonB ? Option.some("object") : Option.none()

    const composed = composeMappers(highPriority, lowPriority, defaultPgToTs)

    expect(Option.getOrNull(composed(PgTypeOid.JsonB))).toBe("JsonValue")
  })

  it("falls through to next mapper when current returns None", () => {
    const partialMapper = (oid: number) =>
      oid === PgTypeOid.Uuid ? Option.some("UUID") : Option.none()

    const composed = composeMappers(partialMapper, defaultPgToTs)

    // Partial mapper handles UUID
    expect(Option.getOrNull(composed(PgTypeOid.Uuid))).toBe("UUID")
    // Falls through to default for others
    expect(Option.getOrNull(composed(PgTypeOid.Int4))).toBe("number")
  })

  it("returns None when no mapper matches", () => {
    const composed = composeMappers(defaultPgToTs)
    expect(Option.isNone(composed(99999))).toBe(true)
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
  const mockEnums = [
    { name: "UserRole", pgName: "user_role", values: ["admin", "user", "guest"] as const },
    { name: "Status", pgName: "status", values: ["active", "inactive"] as const },
  ]

  it("finds enum by PostgreSQL type name", () => {
    const result = findEnumByPgName(mockEnums, "user_role")
    expect(Option.isSome(result)).toBe(true)
    expect(Option.getOrNull(result)).toEqual({
      name: "UserRole",
      pgName: "user_role",
      values: ["admin", "user", "guest"],
    })
  })

  it("returns None when enum not found", () => {
    const result = findEnumByPgName(mockEnums, "nonexistent")
    expect(Option.isNone(result)).toBe(true)
  })

  it("returns the inflected name for use in generated code", () => {
    const result = findEnumByPgName(mockEnums, "status")
    expect(Option.map(result, r => r.name).pipe(Option.getOrNull)).toBe("Status")
  })

  it("works with empty enums array", () => {
    const result = findEnumByPgName([], "user_role")
    expect(Option.isNone(result)).toBe(true)
  })
})

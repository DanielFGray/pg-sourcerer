/**
 * Smart Tags Parser Tests
 */
import { it, describe, expect } from "@effect/vitest"
import { Effect } from "effect"
import { parseSmartTags } from "../services/smart-tags-parser.js"
import { TagParseError } from "../errors.js"

const ctx = { objectType: "table" as const, objectName: "users" }

describe("parseSmartTags", () => {
  describe("valid formats with sourcerer key", () => {
    it.effect("parses JSON-only comment", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags('{"sourcerer": {"name": "User"}}', ctx)
        expect(result.tags.name).toBe("User")
        expect(result.description).toBeUndefined()
      })
    )

    it.effect("parses JSON with single-line description", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags(
          '{"sourcerer": {"name": "User"}}\nUser accounts table',
          ctx
        )
        expect(result.tags.name).toBe("User")
        expect(result.description).toBe("User accounts table")
      })
    )

    it.effect("parses JSON with multi-line description", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags(
          '{"sourcerer": {"name": "User"}}\nLine 1\nLine 2',
          ctx
        )
        expect(result.tags.name).toBe("User")
        expect(result.description).toBe("Line 1\nLine 2")
      })
    )

    it.effect("parses omit as boolean", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags('{"sourcerer": {"omit": true}}', ctx)
        expect(result.tags.omit).toBe(true)
      })
    )

    it.effect("parses omit as array of shape kinds", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags(
          '{"sourcerer": {"omit": ["insert", "update"]}}',
          ctx
        )
        expect(result.tags.omit).toEqual(["insert", "update"])
      })
    )

    it.effect("parses deprecated as boolean", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags('{"sourcerer": {"deprecated": true}}', ctx)
        expect(result.tags.deprecated).toBe(true)
      })
    )

    it.effect("parses deprecated as string message", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags(
          '{"sourcerer": {"deprecated": "Use email_address instead"}}',
          ctx
        )
        expect(result.tags.deprecated).toBe("Use email_address instead")
      })
    )

    it.effect("parses type override", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags('{"sourcerer": {"type": "Email"}}', ctx)
        expect(result.tags.type).toBe("Email")
      })
    )

    it.effect("parses primaryKey for views", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags(
          '{"sourcerer": {"primaryKey": ["id", "tenant_id"]}}',
          ctx
        )
        expect(result.tags.primaryKey).toEqual(["id", "tenant_id"])
      })
    )

    it.effect("parses relation naming tags", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags(
          '{"sourcerer": {"fieldName": "author", "foreignFieldName": "posts"}}',
          { objectType: "constraint", objectName: "posts_author_fkey" }
        )
        expect(result.tags.fieldName).toBe("author")
        expect(result.tags.foreignFieldName).toBe("posts")
      })
    )

    it.effect("allows extension keys", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags(
          '{"sourcerer": {"name": "User", "customPlugin": {"foo": "bar"}}}',
          ctx
        )
        expect(result.tags.name).toBe("User")
        expect(result.tags["customPlugin"]).toEqual({ foo: "bar" })
      })
    )

    it.effect("handles empty sourcerer object", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags('{"sourcerer": {}}', ctx)
        expect(result.tags).toEqual({})
        expect(result.description).toBeUndefined()
      })
    )
  })

  describe("no tags (valid)", () => {
    it.effect("returns empty tags for null comment", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags(null, ctx)
        expect(result.tags).toEqual({})
        expect(result.description).toBeUndefined()
      })
    )

    it.effect("returns empty tags for undefined comment", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags(undefined, ctx)
        expect(result.tags).toEqual({})
        expect(result.description).toBeUndefined()
      })
    )

    it.effect("returns empty tags for empty string", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags("", ctx)
        expect(result.tags).toEqual({})
        expect(result.description).toBeUndefined()
      })
    )

    it.effect("returns plain text as description when no JSON", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags("Just a plain description", ctx)
        expect(result.tags).toEqual({})
        expect(result.description).toBe("Just a plain description")
      })
    )

    it.effect("returns empty tags when JSON has no sourcerer key", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags('{"other_tool": {"setting": true}}', ctx)
        expect(result.tags).toEqual({})
        expect(result.description).toBeUndefined()
      })
    )

    it.effect("extracts description when JSON has no sourcerer key", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags(
          '{"other_tool": {"setting": true}}\nDescription here',
          ctx
        )
        expect(result.tags).toEqual({})
        expect(result.description).toBe("Description here")
      })
    )
  })

  describe("errors", () => {
    it.effect("fails on malformed JSON", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags("{malformed json}", ctx).pipe(
          Effect.either
        )
        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left).toBeInstanceOf(TagParseError)
          expect(result.left.objectType).toBe("table")
          expect(result.left.objectName).toBe("users")
        }
      })
    )

    it.effect("fails on unclosed brace", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags('{"sourcerer": {}', ctx).pipe(
          Effect.either
        )
        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left).toBeInstanceOf(TagParseError)
        }
      })
    )

    it.effect("fails on invalid omit value", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags(
          '{"sourcerer": {"omit": "invalid"}}',
          ctx
        ).pipe(Effect.either)
        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left).toBeInstanceOf(TagParseError)
        }
      })
    )

    it.effect("fails on invalid omit array value", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags(
          '{"sourcerer": {"omit": ["insert", "invalid_shape"]}}',
          ctx
        ).pipe(Effect.either)
        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left).toBeInstanceOf(TagParseError)
        }
      })
    )

    it.effect("fails on invalid deprecated value", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags(
          '{"sourcerer": {"deprecated": 123}}',
          ctx
        ).pipe(Effect.either)
        expect(result._tag).toBe("Left")
      })
    )

    it.effect("fails on invalid primaryKey value", () =>
      Effect.gen(function* () {
        const result = yield* parseSmartTags(
          '{"sourcerer": {"primaryKey": "not_an_array"}}',
          ctx
        ).pipe(Effect.either)
        expect(result._tag).toBe("Left")
      })
    )

    it.effect("includes comment in error", () =>
      Effect.gen(function* () {
        const comment = "{bad json"
        const result = yield* parseSmartTags(comment, ctx).pipe(Effect.either)
        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left.comment).toBe(comment)
        }
      })
    )
  })
})

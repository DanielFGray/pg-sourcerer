/**
 * Emission Buffer Unit Tests
 */
import { describe, it, expect } from "@effect/vitest"
import { Effect } from "effect"
import { createEmissionBuffer } from "../services/emissions.js"

describe("Emission Buffer", () => {
  describe("emit", () => {
    it("stores a file emission", () => {
      const buffer = createEmissionBuffer()
      buffer.emit("types/User.ts", "export interface User {}", "types-plugin")

      const all = buffer.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]).toEqual({
        path: "types/User.ts",
        content: "export interface User {}",
        plugin: "types-plugin",
      })
    })

    it("allows multiple different files", () => {
      const buffer = createEmissionBuffer()
      buffer.emit("types/User.ts", "interface User {}", "types-plugin")
      buffer.emit("types/Post.ts", "interface Post {}", "types-plugin")
      buffer.emit("schemas/User.ts", "const UserSchema = {}", "schema-plugin")

      const all = buffer.getAll()
      expect(all).toHaveLength(3)
    })

    it("overwrites same file from same plugin", () => {
      const buffer = createEmissionBuffer()
      buffer.emit("types/User.ts", "first version", "types-plugin")
      buffer.emit("types/User.ts", "second version", "types-plugin")

      const all = buffer.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]?.content).toBe("second version")
    })

    it("tracks conflict when different plugin writes same file", () => {
      const buffer = createEmissionBuffer()
      buffer.emit("types/User.ts", "from plugin A", "plugin-a")
      buffer.emit("types/User.ts", "from plugin B", "plugin-b")

      // getAll returns last write
      const all = buffer.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]?.content).toBe("from plugin B")
      expect(all[0]?.plugin).toBe("plugin-b")
    })
  })

  describe("appendEmit", () => {
    it("appends to existing file from same plugin", () => {
      const buffer = createEmissionBuffer()
      buffer.emit("index.ts", "// header\n", "index-plugin")
      buffer.appendEmit("index.ts", "export * from './User.js'\n", "index-plugin")
      buffer.appendEmit("index.ts", "export * from './Post.js'\n", "index-plugin")

      const all = buffer.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]?.content).toBe(
        "// header\nexport * from './User.js'\nexport * from './Post.js'\n"
      )
    })

    it("creates new file if not exists", () => {
      const buffer = createEmissionBuffer()
      buffer.appendEmit("index.ts", "export * from './User.js'\n", "index-plugin")

      const all = buffer.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]?.content).toBe("export * from './User.js'\n")
    })

    it("silently ignores append from different plugin (tracks conflict)", () => {
      const buffer = createEmissionBuffer()
      buffer.emit("index.ts", "from plugin A", "plugin-a")
      buffer.appendEmit("index.ts", " plus plugin B", "plugin-b")

      // Content should NOT be appended (different plugin)
      const all = buffer.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]?.content).toBe("from plugin A")
      expect(all[0]?.plugin).toBe("plugin-a")
    })
  })

  describe("getAll", () => {
    it("returns empty array when no emissions", () => {
      const buffer = createEmissionBuffer()
      expect(buffer.getAll()).toEqual([])
    })

    it("returns all emissions as array", () => {
      const buffer = createEmissionBuffer()
      buffer.emit("a.ts", "a", "p")
      buffer.emit("b.ts", "b", "p")
      buffer.emit("c.ts", "c", "p")

      const all = buffer.getAll()
      expect(all).toHaveLength(3)
      expect(all.map((e) => e.path).sort()).toEqual(["a.ts", "b.ts", "c.ts"])
    })
  })

  describe("validate", () => {
    it.effect("succeeds with no conflicts", () =>
      Effect.gen(function* () {
        const buffer = createEmissionBuffer()
        buffer.emit("types/User.ts", "User", "types-plugin")
        buffer.emit("types/Post.ts", "Post", "types-plugin")
        buffer.emit("schemas/User.ts", "UserSchema", "schema-plugin")

        yield* buffer.validate()
        // No error means success
      })
    )

    it.effect("succeeds with same plugin writing to same file", () =>
      Effect.gen(function* () {
        const buffer = createEmissionBuffer()
        buffer.emit("types/User.ts", "first", "types-plugin")
        buffer.emit("types/User.ts", "second", "types-plugin")

        yield* buffer.validate()
        // Same plugin overwriting is allowed
      })
    )

    it.effect("fails when different plugins write same file", () =>
      Effect.gen(function* () {
        const buffer = createEmissionBuffer()
        buffer.emit("types/User.ts", "from A", "plugin-a")
        buffer.emit("types/User.ts", "from B", "plugin-b")

        const result = yield* buffer.validate().pipe(Effect.either)

        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("EmitConflict")
          expect(result.left.path).toBe("types/User.ts")
          expect(result.left.plugins).toContain("plugin-a")
          expect(result.left.plugins).toContain("plugin-b")
        }
      })
    )

    it.effect("fails when different plugin tries to append", () =>
      Effect.gen(function* () {
        const buffer = createEmissionBuffer()
        buffer.emit("index.ts", "header", "plugin-a")
        buffer.appendEmit("index.ts", "append", "plugin-b")

        const result = yield* buffer.validate().pipe(Effect.either)

        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("EmitConflict")
          expect(result.left.path).toBe("index.ts")
        }
      })
    )

    it.effect("reports first conflict found", () =>
      Effect.gen(function* () {
        const buffer = createEmissionBuffer()
        // Create multiple conflicts
        buffer.emit("a.ts", "a1", "plugin-1")
        buffer.emit("a.ts", "a2", "plugin-2")
        buffer.emit("b.ts", "b1", "plugin-1")
        buffer.emit("b.ts", "b2", "plugin-2")

        const result = yield* buffer.validate().pipe(Effect.either)

        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("EmitConflict")
          // Should report one of the conflicts
          expect(["a.ts", "b.ts"]).toContain(result.left.path)
        }
      })
    )
  })

  describe("clear", () => {
    it("removes all emissions", () => {
      const buffer = createEmissionBuffer()
      buffer.emit("a.ts", "a", "p")
      buffer.emit("b.ts", "b", "p")
      buffer.emit("c.ts", "c", "p")

      expect(buffer.getAll()).toHaveLength(3)

      buffer.clear()

      expect(buffer.getAll()).toHaveLength(0)
    })

    it.effect("clears conflict tracking", () =>
      Effect.gen(function* () {
        const buffer = createEmissionBuffer()

        // Create a conflict
        buffer.emit("x.ts", "a", "plugin-a")
        buffer.emit("x.ts", "b", "plugin-b")

        // Confirm conflict exists
        const beforeClear = yield* buffer.validate().pipe(Effect.either)
        expect(beforeClear._tag).toBe("Left")

        // Clear and add clean emission
        buffer.clear()
        buffer.emit("x.ts", "clean", "plugin-c")

        // Should validate clean now
        yield* buffer.validate()
      })
    )
  })
})

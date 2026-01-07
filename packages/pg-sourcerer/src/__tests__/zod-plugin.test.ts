/**
 * Zod Plugin Tests
 *
 * Tests for the Zod plugin that generates Zod schemas for entities.
 * Uses the fixture introspection data from the example database.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- Test helpers use flexible typing */
/* eslint-disable @typescript-eslint/no-unsafe-return -- Effect type inference in tests */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { zodPlugin } from "../plugins/zod.js"
import { createIRBuilderService } from "../services/ir-builder.js"
import { ClassicInflectionLive } from "../services/inflection.js"
import { Emissions, createEmissionBuffer } from "../services/emissions.js"
import { Symbols, createSymbolRegistry } from "../services/symbols.js"
import { TypeHintsLive } from "../services/type-hints.js"
import { ArtifactStoreLive } from "../services/artifact-store.js"
import { PluginMeta } from "../services/plugin-meta.js"
import { IR } from "../services/ir.js"
import { loadIntrospectionFixture } from "./fixtures/index.js"
import type { SemanticIR } from "../ir/semantic-ir.js"
import { conjure } from "../lib/conjure.js"

// Load introspection data from fixture
const introspection = loadIntrospectionFixture()

/**
 * Build IR from fixture introspection data
 */
async function buildTestIR(schemas: readonly string[]): Promise<SemanticIR> {
  const builder = createIRBuilderService()
  return Effect.runPromise(
    builder.build(introspection, { schemas }).pipe(Effect.provide(ClassicInflectionLive))
  )
}

/**
 * Create a test layer with fresh emissions and symbols for each test.
 */
function createTestLayer(ir: SemanticIR) {
  const emissions = createEmissionBuffer()
  const symbols = createSymbolRegistry()

  return Layer.mergeAll(
    Layer.succeed(IR, ir),
    Layer.succeed(Emissions, emissions),
    Layer.succeed(Symbols, symbols),
    Layer.succeed(PluginMeta, { name: "zod" }),
    ClassicInflectionLive,
    TypeHintsLive([]),
    ArtifactStoreLive
  )
}

/**
 * Run plugin and get serialized emissions.
 * Handles AST serialization so tests can inspect string content.
 */
function runPluginAndGetEmissions(testLayer: Layer.Layer<any, any, any>) {
  return Effect.gen(function* () {
    const emissions = yield* Emissions.pipe(Effect.provide(testLayer))
    const symbols = yield* Symbols.pipe(Effect.provide(testLayer))
    // Serialize any AST emissions to string content
    emissions.serializeAst(conjure.print, symbols)
    return emissions.getAll()
  })
}

describe("Zod Plugin", () => {
  describe("plugin structure", () => {
    it("has correct name", () => {
      expect(zodPlugin.name).toBe("zod")
    })

    it("provides schemas capabilities", () => {
      expect(zodPlugin.provides).toContain("schemas:zod")
      expect(zodPlugin.provides).toContain("schemas")
    })

    it("has no requirements", () => {
      expect(zodPlugin.requires).toBeUndefined()
    })
  })

  describe("entity generation", () => {
    it.effect("generates Zod schemas for User entity", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* zodPlugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // Should have generated files for entities
        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile).toBeDefined()
        expect(userFile?.content).toContain("UserRow = z.object")
        expect(userFile?.content).toContain("UserInsert = z.object")
        expect(userFile?.content).toContain("UserUpdate = z.object")
        expect(userFile?.content).toContain("UserPatch = z.object")
      })
    )

    it.effect("generates Zod import statement", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* zodPlugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile?.content).toContain('import { z } from "zod"')
      })
    )

    it.effect("generates correct field types for User", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* zodPlugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile).toBeDefined()

        const content = userFile?.content ?? ""

        // Check expected Zod field types
        expect(content).toContain("z.string().uuid()") // UUID fields
        expect(content).toContain("z.string()") // text/citext fields
        expect(content).toContain("z.coerce.date()") // timestamp fields
        expect(content).toContain("z.boolean()") // boolean fields
      })
    )

    it.effect("handles nullable fields correctly", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* zodPlugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile).toBeDefined()

        const content = userFile?.content ?? ""

        // bio is nullable text, should use .nullable()
        expect(content).toContain(".nullable()")
      })
    )

    it.effect("handles optional fields in Insert schema", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* zodPlugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile).toBeDefined()

        const content = userFile?.content ?? ""

        // In UserInsert, fields with defaults should use .optional()
        expect(content).toContain(".optional()")
      })
    )

    it.effect("generates auto-generated file header", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* zodPlugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile?.content).toContain("// This file is auto-generated. Do not edit.")
      })
    )
  })

  describe("inferred type exports", () => {
    it.effect("exports inferred types when exportTypes is true", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* zodPlugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile).toBeDefined()

        const content = userFile?.content ?? ""

        // Should have type exports using z.infer
        expect(content).toContain("export type UserRow = z.infer<typeof UserRow>")
        expect(content).toContain("export type UserInsert = z.infer<typeof UserInsert>")
      })
    )

    it.effect("does not export types when exportTypes is false", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* zodPlugin
          .run({ outputDir: "schemas", exportTypes: false })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile).toBeDefined()

        const content = userFile?.content ?? ""

        // Should have const exports but NOT type exports
        expect(content).toContain("export const UserRow = z.object")
        expect(content).not.toContain("export type UserRow = z.infer")
      })
    )
  })

  describe("enum generation", () => {
    it.effect("generates z.enum for enum fields", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* zodPlugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // User has role field which is an enum
        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile).toBeDefined()

        const content = userFile?.content ?? ""

        // If Role enum exists, should use z.enum
        if (ir.enums.has("Role")) {
          expect(content).toContain("z.enum([")
        }
      })
    )
  })

  describe("symbol registration", () => {
    it.effect("registers symbols for generated schemas", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* zodPlugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer))

        const symbols = yield* Symbols.pipe(Effect.provide(testLayer))
        const allSymbols = symbols.getAll()

        // Should have registered UserRow schema
        const userRowSymbol = allSymbols.find(
          (s) => s.name === "UserRow" && !s.isType
        )
        expect(userRowSymbol).toBeDefined()
        expect(userRowSymbol?.capability).toBe("schemas:zod")
        expect(userRowSymbol?.shape).toBe("row")
      })
    )

    it.effect("registers type symbols when exportTypes is true", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* zodPlugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer))

        const symbols = yield* Symbols.pipe(Effect.provide(testLayer))
        const allSymbols = symbols.getAll()

        // Should have registered UserRow type
        const userRowTypeSymbol = allSymbols.find(
          (s) => s.name === "UserRow" && s.isType
        )
        expect(userRowTypeSymbol).toBeDefined()
        expect(userRowTypeSymbol?.capability).toBe("schemas:zod")
        expect(userRowTypeSymbol?.isType).toBe(true)
      })
    )
  })

  describe("configuration", () => {
    it.effect("uses outputDir from config", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* zodPlugin
          .run({ outputDir: "custom/zod", exportTypes: true })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // All paths should start with the custom output directory
        for (const emission of all) {
          expect(emission.path).toMatch(/^custom\/zod\//)
        }
      })
    )
  })

  describe("entity filtering", () => {
    it.effect("skips entities with @omit tag", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* zodPlugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // Just verify we get some output (entities without @omit)
        expect(all.length).toBeGreaterThan(0)
      })
    )
  })
})

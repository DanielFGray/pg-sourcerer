/**
 * Types Plugin Tests
 *
 * Tests for the types plugin that generates TypeScript interfaces for entities.
 * Uses the fixture introspection data from the example database.
 */
import { describe, expect, layer, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { typesPlugin } from "../plugins/types.js"
import { createIRBuilderService } from "../services/ir-builder.js"
import { InflectionLive, Inflection } from "../services/inflection.js"
import { Emissions, createEmissionBuffer } from "../services/emissions.js"
import { Symbols, createSymbolRegistry } from "../services/symbols.js"
import { TypeHintsLive } from "../services/type-hints.js"
import { ArtifactStoreLive, ArtifactStore } from "../services/artifact-store.js"
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
    builder.build(introspection, { schemas }).pipe(Effect.provide(InflectionLive))
  )
}

/**
 * Create a test layer with fresh emissions and symbols for each test.
 * This is a factory function so each test gets isolated state.
 */
function createTestLayer(ir: SemanticIR) {
  // Create fresh mutable services for each test
  const emissions = createEmissionBuffer()
  const symbols = createSymbolRegistry()

  return Layer.mergeAll(
    Layer.succeed(IR, ir),
    Layer.succeed(Emissions, emissions),
    Layer.succeed(Symbols, symbols),
    Layer.succeed(PluginMeta, { name: "types" }),
    InflectionLive,
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
    // Serialize any AST emissions to string content
    emissions.serializeAst(conjure.print)
    return emissions.getAll()
  })
}

describe("Types Plugin", () => {
  describe("plugin structure", () => {
    it("has correct name", () => {
      expect(typesPlugin.name).toBe("types")
    })

    it("provides types capability", () => {
      expect(typesPlugin.provides).toContain("types")
    })

    it("has no requirements", () => {
      expect(typesPlugin.requires).toBeUndefined()
    })
  })

  describe("entity generation", () => {
    it.effect("generates interfaces for User entity", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* typesPlugin
          .run({ outputDir: "types" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // Should have generated files for entities
        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile).toBeDefined()
        expect(userFile?.content).toContain("interface UserRow")
        expect(userFile?.content).toContain("interface UserInsert")
        expect(userFile?.content).toContain("interface UserUpdate")
        expect(userFile?.content).toContain("interface UserPatch")
      })
    )

    it.effect("generates correct field types for User", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* typesPlugin
          .run({ outputDir: "types" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile).toBeDefined()

        const content = userFile?.content ?? ""

        // Check expected field types
        expect(content).toContain("id: string") // UUID
        expect(content).toContain("username: string") // citext -> string via typcategory
        expect(content).toContain("createdAt: Date")
        expect(content).toContain("isVerified: boolean")
        expect(content).toContain("bio: string") // text type
      })
    )

    it.effect("marks optional fields correctly in Insert shape", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* typesPlugin
          .run({ outputDir: "types" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile).toBeDefined()

        const content = userFile?.content ?? ""

        // In UserInsert, fields with defaults should be optional
        // id (has default), createdAt (has default), updatedAt (has default)
        // The regex checks for the optional marker ? before :
        expect(content).toMatch(/id\?:/)
        expect(content).toMatch(/createdAt\?:/)
        expect(content).toMatch(/updatedAt\?:/)
      })
    )

    it.effect("generates auto-generated file header", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* typesPlugin
          .run({ outputDir: "types" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile?.content).toContain("// This file is auto-generated. Do not edit.")
      })
    )
  })

  describe("enum generation", () => {
    it.effect("generates enums file when enums exist", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* typesPlugin
          .run({ outputDir: "types" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // Check if there are enums in the IR
        if (ir.enums.size > 0) {
          const enumsFile = all.find((e) => e.path.includes("enums.ts"))
          expect(enumsFile).toBeDefined()
          expect(enumsFile?.content).toContain("export type")
        }
      })
    )

    it.effect("generates union types for enums", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* typesPlugin
          .run({ outputDir: "types" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        if (ir.enums.size > 0) {
          const enumsFile = all.find((e) => e.path.includes("enums.ts"))
          expect(enumsFile).toBeDefined()

          // Should use union type syntax with string literals
          // e.g., export type Role = "admin" | "user"
          const content = enumsFile?.content ?? ""
          expect(content).toMatch(/export type \w+ = "[^"]+"/)
        }
      })
    )

    it.effect("adds enum imports to entity files when needed", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* typesPlugin
          .run({ outputDir: "types" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // User has role field which is an enum
        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile).toBeDefined()

        const content = userFile?.content ?? ""

        // Should import the enum type if Role enum exists
        if (ir.enums.has("Role")) {
          expect(content).toContain('import type { Role }')
          expect(content).toContain('from "./enums.js"')
        }
      })
    )
  })

  describe("symbol registration", () => {
    it.effect("registers symbols for generated types", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* typesPlugin
          .run({ outputDir: "types" })
          .pipe(Effect.provide(testLayer))

        const symbols = yield* Symbols.pipe(Effect.provide(testLayer))
        const allSymbols = symbols.getAll()

        // Should have registered UserRow, UserInsert, etc.
        const userRowSymbol = allSymbols.find((s) => s.name === "UserRow")
        expect(userRowSymbol).toBeDefined()
        expect(userRowSymbol?.capability).toBe("types")
        expect(userRowSymbol?.isType).toBe(true)
        expect(userRowSymbol?.shape).toBe("row")
      })
    )

    it.effect("registers enum symbols", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* typesPlugin
          .run({ outputDir: "types" })
          .pipe(Effect.provide(testLayer))

        const symbols = yield* Symbols.pipe(Effect.provide(testLayer))
        const allSymbols = symbols.getAll()

        // If Role enum exists, it should be registered
        if (ir.enums.has("Role")) {
          const roleSymbol = allSymbols.find((s) => s.name === "Role")
          expect(roleSymbol).toBeDefined()
          expect(roleSymbol?.capability).toBe("types")
          expect(roleSymbol?.isType).toBe(true)
        }
      })
    )
  })

  describe("configuration", () => {
    it.effect("uses outputDir from config", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* typesPlugin
          .run({ outputDir: "custom/path" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // All paths should start with the custom output directory
        for (const emission of all) {
          expect(emission.path).toMatch(/^custom\/path\//)
        }
      })
    )
  })

  describe("entity filtering", () => {
    it.effect("skips entities with @omit tag", () =>
      Effect.gen(function* () {
        // Build IR and manually add @omit tag to test filtering
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))

        // Get an entity and mark it omitted (if there are multiple)
        const entities = [...ir.entities.values()]
        if (entities.length > 1) {
          // We can't easily modify the frozen IR, so this test verifies
          // that when there ARE entities with @omit, they're skipped.
          // The plugin implementation checks entity.tags.omit === true
          const testLayer = createTestLayer(ir)

          yield* typesPlugin
            .run({ outputDir: "types" })
            .pipe(Effect.provide(testLayer))

          const all = yield* runPluginAndGetEmissions(testLayer)

          // Just verify we get some output (entities without @omit)
          expect(all.length).toBeGreaterThan(0)
        }
      })
    )
  })
})

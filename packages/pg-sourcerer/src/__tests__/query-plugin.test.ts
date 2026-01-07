/**
 * Query Plugin Tests
 *
 * Tests for the query plugin that generates typed query functions based on indexes.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { createIRBuilderService } from "../services/ir-builder.js"
import { ClassicInflectionLive } from "../services/inflection.js"
import { Emissions, createEmissionBuffer } from "../services/emissions.js"
import { Symbols, createSymbolRegistry } from "../services/symbols.js"
import { TypeHintsLive } from "../services/type-hints.js"
import type { TypeHint } from "../config.js"
import { ArtifactStoreLive } from "../services/artifact-store.js"
import { PluginMeta } from "../services/plugin-meta.js"
import { IR } from "../services/ir.js"
import { loadIntrospectionFixture } from "./fixtures/index.js"
import type { SemanticIR } from "../ir/semantic-ir.js"
import { conjure } from "../lib/conjure.js"

// Import the query plugin
import { queryPlugin } from "../plugins/query.js"

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
function createTestLayer(ir: SemanticIR, typeHints: readonly TypeHint[] = []) {
  const emissions = createEmissionBuffer()
  const symbols = createSymbolRegistry()

  return Layer.mergeAll(
    Layer.succeed(IR, ir),
    Layer.succeed(Emissions, emissions),
    Layer.succeed(Symbols, symbols),
    Layer.succeed(PluginMeta, { name: "query" }),
    ClassicInflectionLive,
    TypeHintsLive(typeHints),
    ArtifactStoreLive
  )
}

/**
 * Run plugin and get serialized emissions.
 */
function runPluginAndGetEmissions(testLayer: Layer.Layer<any, any, any>) {
  return Effect.gen(function* () {
    const emissions = yield* Emissions.pipe(Effect.provide(testLayer))
    const symbols = yield* Symbols.pipe(Effect.provide(testLayer))
    emissions.serializeAst(conjure.print, symbols)
    return emissions.getAll()
  })
}

describe("Query Plugin", () => {
  describe("plugin structure", () => {
    it("has correct name", () => {
      expect(queryPlugin.plugin.name).toBe("query")
    })

    it("provides queries capability", () => {
      expect(queryPlugin.plugin.provides).toContain("queries")
    })

    it("requires types capability", () => {
      expect(queryPlugin.plugin.requires).toContain("types")
    })
  })

  describe("with fixture database", () => {
    it.effect("generates query functions for User entity", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* queryPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // Should have generated queries for User
        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile).toBeDefined()

        // Should have a query function
        expect(userFile?.content).toMatch(/async function getUserById/)
      })
    )

    it.effect("generates function for unique index lookup", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* queryPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile).toBeDefined()

        // Should have a function for the username unique index
        expect(userFile?.content).toMatch(/getUserByUsername/)
      })
    )

    it.effect("generates function for composite primary key", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* queryPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // posts_votes has composite PK
        const votesFile = all.find((e) => e.path.includes("PostsVote"))
        expect(votesFile).toBeDefined()
        expect(votesFile?.content).toMatch(/getPostsVoteBy/)
      })
    )

    it.effect("generates async functions with correct signatures", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* queryPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile).toBeDefined()

        // Functions should be async and have typed parameters
        expect(userFile?.content).toContain("async function getUserById")
        expect(userFile?.content).toMatch(/getUserById\(id: string\)/)
      })
    )

    it.effect("has auto-generated file header", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* queryPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        const userFile = all.find((e) => e.path.includes("User.ts"))
        expect(userFile?.content).toContain("// This file is auto-generated. Do not edit.")
      })
    )
  })
})

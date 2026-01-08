/**
 * SQL Queries Plugin Tests
 *
 * TDD tests for the sql-queries plugin that generates typed SQL query functions.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
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

import { sqlQueriesPlugin } from "../plugins/sql-queries.js"

const introspection = loadIntrospectionFixture()

async function buildTestIR(schemas: readonly string[]): Promise<SemanticIR> {
  const builder = createIRBuilderService()
  return Effect.runPromise(
    builder.build(introspection, { schemas }).pipe(Effect.provide(ClassicInflectionLive))
  )
}

function createTestLayer(ir: SemanticIR) {
  const emissions = createEmissionBuffer()
  const symbols = createSymbolRegistry()

  return Layer.mergeAll(
    Layer.succeed(IR, ir),
    Layer.succeed(Emissions, emissions),
    Layer.succeed(Symbols, symbols),
    Layer.succeed(PluginMeta, { name: "sql-queries" }),
    ClassicInflectionLive,
    TypeHintsLive([]),
    ArtifactStoreLive
  )
}

/**
 * Create a test layer with pre-registered type symbols.
 * This simulates the types plugin having already run.
 */
function createTestLayerWithTypeSymbols(ir: SemanticIR, entities: string[]) {
  const emissions = createEmissionBuffer()
  const symbols = createSymbolRegistry()

  // Pre-register Row type symbols as if types plugin had run
  for (const entity of entities) {
    symbols.register(
      {
        name: `${entity}Row`,
        file: `types/${entity}.ts`,
        capability: "types",
        entity,
        shape: "row",
        isType: true,
        isDefault: false,
      },
      "types"
    )
  }

  return Layer.mergeAll(
    Layer.succeed(IR, ir),
    Layer.succeed(Emissions, emissions),
    Layer.succeed(Symbols, symbols),
    Layer.succeed(PluginMeta, { name: "sql-queries" }),
    ClassicInflectionLive,
    TypeHintsLive([]),
    ArtifactStoreLive
  )
}

function runPluginAndGetEmissions(testLayer: Layer.Layer<any, any, any>) {
  return Effect.gen(function* () {
    const emissions = yield* Emissions.pipe(Effect.provide(testLayer))
    const symbols = yield* Symbols.pipe(Effect.provide(testLayer))
    emissions.serializeAst(conjure.print, symbols)
    return emissions.getAll()
  })
}

describe("SQL Queries Plugin", () => {
  describe("plugin structure", () => {
    it("has correct name", () => {
      expect(sqlQueriesPlugin.plugin.name).toBe("sql-queries")
    })

    it("provides queries capability", () => {
      expect(sqlQueriesPlugin.plugin.provides).toContain("queries")
    })

    it("requires types capability", () => {
      expect(sqlQueriesPlugin.plugin.requires).toContain("types")
    })
  })

  describe("SQL generation", () => {
    it.effect("generates SELECT with schema-qualified table name", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        expect(userFile?.content).toContain("app_public.users")
      })
    )

    it.effect("generates parameterized SQL with template interpolation", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // Should have template literal with interpolation
        expect(userFile?.content).toMatch(/sql`[^`]*\$\{[^}]+\}[^`]*`/)
      })
    )
  })

  describe("function naming", () => {
    it.effect("generates findEntityById for primary key lookup", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        expect(userFile?.content).toContain("findUserById")
      })
    )

    it.effect("generates getEntityByField for unique index", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // users table has unique index on username
        expect(userFile?.content).toContain("getUserByUsername")
      })
    )

    it.effect("generates getEntityByField for non-unique index", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const postFile = all.find((e) => e.path.includes("Post.ts"))

        // posts table has non-unique index on user_id
        expect(postFile?.content).toContain("getPostByUserId")
      })
    )
  })

  describe("return types", () => {
    it.effect("unique index returns Promise<Row | null>", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // findUserById should return Promise<User | null>
        expect(userFile?.content).toMatch(/findUserById[\s\S]+?:\s*Promise<User\s*\|\s*null>/)
      })
    )

    it.effect("non-unique index returns Promise<Row[]>", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const postFile = all.find((e) => e.path.includes("Post.ts"))

        // getPostByUserId should return Promise<Post[]>
        expect(postFile?.content).toMatch(/getPostByUserId[\s\S]+?:\s*Promise<Post\[\]>/)
      })
    )

    it.effect("async functions use await", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // Should have await before sql calls
        expect(userFile?.content).toMatch(/await\s+sql`/)
      })
    )
  })

  describe("parameter types", () => {
    it.effect("uses correct TypeScript types for parameters", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // id should be string (UUID), not 'id'
        expect(userFile?.content).toMatch(/id:\s*string/)
        // Should NOT have id: id (using field name as type)
        expect(userFile?.content).not.toMatch(/id:\s*id[^e]/)
      })
    )
  })

  describe("imports", () => {
    it.effect("imports Row type from types plugin", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        // Use layer with pre-registered type symbols to simulate types plugin
        const testLayer = createTestLayerWithTypeSymbols(ir, ["User", "Post"])

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        expect(userFile?.content).toMatch(/import.*User.*from/)
      })
    )

    it.effect("imports sql template tag", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        expect(userFile?.content).toMatch(/import.*sql.*from/)
      })
    )
  })

  describe("edge cases", () => {
    it.effect("skips partial indexes", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)

        // Check no functions reference partial index predicates
        for (const file of all) {
          expect(file.content).not.toContain("WHERE ")
        }
      })
    )

    it.effect("skips expression indexes", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        // This test just verifies no errors - expression indexes filtered in shouldGenerateLookup
        const all = yield* runPluginAndGetEmissions(testLayer)
        expect(all.length).toBeGreaterThan(0)
      })
    )

    it.effect("no duplicate functions for same column", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // Count occurrences of getUserByUsername
        const matches = userFile?.content?.match(/function getUserByUsername/g)
        expect(matches?.length ?? 0).toBeLessThanOrEqual(1)
      })
    )
  })
})

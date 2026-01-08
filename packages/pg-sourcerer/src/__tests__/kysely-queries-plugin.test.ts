/**
 * Kysely Queries Plugin Tests
 *
 * Tests for the kysely-queries plugin that generates type-safe Kysely query functions.
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

import { kyselyQueriesPlugin } from "../plugins/kysely-queries.js"

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
    Layer.succeed(PluginMeta, { name: "kysely-queries" }),
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

describe("Kysely Queries Plugin", () => {
  describe("plugin structure", () => {
    it("has correct name", () => {
      expect(kyselyQueriesPlugin.plugin.name).toBe("kysely-queries")
    })

    it("provides queries capability", () => {
      expect(kyselyQueriesPlugin.plugin.provides).toContain("queries")
      expect(kyselyQueriesPlugin.plugin.provides).toContain("queries:kysely")
    })
  })

  describe("query generation", () => {
    it.effect("generates Kysely query chain syntax", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // Should have Kysely method chain pattern
        expect(userFile?.content).toContain("db.selectFrom")
        expect(userFile?.content).toContain("selectAll()")
        expect(userFile?.content).toContain(".where(")
      })
    )

    it.effect("uses schema-qualified table names", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // Should use schema.table format
        expect(userFile?.content).toContain('"app_public.users"')
      })
    )
  })

  describe("imports", () => {
    it.effect("imports Kysely type from kysely package", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        expect(userFile?.content).toMatch(/import.*Kysely.*from.*["']kysely["']/)
      })
    )

    it.effect("imports DB type from configured path", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries", dbTypesPath: "../database" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        expect(userFile?.content).toMatch(/import.*DB.*from.*["']\.\.\/database["']/)
      })
    )
  })

  describe("CRUD methods", () => {
    it.effect("generates findById method for entities with primary key", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        expect(userFile?.content).toContain("findById:")
        expect(userFile?.content).toContain("executeTakeFirst()")
      })
    )

    it.effect("generates findMany method with pagination", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        expect(userFile?.content).toContain("findMany:")
        expect(userFile?.content).toContain("$if(")
        expect(userFile?.content).toContain(".limit(")
        expect(userFile?.content).toContain(".offset(")
      })
    )

    it.effect("generates create method with insertInto", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const postFile = all.find((e) => e.path.includes("Post.ts"))

        expect(postFile?.content).toContain("create:")
        expect(postFile?.content).toContain("insertInto(")
        expect(postFile?.content).toContain(".values(data)")
        expect(postFile?.content).toContain("returningAll()")
      })
    )

    it.effect("generates remove method with deleteFrom", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const postFile = all.find((e) => e.path.includes("Post.ts"))

        expect(postFile?.content).toContain("remove:")
        expect(postFile?.content).toContain("deleteFrom(")
      })
    )
  })

  describe("namespace export style", () => {
    it.effect("exports object namespace with table name", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // Should export const users = { ... }
        expect(userFile?.content).toMatch(/export const users\s*=\s*\{/)
      })
    )

    it.effect("methods use db as first parameter", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // All methods should have db: Kysely<DB> as first param
        expect(userFile?.content).toMatch(/findById:\s*\(db:\s*Kysely<DB>/)
        // findMany has multiline formatting so use [\s\S] instead of \s
        expect(userFile?.content).toMatch(/findMany:[\s\S]*?\([\s\S]*?db:\s*Kysely<DB>/)
      })
    )
  })

  describe("index-based lookups", () => {
    it.effect("generates findByField for unique indexes", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // users table has unique index on username
        expect(userFile?.content).toContain("findByUsername:")
      })
    )

    it.effect("generates findByField for non-unique indexes", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const postFile = all.find((e) => e.path.includes("Post.ts"))

        // posts table has index on user_id
        expect(postFile?.content).toContain("findByUserId:")
        // Non-unique should use execute() not executeTakeFirst()
        expect(postFile?.content).toMatch(/findByUserId[\s\S]*?\.execute\(\)/)
      })
    )
  })

  describe("executeQueries option", () => {
    it.effect("includes execute calls by default", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const postFile = all.find((e) => e.path.includes("Post.ts"))

        expect(postFile?.content).toContain("executeTakeFirst()")
        expect(postFile?.content).toContain("execute()")
        expect(postFile?.content).toContain("executeTakeFirstOrThrow()")
      })
    )

    it.effect("omits execute calls when executeQueries is false", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries", executeQueries: false })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const postFile = all.find((e) => e.path.includes("Post.ts"))

        // Should NOT have any execute calls
        expect(postFile?.content).not.toContain("executeTakeFirst()")
        expect(postFile?.content).not.toContain("execute()")
        expect(postFile?.content).not.toContain("executeTakeFirstOrThrow()")
      })
    )

    it.effect("returns query builders when executeQueries is false", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries", executeQueries: false })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const postFile = all.find((e) => e.path.includes("Post.ts"))

        // Should still have query builder methods
        expect(postFile?.content).toContain("selectFrom(")
        expect(postFile?.content).toContain("insertInto(")
        expect(postFile?.content).toContain("updateTable(")
        expect(postFile?.content).toContain("deleteFrom(")
        expect(postFile?.content).toContain("returningAll()")
      })
    )
  })
})

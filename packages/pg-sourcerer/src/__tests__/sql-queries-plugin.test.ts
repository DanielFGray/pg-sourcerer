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

  // Pre-register Row and Insert type symbols as if types plugin had run
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
    // Also register insert type - needed for insert function generation
    symbols.register(
      {
        name: `${entity}Insert`,
        file: `types/${entity}.ts`,
        capability: "types",
        entity,
        shape: "insert",
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

  describe("string style (parameterized queries)", () => {
    it.effect("generates pool.query with parameterized SQL", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries", sqlStyle: "string" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // Should use pool.query instead of sql template tag
        expect(userFile?.content).toContain("pool.query")
        // Should have $1 placeholder instead of template interpolation
        expect(userFile?.content).toMatch(/\$1/)
      })
    )

    it.effect("imports pool instead of sql", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries", sqlStyle: "string" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        expect(userFile?.content).toMatch(/import.*pool.*from/)
        expect(userFile?.content).not.toMatch(/import.*\bsql\b.*from/)
      })
    )

    it.effect("extracts rows from query result for findById", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries", sqlStyle: "string" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // Should destructure { rows: [result] } from pool.query result
        expect(userFile?.content).toMatch(/\{\s*rows:\s*\[result\]\s*\}/)
      })
    )

    it.effect("extracts rows from query result for findMany", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries", sqlStyle: "string" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // Should destructure { rows } and return rows
        expect(userFile?.content).toMatch(/\{\s*rows\s*\}/)
        expect(userFile?.content).toMatch(/return rows/)
      })
    )

    it.effect("uses $1, $2, ... placeholders for multiple params", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries", sqlStyle: "string" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // findMany uses limit and offset - should have $1 and $2
        expect(userFile?.content).toMatch(/limit \$1 offset \$2/)
      })
    )

    it.effect("passes params array as second argument", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries", sqlStyle: "string" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // Should pass array of params as second argument
        expect(userFile?.content).toMatch(/pool\.query<[^>]+>\([^,]+,\s*\[/)
      })
    )

    it.effect("uses generic type parameter on pool.query", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries", sqlStyle: "string" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // Should use pool.query<User[]> type parameter (array because result.rows is T[])
        expect(userFile?.content).toMatch(/pool\.query<User\[\]>/)
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

  describe("insert generation", () => {
    it.effect("generates insertEntity function", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const postFile = all.find((e) => e.path.includes("Post.ts"))

        expect(postFile?.content).toContain("insertPost")
      })
    )

    it.effect("uses EntityInsert type for insert parameter", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const postFile = all.find((e) => e.path.includes("Post.ts"))

        // Should use data: PostInsert parameter
        expect(postFile?.content).toMatch(/insertPost\(data:\s*PostInsert\)/)
      })
    )

    it.effect("generates INSERT SQL with RETURNING clause", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const postFile = all.find((e) => e.path.includes("Post.ts"))

        // Should have INSERT ... RETURNING *
        expect(postFile?.content).toMatch(/insert into app_public\.posts.*returning \*/)
      })
    )

    it.effect("imports EntityInsert type when insert shape differs from row", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayerWithTypeSymbols(ir, ["Post"])

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const postFile = all.find((e) => e.path.includes("Post.ts"))

        // Should import PostInsert
        expect(postFile?.content).toMatch(/import.*PostInsert/)
      })
    )
  })

  describe("return types", () => {
    it.effect("unique index uses sql<Row[]> and destructures to get single result", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // findUserById should use sql<User[]> and destructure
        expect(userFile?.content).toMatch(/findUserById[\s\S]+?sql<User\[\]>/)
        expect(userFile?.content).toMatch(/const\s+\[result\]\s*=\s*await\s+sql<User\[\]>/)
      })
    )

    it.effect("non-unique index uses sql<Row[]> and returns array directly", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const postFile = all.find((e) => e.path.includes("Post.ts"))

        // getPostByUserId should return sql<Post[]> directly
        expect(postFile?.content).toMatch(/getPostByUserId[\s\S]+?return\s+await\s+sql<Post\[\]>/)
      })
    )

    it.effect("async functions use await with typed sql", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // Should have await before sql<Type> calls
        expect(userFile?.content).toMatch(/await\s+sql<\w+\[\]>`/)
      })
    )
  })

  describe("parameter types", () => {
    it.effect("uses Pick<Entity, field> for entity field parameters", () =>
      Effect.gen(function* () {
        const ir = yield* Effect.promise(() => buildTestIR(["app_public"]))
        const testLayer = createTestLayer(ir)

        yield* sqlQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // Should use Pick<User, "id"> for entity field parameters
        expect(userFile?.content).toMatch(/Pick<User,\s*"id">/)
        // Should use destructuring pattern { id }
        expect(userFile?.content).toMatch(/\{\s*id\s*\}:\s*Pick<User/)
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

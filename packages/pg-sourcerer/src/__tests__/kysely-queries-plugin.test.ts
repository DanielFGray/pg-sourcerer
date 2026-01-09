/**
 * Kysely Queries Plugin Tests
 *
 * Tests for the kysely-queries plugin that generates type-safe Kysely query functions.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { createIRBuilderService } from "../services/ir-builder.js"
import { InflectionLive } from "../services/inflection.js"
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

function buildTestIR(schemas: readonly string[]) {
  const builder = createIRBuilderService()
  return builder.build(introspection, { schemas }).pipe(Effect.provide(InflectionLive))
}

function createTestLayer(ir: SemanticIR) {
  const emissions = createEmissionBuffer()
  const symbols = createSymbolRegistry()

  return Layer.mergeAll(
    Layer.succeed(IR, ir),
    Layer.succeed(Emissions, emissions),
    Layer.succeed(Symbols, symbols),
    Layer.succeed(PluginMeta, { name: "kysely-queries" }),
    InflectionLive,
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
        const ir = yield* buildTestIR(["app_public"])
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

    it.effect("uses unqualified table names for default schemas", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // When schema is in defaultSchemas, use unqualified name to match DB interface
        expect(userFile?.content).toContain('"users"')
        // Should NOT contain schema-qualified name
        expect(userFile?.content).not.toContain('"app_public.users"')
      })
    )
  })

  describe("imports", () => {
    it.effect("imports Kysely type from kysely package", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
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
        const ir = yield* buildTestIR(["app_public"])
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
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // Flat exports with entity prefix: UserFindById (PascalCase default)
        expect(userFile?.content).toContain("export const UserFindById")
        expect(userFile?.content).toContain("executeTakeFirst()")
      })
    )

    it.effect("generates listMany method with pagination when enabled", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries", generateListMany: true })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        expect(userFile?.content).toContain("export const UserListMany")
        expect(userFile?.content).toContain("limit = 50")
        expect(userFile?.content).toContain("offset = 0")
        expect(userFile?.content).toContain(".limit(limit)")
        expect(userFile?.content).toContain(".offset(offset)")
      })
    )

    it.effect("does not generate listMany by default", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        expect(userFile?.content).not.toContain("ListMany")
      })
    )

    it.effect("generates create method with insertInto", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const postFile = all.find((e) => e.path.includes("Post.ts"))

        expect(postFile?.content).toContain("export const PostCreate")
        expect(postFile?.content).toContain("insertInto(")
        expect(postFile?.content).toContain(".values(data)")
        expect(postFile?.content).toContain("returningAll()")
      })
    )

    it.effect("generates remove method with deleteFrom", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const postFile = all.find((e) => e.path.includes("Post.ts"))

        expect(postFile?.content).toContain("export const PostRemove")
        expect(postFile?.content).toContain("deleteFrom(")
      })
    )
  })

  describe("flat export style", () => {
    it.effect("exports flat constants with entity prefix", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // Should export flat constants like UserFindById, UserCreate, etc. (PascalCase default)
        expect(userFile?.content).toContain("export const UserFindById")
        expect(userFile?.content).toContain("export const UserCreate")
      })
    )

    it.effect("methods use db as first parameter", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // All methods should have db: Kysely<DB> as first param
        expect(userFile?.content).toMatch(/UserFindById\s*=\s*\(db:\s*Kysely<DB>/)
      })
    )
  })

  describe("index-based lookups", () => {
    it.effect("generates findByField for unique indexes", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const userFile = all.find((e) => e.path.includes("User.ts"))

        // users table has unique index on username
        expect(userFile?.content).toContain("export const UserFindOneByUsername")
      })
    )

    it.effect("generates findByField for non-unique indexes", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const postFile = all.find((e) => e.path.includes("Post.ts"))

        // posts table has index on user_id (FK to users)
        // Uses semantic naming: PostFindManyByUser instead of PostFindManyByUserId
        expect(postFile?.content).toContain("export const PostFindManyByUser")
        // Non-unique should use execute() not executeTakeFirst()
        expect(postFile?.content).toMatch(/PostFindManyByUser[\s\S]*?\.execute\(\)/)
      })
    )
  })

  describe("executeQueries option", () => {
    it.effect("includes execute calls by default", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
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
        const ir = yield* buildTestIR(["app_public"])
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
        const ir = yield* buildTestIR(["app_public"])
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

  describe("function wrappers", () => {
    it.effect("generates functions.ts for scalar-returning functions", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public", "app_private"])
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const functionsFile = all.find((e) => e.path.includes("functions.ts"))

        expect(functionsFile).toBeDefined()
        // Scalar functions should be in functions.ts
        expect(functionsFile?.content).toContain("export const currentSessionId")
        expect(functionsFile?.content).toContain("export const currentUserId")
        expect(functionsFile?.content).toContain("export const verifyEmail")
        // Table-returning functions should NOT be in functions.ts
        expect(functionsFile?.content).not.toContain("currentUser =")
      })
    )

    it.effect("generates scalar function wrappers with selectNoFrom", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public", "app_private"])
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const functionsFile = all.find((e) => e.path.includes("functions.ts"))

        // current_session_id returns uuid (scalar)
        expect(functionsFile?.content).toContain("currentSessionId")
        expect(functionsFile?.content).toContain("selectNoFrom")
      })
    )

    it.effect("generates table-returning function wrappers in entity file", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public", "app_private"])
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        // current_user returns app_public.users (table) - should be in User.ts
        const userFile = all.find((e) => e.path.includes("User.ts"))

        expect(userFile?.content).toContain("export const currentUser")
        expect(userFile?.content).toContain("selectFrom")
        expect(userFile?.content).toContain("selectAll")
      })
    )

    it.effect("generates volatile functions as flat exports", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public", "app_private"])
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const functionsFile = all.find((e) => e.path.includes("functions.ts"))

        // verify_email is volatile, should be a flat export with camelCase name
        expect(functionsFile?.content).toContain("export const verifyEmail")
      })
    )

    it.effect("filters out computed field functions (row-type arguments)", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public", "app_private"])
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const functionsFile = all.find((e) => e.path.includes("functions.ts"))

        // posts_short_body takes a posts row - should be filtered out
        expect(functionsFile?.content).not.toContain("postsShortBody")
        // Same for other computed fields
        expect(functionsFile?.content).not.toContain("postsScore")
        expect(functionsFile?.content).not.toContain("postsPopularity")
      })
    )

    it.effect("can disable function generation via config", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public", "app_private"])
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries", generateFunctions: false })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const functionsFile = all.find((e) => e.path.includes("functions.ts"))

        expect(functionsFile).toBeUndefined()
      })
    )

    it.effect("generates composite-returning function wrappers in separate file", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public", "app_private"])
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        // username_search returns app_public.username_search composite type
        const usernameSearchFile = all.find((e) => e.path.includes("UsernameSearch.ts"))

        expect(usernameSearchFile).toBeDefined()
        expect(usernameSearchFile?.content).toContain("export const usernameSearch")
        // Should have args: substr and match_type
        expect(usernameSearchFile?.content).toContain("substr")
        expect(usernameSearchFile?.content).toContain("match_type")
      })
    )

    it.effect("uses eb.fn with qualified function name", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public", "app_private"])
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const functionsFile = all.find((e) => e.path.includes("functions.ts"))

        // Should use fully qualified function name in eb.fn call
        expect(functionsFile?.content).toContain('"app_public.current_session_id"')
        expect(functionsFile?.content).toContain('"app_public.verify_email"')
      })
    )

    it.effect("generates function wrappers with correct parameter types", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public", "app_private"])
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const functionsFile = all.find((e) => e.path.includes("functions.ts"))

        // verify_email has user_email_id: uuid and token: text
        expect(functionsFile?.content).toMatch(/verifyEmail.*user_email_id:\s*string.*token:\s*string/)
      })
    )

    it.effect("uses selectFrom with SETOF-returning functions", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public", "app_private"])
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        // username_search returns SETOF - should use selectFrom and execute()
        const usernameSearchFile = all.find((e) => e.path.includes("UsernameSearch.ts"))

        expect(usernameSearchFile?.content).toContain("selectFrom")
        expect(usernameSearchFile?.content).toContain(".execute()")
      })
    )

    it.effect("uses executeTakeFirst for single-row returning functions", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public", "app_private"])
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        // current_user returns single row - should use executeTakeFirst
        const userFile = all.find((e) => e.path.includes("User.ts"))

        expect(userFile?.content).toMatch(/currentUser[\s\S]*?executeTakeFirst\(\)/)
      })
    )

    it.effect("imports DB type for all function files", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public", "app_private"])
        const testLayer = createTestLayer(ir)

        yield* kyselyQueriesPlugin.plugin.run({ outputDir: "queries" })
          .pipe(Effect.provide(testLayer))

        const all = yield* runPluginAndGetEmissions(testLayer)
        const functionsFile = all.find((e) => e.path.includes("functions.ts"))

        expect(functionsFile?.content).toMatch(/import.*\bDB\b.*from/)
        expect(functionsFile?.content).toMatch(/import.*\bKysely\b.*from.*["']kysely["']/)
      })
    )
  })
})

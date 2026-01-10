/**
 * HTTP Elysia Plugin Tests
 *
 * Tests for the http-elysia plugin that generates Elysia route handlers.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { createIRBuilderService } from "../services/ir-builder.js"
import { InflectionLive } from "../services/inflection.js"
import { Emissions, createEmissionBuffer } from "../services/emissions.js"
import { Symbols, createSymbolRegistry } from "../services/symbols.js"
import { TypeHintsLive } from "../services/type-hints.js"
import { ArtifactStore, createArtifactStore, type ArtifactStoreImpl } from "../services/artifact-store.js"
import { PluginMeta } from "../services/plugin-meta.js"
import { IR } from "../services/ir.js"
import { loadIntrospectionFixture } from "./fixtures/index.js"
import type { SemanticIR } from "../ir/semantic-ir.js"
import { conjure } from "../lib/conjure.js"

import { httpElysiaPlugin } from "../plugins/http-elysia.js"

// Local type for test mock data - mirrors what query plugins emit
interface MockQueryArtifact {
  entities: Array<{
    entityName: string
    tableName: string
    schemaName: string
    pkType?: string
    hasCompositePk?: boolean
    methods: Array<{
      name: string
      kind: "read" | "list" | "create" | "update" | "delete" | "lookup" | "function"
      params: Array<{
        name: string
        type: string
        required: boolean
        columnName?: string
        source?: "pk" | "fk" | "lookup" | "body" | "pagination"
      }>
      returns: { type: string; nullable: boolean; isArray: boolean }
      lookupField?: string
      isUniqueLookup?: boolean
      callSignature?: { style: "named" | "positional"; bodyStyle?: "property" | "spread" }
    }>
  }>
  functions: Array<{
    functionName: string
    exportName: string
    schemaName: string
    volatility: "immutable" | "stable" | "volatile"
    params: Array<{
      name: string
      type: string
      required: boolean
      source?: "pk" | "fk" | "lookup" | "body" | "pagination"
    }>
    returns: { type: string; nullable: boolean; isArray: boolean }
    callSignature?: { style: "named" | "positional"; bodyStyle?: "property" | "spread" }
  }>
  sourcePlugin: string
  outputDir: string
}

const introspection = loadIntrospectionFixture()

function buildTestIR(schemas: readonly string[]) {
  const builder = createIRBuilderService()
  return builder.build(introspection, { schemas }).pipe(Effect.provide(InflectionLive))
}

/**
 * Create a test layer with a pre-populated artifact store.
 */
function createTestLayer(ir: SemanticIR, artifacts: Record<string, unknown> = {}): {
  layer: Layer.Layer<any, any, any>
  artifactStore: ArtifactStoreImpl
  emissions: ReturnType<typeof createEmissionBuffer>
} {
  const emissions = createEmissionBuffer()
  const symbols = createSymbolRegistry()
  const artifactStore = createArtifactStore()

  // Pre-populate artifacts
  for (const [capability, data] of Object.entries(artifacts)) {
    artifactStore.set(capability, "test-plugin", data)
  }

  const layer = Layer.mergeAll(
    Layer.succeed(IR, ir),
    Layer.succeed(Emissions, emissions),
    Layer.succeed(Symbols, symbols),
    Layer.succeed(PluginMeta, { name: "http-elysia" }),
    Layer.succeed(ArtifactStore, artifactStore),
    InflectionLive,
    TypeHintsLive([]),
  )

  return { layer, artifactStore, emissions }
}

/**
 * Create a mock MockQueryArtifact for testing.
 */
function createMockQueryArtifact(): MockQueryArtifact {
  return {
    entities: [
      {
        entityName: "User",
        tableName: "users",
        schemaName: "app_public",
        pkType: "number",
        hasCompositePk: false,
        methods: [
          {
            name: "findUserById",
            kind: "read",
            params: [{ name: "id", type: "number", required: true, columnName: "id", source: "pk" }],
            returns: { type: "UserRow", nullable: true, isArray: false },
          },
          {
            name: "findUserManys",
            kind: "list",
            params: [
              { name: "limit", type: "number", required: false, source: "pagination" },
              { name: "offset", type: "number", required: false, source: "pagination" },
            ],
            returns: { type: "UserRow", nullable: false, isArray: true },
          },
          {
            name: "insertUser",
            kind: "create",
            params: [{ name: "data", type: "UserInsert", required: true, source: "body" }],
            returns: { type: "UserRow", nullable: false, isArray: false },
          },
          {
            name: "deleteUser",
            kind: "delete",
            params: [{ name: "id", type: "number", required: true, columnName: "id", source: "pk" }],
            returns: { type: "void", nullable: false, isArray: false },
          },
        ],
      },
      {
        entityName: "Post",
        tableName: "posts",
        schemaName: "app_public",
        pkType: "number",
        hasCompositePk: false,
        methods: [
          {
            name: "findPostById",
            kind: "read",
            params: [{ name: "id", type: "number", required: true, columnName: "id", source: "pk" }],
            returns: { type: "PostRow", nullable: true, isArray: false },
          },
        ],
      },
    ],
    functions: [],
    sourcePlugin: "sql-queries",
    outputDir: "sql-queries",
  }
}

describe("HTTP Elysia Plugin", () => {
  describe("plugin structure", () => {
    it("has correct name", () => {
      expect(httpElysiaPlugin.plugin.name).toBe("http-elysia")
    })

    it("provides http capabilities", () => {
      expect(httpElysiaPlugin.plugin.provides).toContain("http")
      expect(httpElysiaPlugin.plugin.provides).toContain("http:elysia")
    })

    it("requires queries capability (schemas optional)", () => {
      expect(httpElysiaPlugin.plugin.requires).toContain("queries")
      // schemas is optional - plugin generates inline TypeBox when not available
      expect(httpElysiaPlugin.plugin.requires).not.toContain("schemas")
    })
  })

  describe("config schema", () => {
    it("has default outputDir", () => {
      // Config defaults are applied by Effect Schema
      expect(httpElysiaPlugin.plugin.configSchema).toBeDefined()
    })
  })

  describe("artifact consumption", () => {
    it.effect("does nothing when no query artifact is available", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const { layer, emissions } = createTestLayer(ir, {})

        yield* httpElysiaPlugin.plugin.run({ outputDir: "routes" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()

        // No files should be emitted when no artifact
        expect(all.length).toBe(0)
      })
    )

    it.effect("consumes queries:sql artifact by default", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockQueryArtifact()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpElysiaPlugin.plugin.run({ outputDir: "routes" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()

        // Should emit files for each entity
        expect(all.length).toBeGreaterThan(0)
      })
    )

    it.effect("auto-detects queries:kysely artifact", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact: MockQueryArtifact = {
          ...createMockQueryArtifact(),
          sourcePlugin: "kysely-queries",
          outputDir: "kysely-queries",
        }
        const { layer, emissions } = createTestLayer(ir, {
          "queries:kysely": mockArtifact,
        })

        // No explicit config needed - should auto-detect
        yield* httpElysiaPlugin.plugin.run({ 
          outputDir: "routes",
        }).pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()

        // Should emit files for each entity
        expect(all.length).toBeGreaterThan(0)
      })
    )

    it.effect("derives import path from artifact outputDir", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact: MockQueryArtifact = {
          ...createMockQueryArtifact(),
          sourcePlugin: "kysely-queries",
          outputDir: "kysely-queries",
        }
        const { layer, emissions } = createTestLayer(ir, {
          "queries:kysely": mockArtifact,
        })

        yield* httpElysiaPlugin.plugin.run({ outputDir: "routes" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()
        const userFile = all.find(e => e.path.includes("user.ts"))

        // Should import from the artifact's outputDir
        expect(userFile!.content).toContain('../kysely-queries/User')
      })
    )
  })

  describe("file generation", () => {
    it.effect("generates per-entity files by default", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockQueryArtifact()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpElysiaPlugin.plugin.run({ outputDir: "routes" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()

        // Should have separate files for User and Post
        const userFile = all.find(e => e.path.includes("user.ts"))
        const postFile = all.find(e => e.path.includes("post.ts"))
        
        expect(userFile).toBeDefined()
        expect(postFile).toBeDefined()
      })
    )

    it.effect("generates Elysia route chain with prefix", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockQueryArtifact()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpElysiaPlugin.plugin.run({ outputDir: "routes" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()
        const userFile = all.find(e => e.path.includes("user.ts"))
        
        expect(userFile).toBeDefined()
        const code = userFile!.content

        // Should create new Elysia with prefix
        expect(code).toContain('new Elysia')
        expect(code).toContain('prefix')
        expect(code).toContain('/api/users')

        // Should have route methods
        expect(code).toContain('.get(')
        expect(code).toContain('.post(')
        expect(code).toContain('.delete(')

        // Should export routes variable
        expect(code).toContain('export const userRoutes')
      })
    )

    it.effect("generates route handler that calls query function", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockQueryArtifact()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpElysiaPlugin.plugin.run({ outputDir: "routes" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()
        const userFile = all.find(e => e.path.includes("user.ts"))
        
        const code = userFile!.content

        // Should call query functions
        expect(code).toContain('findUserById')
        expect(code).toContain('insertUser')
        expect(code).toContain('deleteUser')

        // Should have async handlers
        expect(code).toContain('async')

        // Should handle 404 for nullable returns
        expect(code).toContain('status(404')
      })
    )

    it.effect("generates correct path parameters", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockQueryArtifact()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpElysiaPlugin.plugin.run({ outputDir: "routes" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()
        const userFile = all.find(e => e.path.includes("user.ts"))
        
        const code = userFile!.content

        // Should have path parameters like /:id
        expect(code).toContain('/:id')

        // Should extract params from context
        expect(code).toContain('params')
      })
    )

    it.effect("imports query functions from configured path", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockQueryArtifact()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpElysiaPlugin.plugin.run({ 
          outputDir: "routes",
          queriesPath: "../custom-queries",
        }).pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()
        const userFile = all.find(e => e.path.includes("user.ts"))
        
        const code = userFile!.content

        // Should import from custom path
        expect(code).toContain('../custom-queries/User')
      })
    )
  })

  describe("function routes", () => {
    function createMockArtifactWithFunctions(): MockQueryArtifact {
      return {
        entities: [],
        functions: [
          {
            functionName: "current_user",
            exportName: "currentUser",
            schemaName: "app_public",
            volatility: "stable",
            params: [],
            returns: { type: "User", nullable: true, isArray: false },
          },
          {
            functionName: "verify_email",
            exportName: "verifyEmail",
            schemaName: "app_public",
            volatility: "volatile",
            params: [
              { name: "user_email_id", type: "string", required: true },
              { name: "token", type: "string", required: true },
            ],
            returns: { type: "boolean", nullable: false, isArray: false },
          },
          {
            functionName: "search_users",
            exportName: "searchUsers",
            schemaName: "app_public",
            volatility: "stable",
            params: [
              { name: "query", type: "string", required: true },
              { name: "limit", type: "number", required: false },
            ],
            returns: { type: "User", nullable: false, isArray: true },
          },
        ],
        sourcePlugin: "sql-queries",
        outputDir: "sql-queries",
      }
    }

    it.effect("generates function routes file", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockArtifactWithFunctions()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpElysiaPlugin.plugin.run({ outputDir: "routes" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()
        const fnFile = all.find(e => e.path.includes("functions.ts"))

        expect(fnFile).toBeDefined()
        expect(fnFile!.content).toContain("export const functionRoutes")
      })
    )

    it.effect("imports function wrappers from queries path", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockArtifactWithFunctions()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpElysiaPlugin.plugin.run({ outputDir: "routes" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()
        const fnFile = all.find(e => e.path.includes("functions.ts"))

        const code = fnFile!.content
        expect(code).toContain("currentUser")
        expect(code).toContain("verifyEmail")
        expect(code).toContain("searchUsers")
        expect(code).toContain("../sql-queries/functions.js")
      })
    )

    it.effect("uses GET for stable/immutable functions", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockArtifactWithFunctions()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpElysiaPlugin.plugin.run({ outputDir: "routes" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()
        const fnFile = all.find(e => e.path.includes("functions.ts"))

        const code = fnFile!.content
        // stable function currentUser should use .get()
        expect(code).toContain('.get("/current-user"')
        // stable function searchUsers should use .get()
        expect(code).toContain('.get("/search-users"')
      })
    )

    it.effect("uses POST for volatile functions", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockArtifactWithFunctions()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpElysiaPlugin.plugin.run({ outputDir: "routes" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()
        const fnFile = all.find(e => e.path.includes("functions.ts"))

        const code = fnFile!.content
        // volatile function verifyEmail should use .post()
        expect(code).toContain('.post("/verify-email"')
      })
    )

    it.effect("validates query params for GET functions", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockArtifactWithFunctions()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpElysiaPlugin.plugin.run({ outputDir: "routes" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()
        const fnFile = all.find(e => e.path.includes("functions.ts"))

        const code = fnFile!.content
        // Should have t import for validation
        expect(code).toContain('import { Elysia, t } from "elysia"')
        // Should validate query params for searchUsers
        expect(code).toContain("query:")
      })
    )

    it.effect("validates body params for POST functions", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockArtifactWithFunctions()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpElysiaPlugin.plugin.run({ outputDir: "routes" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()
        const fnFile = all.find(e => e.path.includes("functions.ts"))

        const code = fnFile!.content
        // Should validate body for verifyEmail
        expect(code).toContain("body:")
      })
    )

    it.effect("handles nullable returns with 404", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockArtifactWithFunctions()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpElysiaPlugin.plugin.run({ outputDir: "routes" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()
        const fnFile = all.find(e => e.path.includes("functions.ts"))

        const code = fnFile!.content
        // currentUser returns nullable, should handle 404
        expect(code).toContain("status(404")
      })
    )

    it.effect("skips function routes when includeFunctions is false", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockArtifactWithFunctions()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpElysiaPlugin.plugin.run({ 
          outputDir: "routes",
          includeFunctions: false,
        }).pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()
        const fnFile = all.find(e => e.path.includes("functions.ts"))

        expect(fnFile).toBeUndefined()
      })
    )

    it.effect("applies function prefix from config", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockArtifactWithFunctions()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpElysiaPlugin.plugin.run({ 
          outputDir: "routes",
          paths: { functionPrefix: "fn" },
        }).pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()
        const fnFile = all.find(e => e.path.includes("functions.ts"))

        const code = fnFile!.content
        // Should have /api/fn prefix
        expect(code).toContain('prefix: "/api/fn"')
      })
    )
  })

  describe("aggregator index", () => {
    it.effect("generates index.ts that aggregates all routes", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockQueryArtifact()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpElysiaPlugin.plugin.run({ outputDir: "routes" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()
        const indexFile = all.find(e => e.path === "routes/index.ts")

        expect(indexFile).toBeDefined()
        const code = indexFile!.content

        // Should export aggregated router
        expect(code).toContain("export const api")

        // Should import individual route modules
        expect(code).toContain('import { userRoutes } from "./user.js"')
        expect(code).toContain('import { postRoutes } from "./post.js"')

        // Should use .use() to combine routes
        expect(code).toContain(".use(userRoutes)")
        expect(code).toContain(".use(postRoutes)")
      })
    )

    it.effect("includes function routes in aggregator", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact: MockQueryArtifact = {
          ...createMockQueryArtifact(),
          functions: [
            {
              functionName: "current_user",
              exportName: "currentUser",
              schemaName: "app_public",
              volatility: "stable",
              params: [],
              returns: { type: "User", nullable: true, isArray: false },
            },
          ],
        }
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpElysiaPlugin.plugin.run({ outputDir: "routes" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()
        const indexFile = all.find(e => e.path === "routes/index.ts")

        const code = indexFile!.content
        expect(code).toContain('import { functionRoutes } from "./functions.js"')
        expect(code).toContain(".use(functionRoutes)")
      })
    )

    it.effect("allows custom aggregator name", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockQueryArtifact()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpElysiaPlugin.plugin.run({ 
          outputDir: "routes",
          aggregatorName: "routes",
        }).pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()
        const indexFile = all.find(e => e.path === "routes/index.ts")

        const code = indexFile!.content
        expect(code).toContain("export const routes")
      })
    )

    it.effect("skips index when generateIndex is false", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockQueryArtifact()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpElysiaPlugin.plugin.run({ 
          outputDir: "routes",
          generateIndex: false,
        }).pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()
        const indexFile = all.find(e => e.path === "routes/index.ts")

        expect(indexFile).toBeUndefined()
      })
    )

    it.effect("skips index when outputStyle is single", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockQueryArtifact()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpElysiaPlugin.plugin.run({ 
          outputDir: "routes",
          outputStyle: "single",
        }).pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()
        
        // In single mode, there's only index.ts with all routes inline, not an aggregator
        const files = all.map(e => e.path)
        expect(files).toContain("routes/index.ts")
        // Should NOT have separate entity files
        expect(files).not.toContain("routes/user.ts")
      })
    )
  })
})

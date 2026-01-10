/**
 * HTTP oRPC Plugin Tests
 *
 * Tests for the http-orpc plugin that generates oRPC routers.
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

import { httpOrpcPlugin } from "../plugins/http-orpc.js"

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
    Layer.succeed(PluginMeta, { name: "http-orpc" }),
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
            name: "updateUser",
            kind: "update",
            params: [{ name: "data", type: "UserUpdate", required: true, source: "body" }],
            returns: { type: "UserRow", nullable: false, isArray: false },
          },
          {
            name: "deleteUser",
            kind: "delete",
            params: [{ name: "id", type: "number", required: true, columnName: "id", source: "pk" }],
            returns: { type: "void", nullable: false, isArray: false },
          },
          {
            name: "findUserByEmail",
            kind: "lookup",
            lookupField: "email",
            isUniqueLookup: true,
            params: [{ name: "email", type: "string", required: true, columnName: "email", source: "lookup" }],
            returns: { type: "UserRow", nullable: true, isArray: false },
          },
          {
            name: "currentUser",
            kind: "function",
            params: [],
            returns: { type: "UserRow", nullable: true, isArray: false },
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

describe("HTTP oRPC Plugin", () => {
  describe("plugin structure", () => {
    it("has correct name", () => {
      expect(httpOrpcPlugin.plugin.name).toBe("http-orpc")
    })

    it("provides http capabilities", () => {
      expect(httpOrpcPlugin.plugin.provides).toContain("http")
      expect(httpOrpcPlugin.plugin.provides).toContain("http:orpc")
    })

    it("requires queries and schemas capabilities", () => {
      expect(httpOrpcPlugin.plugin.requires).toContain("queries")
      expect(httpOrpcPlugin.plugin.requires).toContain("schemas")
    })
  })

  describe("config schema", () => {
    it("has default outputDir", () => {
      expect(httpOrpcPlugin.plugin.configSchema).toBeDefined()
    })
  })

  describe("artifact consumption", () => {
    it.effect("does nothing when no query artifact is available", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const { layer, emissions } = createTestLayer(ir, {})

        yield* httpOrpcPlugin.plugin.run({ outputDir: "orpc" })
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

        yield* httpOrpcPlugin.plugin.run({ outputDir: "orpc" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()

        // Should emit files for each entity
        expect(all.length).toBeGreaterThan(0)
      })
    )

    it.effect("consumes queries:kysely artifact when configured", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact: MockQueryArtifact = {
          ...createMockQueryArtifact(),
          sourcePlugin: "kysely-queries",
        }
        const { layer, emissions } = createTestLayer(ir, {
          "queries:kysely": mockArtifact,
        })

        yield* httpOrpcPlugin.plugin.run({ 
          outputDir: "orpc",
        }).pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()

        expect(all.length).toBeGreaterThan(0)
      })
    )
  })

  describe("file generation", () => {
    it.effect("generates per-entity router files", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockQueryArtifact()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpOrpcPlugin.plugin.run({ outputDir: "orpc" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()

        const paths = all.map(e => e.path)
        expect(paths).toContain("orpc/user.ts")
        expect(paths).toContain("orpc/post.ts")
      })
    )

    it.effect("imports os and type from @orpc/server", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockQueryArtifact()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpOrpcPlugin.plugin.run({ outputDir: "orpc" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()

        const userFile = all.find(e => e.path === "orpc/user.ts")
        expect(userFile).toBeDefined()
        expect(userFile!.content).toContain('import { os, type } from "@orpc/server"')
      })
    )

    it.effect("imports query functions from queries path", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockQueryArtifact()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpOrpcPlugin.plugin.run({ outputDir: "orpc" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()

        const userFile = all.find(e => e.path === "orpc/user.ts")
        expect(userFile).toBeDefined()
        expect(userFile!.content).toContain('from "../sql-queries/User.js"')
        expect(userFile!.content).toContain("findUserById")
        expect(userFile!.content).toContain("insertUser")
      })
    )

    it.effect("generates procedure exports", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockQueryArtifact()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpOrpcPlugin.plugin.run({ outputDir: "orpc" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()

        const userFile = all.find(e => e.path === "orpc/user.ts")
        expect(userFile).toBeDefined()
        // Check for exported procedures
        expect(userFile!.content).toContain("export const findById")
        expect(userFile!.content).toContain("export const list")
        expect(userFile!.content).toContain("export const create")
        expect(userFile!.content).toContain("export const update")
        expect(userFile!.content).toContain("export const remove")
        expect(userFile!.content).toContain("export const findByEmail")
        // Function procedures get Fn suffix to avoid import conflicts
        expect(userFile!.content).toContain("export const currentUserFn")
      })
    )

    it.effect("generates router export", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockQueryArtifact()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpOrpcPlugin.plugin.run({ outputDir: "orpc" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()

        const userFile = all.find(e => e.path === "orpc/user.ts")
        expect(userFile).toBeDefined()
        expect(userFile!.content).toContain("export const userRouter")
      })
    )

    it.effect("uses type<>() for simple params", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockQueryArtifact()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpOrpcPlugin.plugin.run({ outputDir: "orpc" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()

        const userFile = all.find(e => e.path === "orpc/user.ts")
        expect(userFile).toBeDefined()
        // Check that type<>() is used for params
        expect(userFile!.content).toContain("type<")
      })
    )

    it.effect("returns success object for delete procedures", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockQueryArtifact()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpOrpcPlugin.plugin.run({ outputDir: "orpc" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()

        const userFile = all.find(e => e.path === "orpc/user.ts")
        expect(userFile).toBeDefined()
        expect(userFile!.content).toContain("success: true")
      })
    )
  })

  describe("entity config overrides", () => {
    it.effect("respects disableMethods config", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockQueryArtifact()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpOrpcPlugin.plugin.run({
          outputDir: "orpc",
          entities: {
            User: {
              disableMethods: ["deleteUser"],
            },
          },
        }).pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()

        const userFile = all.find(e => e.path === "orpc/user.ts")
        expect(userFile).toBeDefined()
        // Should not include the remove procedure
        expect(userFile!.content).not.toContain("export const remove")
      })
    )
  })

  describe("custom config", () => {
    it.effect("respects custom outputDir", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockQueryArtifact()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpOrpcPlugin.plugin.run({ outputDir: "custom-orpc" })
          .pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()

        const paths = all.map(e => e.path)
        expect(paths).toContain("custom-orpc/user.ts")
      })
    )

    it.effect("respects custom queriesPath", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockQueryArtifact()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpOrpcPlugin.plugin.run({
          outputDir: "orpc",
          queriesPath: "../custom-queries",
        }).pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()

        const userFile = all.find(e => e.path === "orpc/user.ts")
        expect(userFile).toBeDefined()
        expect(userFile!.content).toContain('from "../custom-queries/User.js"')
      })
    )

    it.effect("includes custom header when provided", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"])
        const mockArtifact = createMockQueryArtifact()
        const { layer, emissions } = createTestLayer(ir, {
          "queries:sql": mockArtifact,
        })

        yield* httpOrpcPlugin.plugin.run({
          outputDir: "orpc",
          header: "// Custom header comment",
        }).pipe(Effect.provide(layer))

        const symbols = yield* Symbols.pipe(Effect.provide(layer))
        emissions.serializeAst(conjure.print, symbols)
        const all = emissions.getAll()

        const userFile = all.find(e => e.path === "orpc/user.ts")
        expect(userFile).toBeDefined()
        expect(userFile!.content).toContain("// Custom header comment")
      })
    )
  })
})

/**
 * Core Pipeline Integration Test
 *
 * Exercises the complete core pipeline:
 * 1. Build IR from test introspection fixture
 * 2. Prepare plugins (capability resolution, ordering)
 * 3. Run plugins (emit code, register symbols)
 * 4. Validate emissions (no conflicts)
 * 5. Validate symbols (no collisions)
 * 6. Write files (dry-run or real)
 *
 * This test proves all components work together end-to-end.
 */
import { describe, expect, layer } from "@effect/vitest"
import { Effect, Layer, Schema as S } from "effect"
import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"

import { PluginRunner, type ConfiguredPlugin } from "../services/plugin-runner.js"
import { definePlugin } from "../services/plugin.js"
import { createIRBuilderService } from "../services/ir-builder.js"
import { InflectionLive } from "../services/inflection.js"
import { createFileWriter } from "../services/file-writer.js"
import { TypeHintsLive } from "../services/type-hints.js"
import type { SemanticIR } from "../ir/semantic-ir.js"
import { isTableEntity, getTableEntities } from "../ir/semantic-ir.js"
import { loadIntrospectionFixture } from "./fixtures/index.js"

// Load the test fixture
const introspection = loadIntrospectionFixture()

// Platform layers for file operations
const PlatformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)

// Combined layer for tests that need PluginRunner with ClassicInflection
const TestLayer = Layer.mergeAll(
  Layer.provide(PluginRunner.DefaultWithoutDependencies, InflectionLive),
  PlatformLayer,
  TypeHintsLive([]) // Empty type hints for tests
)

// ============================================================================
// Test Plugins
// ============================================================================

/**
 * Simple plugin that generates TypeScript interfaces for each entity
 */
const typesPlugin = definePlugin({
  name: "types",
  provides: ["types"],
  configSchema: S.Struct({
    outputDir: S.String,
  }),
  inflection: {
    outputFile: (ctx) => `types/${ctx.entityName}.ts`,
    symbolName: (entity, kind) => `${entity}${kind}`,
  },
  run: (ctx, config) => {
    for (const [name, entity] of ctx.ir.entities) {
      // Skip enums - only process table/view entities
      if (!isTableEntity(entity)) continue
      
      const rowShape = entity.shapes.row
      if (!rowShape) continue

      // Generate simple interface with field names (not actual types for now)
      const fields = rowShape.fields
        .map((f) => `  ${f.name}: unknown; // ${f.columnName}`)
        .join("\n")

      const content = `export interface ${name} {\n${fields}\n}\n`
      ctx.emit(`${config.outputDir}/${name}.ts`, content)

      // Register the symbol for cross-file imports
      ctx.symbols.register(
        {
          name,
          file: `${config.outputDir}/${name}.ts`,
          capability: "types",
          entity: name,
          isType: true,
          isDefault: false,
        },
        ctx.pluginName
      )
    }
  },
})

/**
 * Plugin that depends on types and generates validators
 */
const validatorsPlugin = definePlugin({
  name: "validators",
  provides: ["validators"],
  requires: ["types"],
  configSchema: S.Struct({
    outputDir: S.String,
  }),
  inflection: {
    outputFile: (ctx) => `validators/${ctx.entityName}.ts`,
    symbolName: (entity, kind) => `validate${entity}${kind}`,
  },
  run: (ctx, config) => {
    for (const [name, entity] of ctx.ir.entities) {
      // Skip enums - only process table/view entities
      if (!isTableEntity(entity)) continue
      
      const rowShape = entity.shapes.row
      if (!rowShape) continue

      // Resolve the type symbol for import
      const typeSymbol = ctx.symbols.resolve({
        capability: "types",
        entity: name,
      })

      const importLine = typeSymbol
        ? `import type { ${typeSymbol.name} } from "../types/${name}.js";\n\n`
        : ""

      const content = `${importLine}export function validate${name}(data: unknown): data is ${name} {\n  // TODO: implement validation\n  return true;\n}\n`
      ctx.emit(`${config.outputDir}/${name}.ts`, content)

      ctx.symbols.register(
        {
          name: `validate${name}`,
          file: `${config.outputDir}/${name}.ts`,
          capability: "validators",
          entity: name,
          isType: false,
          isDefault: false,
        },
        ctx.pluginName
      )
    }
  },
})

/**
 * Plugin that produces an artifact for downstream plugins
 */
const metadataPlugin = definePlugin({
  name: "metadata",
  provides: ["metadata"],
  configSchema: S.Unknown,
  inflection: {
    outputFile: () => "metadata.json",
    symbolName: () => "metadata",
  },
  run: (ctx) => {
    const entityNames = Array.from(ctx.ir.entities.keys())
    ctx.setArtifact("metadata", { entityNames, generatedAt: new Date().toISOString() })
    ctx.emit("metadata.json", JSON.stringify({ entities: entityNames }, null, 2))
  },
})

/**
 * Plugin that consumes an artifact
 */
const indexPlugin = definePlugin({
  name: "index",
  provides: ["index"],
  requires: ["metadata"],
  configSchema: S.Unknown,
  inflection: {
    outputFile: () => "index.ts",
    symbolName: () => "index",
  },
  run: (ctx) => {
    const metadata = ctx.getArtifact("metadata")
    if (!metadata) {
      ctx.log.warn("No metadata artifact found")
      return
    }

    const data = metadata.data as { entityNames: string[] }
    const exports = data.entityNames
      .map((name) => `export * from "./types/${name}.js";`)
      .join("\n")

    ctx.emit("index.ts", exports + "\n")
  },
})

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Build IR from the test fixture
 */
const buildTestIR = Effect.gen(function* () {
  const builder = createIRBuilderService()
  return yield* builder.build(introspection, { schemas: ["app_public"] })
}).pipe(Effect.provide(InflectionLive))

// ============================================================================
// Tests
// ============================================================================

layer(TestLayer)("Core Pipeline Integration", (it) => {
  describe("full pipeline", () => {
    it.effect("builds IR → prepares plugins → runs plugins → validates → gets results", () =>
      Effect.gen(function* () {
        // 1. Build IR from fixture
        const ir: SemanticIR = yield* buildTestIR
        expect(ir.entities.size).toBeGreaterThan(0)

        // 2. Get PluginRunner
        const runner = yield* PluginRunner

        // 3. Configure plugins (new curried syntax)
        const plugins: ConfiguredPlugin[] = [
          typesPlugin({ outputDir: "types" }),
          validatorsPlugin({ outputDir: "validators" }),
        ]

        // 4. Prepare plugins (validates capabilities, orders by deps)
        const prepared = yield* runner.prepare(plugins)
        expect(prepared).toHaveLength(2)
        // types should come before validators (due to dependency)
        expect(prepared[0]?.plugin.name).toBe("types")
        expect(prepared[1]?.plugin.name).toBe("validators")

        // 5. Run plugins
        const result = yield* runner.run(prepared, ir)

        // 6. Validate results
        const emissions = result.emissions.getAll()
        expect(emissions.length).toBeGreaterThan(0)

        // Count table/view entities (plugins skip enums)
        const tableEntityCount = getTableEntities(ir).length

        // Should have type files for each table/view entity
        const typeFiles = emissions.filter((e) => e.path.startsWith("types/"))
        expect(typeFiles.length).toBe(tableEntityCount)

        // Should have validator files for each table/view entity
        const validatorFiles = emissions.filter((e) => e.path.startsWith("validators/"))
        expect(validatorFiles.length).toBe(tableEntityCount)

        // 7. Validate symbols
        const symbols = result.symbols.getAll()
        expect(symbols.length).toBeGreaterThan(0)

        // Should have both type and validator symbols
        const typeSymbols = symbols.filter((s) => s.capability === "types")
        const validatorSymbols = symbols.filter((s) => s.capability === "validators")
        expect(typeSymbols.length).toBe(tableEntityCount)
        expect(validatorSymbols.length).toBe(tableEntityCount)
      })
    )

    it.effect("artifact passing between plugins works", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR
        const runner = yield* PluginRunner

        const plugins: ConfiguredPlugin[] = [
          metadataPlugin({}),
          indexPlugin({}),
        ]

        const prepared = yield* runner.prepare(plugins)
        const result = yield* runner.run(prepared, ir)

        // Check artifacts were stored
        const metadataArtifact = result.artifacts.get("metadata")
        expect(metadataArtifact).toBeDefined()
        expect(metadataArtifact?.plugin).toBe("metadata")

        const data = metadataArtifact?.data as { entityNames: string[] }
        expect(data.entityNames).toContain("User")

        // Check index.ts was generated using the artifact
        const indexFile = result.emissions.getAll().find((e) => e.path === "index.ts")
        expect(indexFile).toBeDefined()
        expect(indexFile?.content).toContain('export * from "./types/')
      })
    )

    it.effect("writes files to disk (end-to-end)", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const pathSvc = yield* Path.Path
        const ir = yield* buildTestIR
        const runner = yield* PluginRunner
        const writer = createFileWriter()

        // Create temp directory
        const tmpDir = yield* fs.makeTempDirectory({ prefix: "core-pipeline-test-" })

        try {
          // Prepare and run plugins
          const plugins: ConfiguredPlugin[] = [
            typesPlugin({ outputDir: "types" }),
          ]

          const prepared = yield* runner.prepare(plugins)
          const result = yield* runner.run(prepared, ir)

          // Write files
          const writeResults = yield* writer.writeAll(result.emissions.getAll(), {
            outputDir: tmpDir,
          })

          expect(writeResults.length).toBeGreaterThan(0)
          expect(writeResults.every((r) => r.written)).toBe(true)

          // Verify files exist on disk
          const userTypePath = pathSvc.join(tmpDir, "types/User.ts")
          const exists = yield* fs.exists(userTypePath)
          expect(exists).toBe(true)

          // Verify content
          const content = yield* fs.readFileString(userTypePath)
          expect(content).toContain("export interface User")
        } finally {
          yield* fs.remove(tmpDir, { recursive: true })
        }
      })
    )
  })

  describe("error cases", () => {
    it.effect("detects capability conflicts", () =>
      Effect.gen(function* () {
        const runner = yield* PluginRunner

        // Two plugins providing the same capability
        const plugin1 = definePlugin({
          name: "types-a",
          provides: ["types"],
          configSchema: S.Unknown,
          inflection: { outputFile: () => "a.ts", symbolName: () => "a" },
          run: () => { /* noop - testing conflict detection */ },
        })

        const plugin2 = definePlugin({
          name: "types-b",
          provides: ["types"],
          configSchema: S.Unknown,
          inflection: { outputFile: () => "b.ts", symbolName: () => "b" },
          run: () => { /* noop - testing conflict detection */ },
        })

        const result = yield* runner
          .prepare([
            plugin1({}),
            plugin2({}),
          ])
          .pipe(Effect.either)

        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("CapabilityConflict")
        }
      })
    )

    it.effect("detects missing dependencies", () =>
      Effect.gen(function* () {
        const runner = yield* PluginRunner

        // Plugin that requires types but types not provided
        const result = yield* runner
          .prepare([validatorsPlugin({ outputDir: "validators" })])
          .pipe(Effect.either)

        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("CapabilityNotSatisfied")
        }
      })
    )

    it.effect("plugin execution error stops pipeline", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR
        const runner = yield* PluginRunner

        const failingPlugin = definePlugin({
          name: "failing",
          provides: ["fail"],
          configSchema: S.Unknown,
          inflection: { outputFile: () => "fail.ts", symbolName: () => "fail" },
          run: () => {
            throw new Error("Intentional test failure")
          },
        })

        const prepared = yield* runner.prepare([failingPlugin({})])
        const result = yield* runner.run(prepared, ir).pipe(Effect.either)

        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("PluginExecutionFailed")
        }
      })
    )
  })
})

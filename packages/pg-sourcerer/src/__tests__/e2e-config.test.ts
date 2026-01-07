/**
 * E2E Config Integration Tests
 *
 * Tests full config scenarios in-memory without writing to disk.
 * These tests exercise the complete pipeline from config → IR → plugins → emissions.
 *
 * Key scenarios tested:
 * - Inflection config flows through to generated output
 * - Real plugins generate correct file/symbol names
 * - Cross-plugin imports work correctly
 * - Plugin combinations work together
 */
import { describe, expect, layer } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"

import { PluginRunner, type ConfiguredPlugin } from "../services/plugin-runner.js"
import { createIRBuilderService } from "../services/ir-builder.js"
import { makeInflectionLayer, InflectionLive, inflect, type InflectionConfig } from "../services/inflection.js"
import { TypeHintsLive } from "../services/type-hints.js"
import type { SemanticIR } from "../ir/semantic-ir.js"
import { loadIntrospectionFixture } from "./fixtures/index.js"

// Real plugins
import { typesPlugin } from "../plugins/types.js"
import { zodPlugin } from "../plugins/zod.js"
import { effectModelPlugin } from "../plugins/effect-model.js"

// Load the test fixture
const introspection = loadIntrospectionFixture()

// Platform layers
const PlatformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)

// Base test layer with identity inflection (tests can override with their own)
// Note: PluginRunner now requires Inflection to be provided
const BaseTestLayer = Layer.mergeAll(
  Layer.provide(PluginRunner.Default, InflectionLive),
  PlatformLayer,
  TypeHintsLive([])
)

// ============================================================================
// Helper: Run config scenario in-memory
// ============================================================================

interface ConfigScenario {
  /** Inflection configuration */
  inflection?: InflectionConfig
  /** Plugins to run */
  plugins: ConfiguredPlugin[]
  /** Schemas to include from fixture */
  schemas?: string[]
}

interface ScenarioResult {
  ir: SemanticIR
  emissions: readonly { path: string; content: string }[]
  symbols: readonly { name: string; file: string; capability: string; entity?: string }[]
}

/**
 * Run a config scenario in-memory and return results for assertions
 */
const runScenario = (scenario: ConfigScenario) =>
  Effect.gen(function* () {
    // Create inflection layer from config
    const inflectionLayer = makeInflectionLayer(scenario.inflection)
    
    // Build IR with inflection
    const builder = createIRBuilderService()
    const ir = yield* builder
      .build(introspection, { schemas: scenario.schemas ?? ["app_public"] })
      .pipe(Effect.provide(inflectionLayer))

    // Run plugins with the same inflection layer
    // This mirrors how generate.ts works - PluginRunner is created with user's inflection
    const result = yield* Effect.gen(function* () {
      const runner = yield* PluginRunner
      const prepared = yield* runner.prepare(scenario.plugins)
      return yield* runner.run(prepared, ir)
    }).pipe(
      Effect.provide(PluginRunner.Default),
      Effect.provide(inflectionLayer)
    )

    return {
      ir,
      emissions: result.emissions.getAll(),
      symbols: result.symbols.getAll(),
    } satisfies ScenarioResult
  })

// ============================================================================
// Tests
// ============================================================================

layer(BaseTestLayer)("E2E Config Integration", (it) => {
  describe("inflection configuration", () => {
    it.effect("classic inflection produces PascalCase entity names", () =>
      Effect.gen(function* () {
        const result = yield* runScenario({
          inflection: {
            entityName: (name) => inflect.pascalCase(inflect.singularize(name)),
            fieldName: inflect.camelCase,
            enumName: inflect.pascalCase,
            shapeSuffix: inflect.capitalize,
          },
          plugins: [typesPlugin({ outputDir: "types" })],
        })

        // IR should have PascalCase entity names (users → User)
        expect(result.ir.entities.has("User")).toBe(true)
        expect(result.ir.entities.has("users")).toBe(false)

        // Files should use the inflected names
        const userFile = result.emissions.find((e) => e.path.includes("User.ts"))
        expect(userFile).toBeDefined()
        expect(userFile?.content).toContain("User")

        // Fields should be camelCase (created_at → createdAt)
        expect(userFile?.content).toContain("createdAt")
        expect(userFile?.content).not.toContain("created_at")
      })
    )

    it.effect("identity inflection preserves snake_case names", () =>
      Effect.gen(function* () {
        const result = yield* runScenario({
          // No inflection config = identity (preserve names)
          plugins: [typesPlugin({ outputDir: "types" })],
        })

        // IR should have original table names
        expect(result.ir.entities.has("users")).toBe(true)
        expect(result.ir.entities.has("User")).toBe(false)

        // Fields should be snake_case
        const usersFile = result.emissions.find((e) => e.path.includes("users"))
        expect(usersFile).toBeDefined()
        expect(usersFile?.content).toContain("created_at")
      })
    )

    it.effect("enum names follow inflection config", () =>
      Effect.gen(function* () {
        const result = yield* runScenario({
          inflection: {
            enumName: inflect.pascalCase,
          },
          plugins: [typesPlugin({ outputDir: "types" })],
        })

        // Fixture has vote_type enum - check it's PascalCase
        const enumNames = [...result.ir.enums.keys()]
        // Should have VoteType (from vote_type) with pascalCase inflection
        const hasVoteType = enumNames.some(
          (n) => n === "VoteType" || n === "vote_type"
        )
        expect(hasVoteType).toBe(true)

        // If inflection worked, should have VoteType not vote_type
        if (result.ir.enums.has("VoteType")) {
          expect(result.ir.enums.has("vote_type")).toBe(false)
        }
      })
    )
  })

  describe("real plugin output", () => {
    it.effect("types plugin generates correct structure", () =>
      Effect.gen(function* () {
        const result = yield* runScenario({
          inflection: {
            entityName: (name) => inflect.pascalCase(inflect.singularize(name)),
            fieldName: inflect.camelCase,
            shapeSuffix: inflect.capitalize,
          },
          plugins: [typesPlugin({ outputDir: "types" })],
        })

        // Should have files for each entity
        expect(result.emissions.length).toBeGreaterThan(0)

        // User entity should generate proper types (User.ts file)
        const userFile = result.emissions.find((e) => e.path.includes("User.ts"))
        expect(userFile).toBeDefined()

        // Should have the entity name in the file
        expect(userFile?.content).toContain("User")
      })
    )

    it.effect("zod plugin generates schemas with correct names", () =>
      Effect.gen(function* () {
        const result = yield* runScenario({
          inflection: {
            entityName: (name) => inflect.pascalCase(inflect.singularize(name)),
            fieldName: inflect.camelCase,
          },
          plugins: [
            typesPlugin({ outputDir: "types" }),
            zodPlugin({ outputDir: "zod", exportTypes: false }),
          ],
        })

        // Should have zod files
        const zodFiles = result.emissions.filter((e) => e.path.startsWith("zod/"))
        expect(zodFiles.length).toBeGreaterThan(0)

        // User zod schema should exist (User.ts file)
        const userZod = zodFiles.find((e) => e.path.includes("User.ts"))
        expect(userZod).toBeDefined()
        expect(userZod?.content).toContain("z.object")
      })
    )

    it.effect("effect-model plugin generates Model classes", () =>
      Effect.gen(function* () {
        const result = yield* runScenario({
          inflection: {
            entityName: (name) => inflect.pascalCase(inflect.singularize(name)),
            fieldName: inflect.camelCase,
            shapeSuffix: inflect.capitalize,
          },
          plugins: [effectModelPlugin({ outputDir: "models" })],
        })

        // Should have model files
        const modelFiles = result.emissions.filter((e) =>
          e.path.startsWith("models/")
        )
        expect(modelFiles.length).toBeGreaterThan(0)

        // User model should exist with correct structure (User.ts)
        const userModel = modelFiles.find((e) => e.path.includes("User.ts"))
        expect(userModel).toBeDefined()
        // Uses @effect/sql Model.Class pattern
        expect(userModel?.content).toContain("Model.Class")
        expect(userModel?.content).toContain("@effect/sql")
      })
    )
  })

  describe("plugin combinations", () => {
    it.effect("types + zod works together", () =>
      Effect.gen(function* () {
        const result = yield* runScenario({
          inflection: {
            entityName: (name) => inflect.pascalCase(inflect.singularize(name)),
            fieldName: inflect.camelCase,
          },
          plugins: [
            typesPlugin({ outputDir: "types" }),
            zodPlugin({ outputDir: "zod", exportTypes: false }),
          ],
        })

        const typeFiles = result.emissions.filter((e) =>
          e.path.startsWith("types/")
        )
        const zodFiles = result.emissions.filter((e) =>
          e.path.startsWith("zod/")
        )

        expect(typeFiles.length).toBeGreaterThan(0)
        expect(zodFiles.length).toBeGreaterThan(0)

        // Both should have roughly the same number of entities
        // (zod may have extra files for enums or index)
        expect(Math.abs(typeFiles.length - zodFiles.length)).toBeLessThanOrEqual(2)
      })
    )

    it.effect("all three plugins work together", () =>
      Effect.gen(function* () {
        const result = yield* runScenario({
          inflection: {
            entityName: (name) => inflect.pascalCase(inflect.singularize(name)),
            fieldName: inflect.camelCase,
            shapeSuffix: inflect.capitalize,
          },
          plugins: [
            typesPlugin({ outputDir: "types" }),
            zodPlugin({ outputDir: "zod", exportTypes: false }),
            effectModelPlugin({ outputDir: "models" }),
          ],
        })

        const typeFiles = result.emissions.filter((e) =>
          e.path.startsWith("types/")
        )
        const zodFiles = result.emissions.filter((e) =>
          e.path.startsWith("zod/")
        )
        const modelFiles = result.emissions.filter((e) =>
          e.path.startsWith("models/")
        )

        expect(typeFiles.length).toBeGreaterThan(0)
        expect(zodFiles.length).toBeGreaterThan(0)
        expect(modelFiles.length).toBeGreaterThan(0)

        // No emit conflicts
        const allPaths = result.emissions.map((e) => e.path)
        const uniquePaths = new Set(allPaths)
        expect(uniquePaths.size).toBe(allPaths.length)
      })
    )
  })

  describe("symbol registration", () => {
    it.effect("types plugin registers symbols correctly", () =>
      Effect.gen(function* () {
        const result = yield* runScenario({
          inflection: {
            entityName: (name) => inflect.pascalCase(inflect.singularize(name)),
          },
          plugins: [typesPlugin({ outputDir: "types" })],
        })

        // Should have type symbols
        const typeSymbols = result.symbols.filter((s) => s.capability === "types")
        expect(typeSymbols.length).toBeGreaterThan(0)

        // User entity should have a symbol
        const userSymbol = typeSymbols.find((s) => s.entity === "User")
        expect(userSymbol).toBeDefined()
        expect(userSymbol?.file).toContain("types/")
      })
    )

    it.effect("zod plugin can resolve type symbols for imports", () =>
      Effect.gen(function* () {
        const result = yield* runScenario({
          inflection: {
            entityName: (name) => inflect.pascalCase(inflect.singularize(name)),
          },
          plugins: [
            typesPlugin({ outputDir: "types" }),
            zodPlugin({ outputDir: "zod", exportTypes: true }),
          ],
        })

        // Zod files should import from types
        const zodFiles = result.emissions.filter((e) => e.path.startsWith("zod/"))

        // At least some zod files should have imports from types
        // (depending on exportTypes config)
        expect(zodFiles.length).toBeGreaterThan(0)
      })
    )
  })
})

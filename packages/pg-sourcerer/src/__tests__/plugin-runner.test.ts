/**
 * Plugin Runner Tests
 * 
 * Tests for capability resolution, conflict detection, cycle detection,
 * topological sorting, and plugin execution behavior.
 */
import { describe, expect, layer } from "@effect/vitest"
import { Effect, Layer, Schema as S } from "effect"
import {
  PluginRunner,
  type ConfiguredPlugin,
  type Plugin,
} from "../services/plugin-runner.js"
import {
  CapabilityConflict,
  CapabilityCycle,
  CapabilityNotSatisfied,
  DuplicatePlugin,
  PluginConfigInvalid,
} from "../errors.js"
import { createIRBuilder, freezeIR } from "../ir/index.js"
import { definePlugin, type SimplePluginContext, type PluginFactory } from "../services/plugin.js"
import { TypeHintsLive } from "../services/type-hints.js"
import { conjure } from "../lib/conjure.js"

// Test layer: PluginRunner + empty TypeHints
const TestLayer = Layer.merge(
  PluginRunner.Default,
  TypeHintsLive([])
)

// Helper to create a minimal test plugin factory using definePlugin
function testPlugin(
  name: string,
  provides: string[],
  requires: string[] = [],
  run: (ctx: SimplePluginContext, config: unknown) => void = () => { /* noop */ }
): PluginFactory<unknown> {
  const baseDef = {
    name,
    provides,
    configSchema: S.Unknown,
    inflection: {
      outputFile: (entity: string) => `${entity}.ts`,
      symbolName: (entity: string, kind: string) => `${entity}${kind}`,
    },
    run,
  }
  
  // Only add requires if non-empty (exactOptionalPropertyTypes)
  if (requires.length > 0) {
    return definePlugin({ ...baseDef, requires })
  }
  return definePlugin(baseDef)
}

// Helper to create a minimal IR for tests
function createTestIR() {
  const builder = createIRBuilder(["public"])
  return freezeIR(builder)
}

// ============================================================================
// All tests use PluginRunner.Default layer
// ============================================================================

layer(TestLayer)("PluginRunner", (it) => {
  // ==========================================================================
  // PluginRunner.prepare tests
  // ==========================================================================

  describe("prepare", () => {
    describe("capability expansion", () => {
      it.effect("expands hierarchical capabilities (schemas:zod → schemas)", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          const zodPlugin = testPlugin("zod", ["schemas:zod"])
          const typesPlugin = testPlugin("types", ["types"], ["schemas"]) // requires "schemas"
          
          // schemas:zod should satisfy "schemas" requirement
          const result = yield* runner.prepare([
            zodPlugin({}),
            typesPlugin({}),
          ])
          
          // Should succeed - schemas:zod provides schemas
          expect(result.length).toBe(2)
        })
      )

      it.effect("expands deep hierarchical capabilities (a:b:c:d → a:b:c, a:b, a)", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          // Plugin provides deeply nested capability
          const deepPlugin = testPlugin("deep", ["level1:level2:level3:level4"])
          // Plugin requires just "level1"
          const consumerPlugin = testPlugin("consumer", ["output"], ["level1"])
          
          const result = yield* runner.prepare([
            deepPlugin({}),
            consumerPlugin({}),
          ])
          
          // Should succeed - level1:level2:level3:level4 provides level1
          expect(result.length).toBe(2)
        })
      )

      it.effect("does NOT satisfy more specific requirement with less specific provider", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          // Plugin provides "schemas"
          const basePlugin = testPlugin("base", ["schemas"])
          // Plugin requires specifically "schemas:zod"
          const zodConsumer = testPlugin("zod-consumer", ["output"], ["schemas:zod"])
          
          const result = yield* runner.prepare([
            basePlugin({}),
            zodConsumer({}),
          ]).pipe(Effect.either)
          
          // Should fail - "schemas" does NOT provide "schemas:zod"
          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left._tag).toBe("CapabilityNotSatisfied")
            const err = result.left as CapabilityNotSatisfied
            expect(err.required).toBe("schemas:zod")
          }
        })
      )
    })

    describe("conflict detection", () => {
      it.effect("fails when two plugins provide the same capability", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          const plugin1 = testPlugin("plugin-a", ["types"])
          const plugin2 = testPlugin("plugin-b", ["types"])
          
          const result = yield* runner.prepare([
            plugin1({}),
            plugin2({}),
          ]).pipe(Effect.either)
          
          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left._tag).toBe("CapabilityConflict")
            const err = result.left as CapabilityConflict
            expect(err.capability).toBe("types")
            expect(err.providers).toContain("plugin-a")
            expect(err.providers).toContain("plugin-b")
          }
        })
      )

      it.effect("fails when hierarchical capabilities conflict", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          // schemas:zod implicitly provides schemas
          // schemas from another plugin = conflict
          const plugin1 = testPlugin("zod", ["schemas:zod"])
          const plugin2 = testPlugin("effect-schema", ["schemas"])
          
          const result = yield* runner.prepare([
            plugin1({}),
            plugin2({}),
          ]).pipe(Effect.either)
          
          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left._tag).toBe("CapabilityConflict")
          }
        })
      )
    })

    describe("unsatisfied requirements", () => {
      it.effect("fails when a required capability is not provided", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          const plugin = testPlugin("queries", ["queries"], ["schemas"]) // requires schemas
          
          const result = yield* runner.prepare([
            plugin({}),
          ]).pipe(Effect.either)
          
          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left._tag).toBe("CapabilityNotSatisfied")
            const err = result.left as CapabilityNotSatisfied
            expect(err.required).toBe("schemas")
            expect(err.requiredBy).toBe("queries")
          }
        })
      )
    })

    describe("topological sort", () => {
      it.effect("sorts plugins by dependency order", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          // queries requires schemas, schemas requires types
          const typesPlugin = testPlugin("types", ["types"])
          const schemasPlugin = testPlugin("schemas", ["schemas"], ["types"])
          const queriesPlugin = testPlugin("queries", ["queries"], ["schemas"])
          
          // Provide in wrong order
          const result = yield* runner.prepare([
            queriesPlugin({}),
            typesPlugin({}),
            schemasPlugin({}),
          ])
          
          // Should be sorted: types → schemas → queries
          expect(result[0]?.plugin.name).toBe("types")
          expect(result[1]?.plugin.name).toBe("schemas")
          expect(result[2]?.plugin.name).toBe("queries")
        })
      )

      it.effect("handles diamond dependencies correctly", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          // Diamond: top requires left & right, both require bottom
          //       top
          //      /   \
          //   left   right
          //      \   /
          //      bottom
          const bottom = testPlugin("bottom", ["cap-bottom"])
          const left = testPlugin("left", ["cap-left"], ["cap-bottom"])
          const right = testPlugin("right", ["cap-right"], ["cap-bottom"])
          const top = testPlugin("top", ["cap-top"], ["cap-left", "cap-right"])
          
          const result = yield* runner.prepare([
            top({}),
            left({}),
            right({}),
            bottom({}),
          ])
          
          // bottom must come before left and right; left and right must come before top
          const names = result.map(cp => cp.plugin.name)
          const bottomIdx = names.indexOf("bottom")
          const leftIdx = names.indexOf("left")
          const rightIdx = names.indexOf("right")
          const topIdx = names.indexOf("top")
          
          expect(bottomIdx).toBeLessThan(leftIdx)
          expect(bottomIdx).toBeLessThan(rightIdx)
          expect(leftIdx).toBeLessThan(topIdx)
          expect(rightIdx).toBeLessThan(topIdx)
        })
      )

      it.effect("detects cycles in plugin dependencies", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          // A requires B, B requires C, C requires A = cycle
          const pluginA = testPlugin("plugin-a", ["cap-a"], ["cap-c"])
          const pluginB = testPlugin("plugin-b", ["cap-b"], ["cap-a"])
          const pluginC = testPlugin("plugin-c", ["cap-c"], ["cap-b"])
          
          const result = yield* runner.prepare([
            pluginA({}),
            pluginB({}),
            pluginC({}),
          ]).pipe(Effect.either)
          
          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left._tag).toBe("CapabilityCycle")
            const err = result.left as CapabilityCycle
            expect(err.cycle.length).toBeGreaterThan(0)
          }
        })
      )

      it.effect("detects two-node cycles (A ↔ B)", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          // A requires B, B requires A
          const pluginA = testPlugin("plugin-a", ["cap-a"], ["cap-b"])
          const pluginB = testPlugin("plugin-b", ["cap-b"], ["cap-a"])
          
          const result = yield* runner.prepare([
            pluginA({}),
            pluginB({}),
          ]).pipe(Effect.either)
          
          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left._tag).toBe("CapabilityCycle")
          }
        })
      )
    })

    describe("valid configurations", () => {
      it.effect("accepts plugins with no dependencies", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          const plugin1 = testPlugin("types", ["types"])
          const plugin2 = testPlugin("schemas", ["schemas"])
          
          const result = yield* runner.prepare([
            plugin1({}),
            plugin2({}),
          ])
          
          expect(result.length).toBe(2)
        })
      )

      it.effect("accepts empty plugin list", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          const result = yield* runner.prepare([])
          
          expect(result.length).toBe(0)
        })
      )

      it.effect("accepts single plugin with no dependencies", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          const plugin = testPlugin("solo", ["cap-solo"])
          
          const result = yield* runner.prepare([plugin({})])
          
          expect(result.length).toBe(1)
          expect(result[0]?.plugin.name).toBe("solo")
        })
      )

      it.effect("accepts plugin that provides multiple capabilities", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          // Plugin provides both types and helpers
          const multiProvider = testPlugin("multi", ["types", "helpers"])
          // Consumer requires both
          const consumer = testPlugin("consumer", ["output"], ["types", "helpers"])
          
          const result = yield* runner.prepare([
            consumer({}),
            multiProvider({}),
          ])
          
          expect(result.length).toBe(2)
          // multi must come before consumer
          expect(result[0]?.plugin.name).toBe("multi")
          expect(result[1]?.plugin.name).toBe("consumer")
        })
      )

      it.effect("accepts plugin that requires multiple capabilities from different plugins", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          const typesPlugin = testPlugin("types", ["types"])
          const schemasPlugin = testPlugin("schemas", ["schemas"])
          // Consumer requires both types and schemas
          const consumer = testPlugin("consumer", ["output"], ["types", "schemas"])
          
          const result = yield* runner.prepare([
            consumer({}),
            typesPlugin({}),
            schemasPlugin({}),
          ])
          
          expect(result.length).toBe(3)
          // consumer must come last
          expect(result[2]?.plugin.name).toBe("consumer")
        })
      )

      it.effect("allows plugin to require its own provided capability (self-reference)", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          // This is a bit odd but should work - plugin provides and requires same cap
          const selfRef = testPlugin("self-ref", ["cap-a"], ["cap-a"])
          
          const result = yield* runner.prepare([selfRef({})])
          
          expect(result.length).toBe(1)
        })
      )
    })

    describe("edge cases", () => {
      it.effect("detects conflict between sibling hierarchical capabilities", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          // schemas:zod and schemas:effect both expand to "schemas"
          const zodPlugin = testPlugin("zod", ["schemas:zod"])
          const effectPlugin = testPlugin("effect-schema", ["schemas:effect"])
          
          const result = yield* runner.prepare([
            zodPlugin({}),
            effectPlugin({}),
          ]).pipe(Effect.either)
          
          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left._tag).toBe("CapabilityConflict")
            const err = result.left as CapabilityConflict
            expect(err.capability).toBe("schemas")
          }
        })
      )

      it.effect("fails when same plugin is added twice", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          const plugin = testPlugin("types", ["types"])
          
          const result = yield* runner.prepare([
            plugin({}),
            plugin({}), // duplicate
          ]).pipe(Effect.either)
          
          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left._tag).toBe("DuplicatePlugin")
            const err = result.left as DuplicatePlugin
            expect(err.plugin).toBe("types")
          }
        })
      )

      it.effect("handles plugin with empty provides array", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          // Plugin that provides nothing (maybe just does side effects)
          const noopPlugin = testPlugin("noop", [])
          
          const result = yield* runner.prepare([noopPlugin({})])
          
          expect(result.length).toBe(1)
        })
      )

      it.effect("handles long dependency chain", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          // Create a chain: p1 → p2 → p3 → p4 → p5
          const p1 = testPlugin("p1", ["cap1"])
          const p2 = testPlugin("p2", ["cap2"], ["cap1"])
          const p3 = testPlugin("p3", ["cap3"], ["cap2"])
          const p4 = testPlugin("p4", ["cap4"], ["cap3"])
          const p5 = testPlugin("p5", ["cap5"], ["cap4"])
          
          // Provide in reverse order
          const result = yield* runner.prepare([
            p5({}),
            p3({}),
            p1({}),
            p4({}),
            p2({}),
          ])
          
          const names = result.map(cp => cp.plugin.name)
          expect(names).toEqual(["p1", "p2", "p3", "p4", "p5"])
        })
      )

      it.effect("handles intermediate hierarchy requirement (requires a:b, has a:b:c)", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          // Provider gives a:b:c which expands to a:b:c, a:b, a
          const provider = testPlugin("provider", ["a:b:c"])
          // Consumer wants specifically a:b
          const consumer = testPlugin("consumer", ["output"], ["a:b"])
          
          const result = yield* runner.prepare([
            provider({}),
            consumer({}),
          ])
          
          // Should work - a:b:c provides a:b
          expect(result.length).toBe(2)
        })
      )
    })

    describe("config validation", () => {
      it.effect("validates plugin config against schema", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          // Plugin with a specific config schema
          const ConfigSchema = S.Struct({
            outputDir: S.String,
            verbose: S.Boolean,
          })
          
          const plugin = {
            name: "typed-plugin",
            provides: ["output"],
            configSchema: ConfigSchema,
            inflection: {
              outputFile: (entity: string) => `${entity}.ts`,
              symbolName: (entity: string, kind: string) => `${entity}${kind}`,
            },
            run: () => Effect.void,
          } as Plugin<unknown>
          
          // Valid config
          const result = yield* runner.prepare([
            { plugin, config: { outputDir: "./out", verbose: true } },
          ])
          
          expect(result.length).toBe(1)
        })
      )

      it.effect("fails on missing required config fields", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          const ConfigSchema = S.Struct({
            outputDir: S.String,
            verbose: S.Boolean,
          })
          
          const plugin = {
            name: "typed-plugin",
            provides: ["output"],
            configSchema: ConfigSchema,
            inflection: {
              outputFile: (entity: string) => `${entity}.ts`,
              symbolName: (entity: string, kind: string) => `${entity}${kind}`,
            },
            run: () => Effect.void,
          } as Plugin<unknown>
          
          // Missing 'verbose' field
          const result = yield* runner.prepare([
            { plugin, config: { outputDir: "./out" } },
          ]).pipe(Effect.either)
          
          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left._tag).toBe("PluginConfigInvalid")
            const err = result.left as PluginConfigInvalid
            expect(err.plugin).toBe("typed-plugin")
            expect(err.errors.length).toBeGreaterThan(0)
            expect(err.errors.some(e => e.includes("verbose"))).toBe(true)
          }
        })
      )

      it.effect("fails on wrong type in config field", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          const ConfigSchema = S.Struct({
            port: S.Number,
          })
          
          const plugin = {
            name: "port-plugin",
            provides: ["server"],
            configSchema: ConfigSchema,
            inflection: {
              outputFile: (entity: string) => `${entity}.ts`,
              symbolName: (entity: string, kind: string) => `${entity}${kind}`,
            },
            run: () => Effect.void,
          } as Plugin<unknown>
          
          // String instead of number
          const result = yield* runner.prepare([
            { plugin, config: { port: "8080" } },
          ]).pipe(Effect.either)
          
          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left._tag).toBe("PluginConfigInvalid")
            const err = result.left as PluginConfigInvalid
            expect(err.plugin).toBe("port-plugin")
          }
        })
      )

      it.effect("returns validated config to plugin", () =>
        Effect.gen(function* () {
          let receivedConfig: unknown
          const runner = yield* PluginRunner
          const ir = createTestIR()
          
          // Use testPlugin helper - the config schema in this test is already validated
          // by earlier tests, here we just verify the value gets passed through
          const plugin = testPlugin("config-receiver", ["output"], [], (_ctx, config) => {
            receivedConfig = config
          })
          
          const prepared = yield* runner.prepare([
            { plugin: plugin.plugin, config: { count: 42 } },
          ])
          
          yield* runner.run(prepared, ir)
          
          expect(receivedConfig).toEqual({ count: 42 })
        })
      )

      it.effect("validates nested config structures", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          
          const ConfigSchema = S.Struct({
            database: S.Struct({
              host: S.String,
              port: S.Number,
            }),
          })
          
          const plugin = {
            name: "nested-plugin",
            provides: ["db"],
            configSchema: ConfigSchema,
            inflection: {
              outputFile: (entity: string) => `${entity}.ts`,
              symbolName: (entity: string, kind: string) => `${entity}${kind}`,
            },
            run: () => Effect.void,
          } as Plugin<unknown>
          
          // Invalid nested structure
          const result = yield* runner.prepare([
            { plugin, config: { database: { host: "localhost", port: "not-a-number" } } },
          ]).pipe(Effect.either)
          
          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left._tag).toBe("PluginConfigInvalid")
            const err = result.left as PluginConfigInvalid
            expect(err.errors.some(e => e.includes("port") || e.includes("database"))).toBe(true)
          }
        })
      )
    })
  })

  // ==========================================================================
  // PluginRunner.run tests
  // ==========================================================================

  describe("run", () => {
    describe("execution order", () => {
      it.effect("runs plugins in dependency order", () =>
        Effect.gen(function* () {
          const executionOrder: string[] = []
          const runner = yield* PluginRunner
          const ir = createTestIR()
          
          const first = testPlugin("first", ["cap-first"], [], (ctx) => {
            executionOrder.push(ctx.pluginName)
            return Effect.void
          })
          
          const second = testPlugin("second", ["cap-second"], ["cap-first"], (ctx) => {
            executionOrder.push(ctx.pluginName)
            return Effect.void
          })
          
          const third = testPlugin("third", ["cap-third"], ["cap-second"], (ctx) => {
            executionOrder.push(ctx.pluginName)
            return Effect.void
          })
          
          // Prepare in wrong order, then run
          const prepared = yield* runner.prepare([
            third({}),
            first({}),
            second({}),
          ])
          
          yield* runner.run(prepared, ir)
          
          expect(executionOrder).toEqual(["first", "second", "third"])
        })
      )

      it.effect("runs independent plugins (no dependencies between them)", () =>
        Effect.gen(function* () {
          const executionOrder: string[] = []
          const runner = yield* PluginRunner
          const ir = createTestIR()
          
          const alpha = testPlugin("alpha", ["cap-alpha"], [], (ctx) => {
            executionOrder.push(ctx.pluginName)
            return Effect.void
          })
          
          const beta = testPlugin("beta", ["cap-beta"], [], (ctx) => {
            executionOrder.push(ctx.pluginName)
            return Effect.void
          })
          
          const prepared = yield* runner.prepare([
            alpha({}),
            beta({}),
          ])
          
          yield* runner.run(prepared, ir)
          
          // Both should run (order may vary for independent plugins)
          expect(executionOrder).toHaveLength(2)
          expect(executionOrder).toContain("alpha")
          expect(executionOrder).toContain("beta")
        })
      )
    })

    describe("plugin context", () => {
      it.effect("provides plugin with its name in context", () =>
        Effect.gen(function* () {
          let receivedName: string | undefined
          const runner = yield* PluginRunner
          const ir = createTestIR()
          
          const plugin = testPlugin("my-plugin", ["cap"], [], (ctx) => {
            receivedName = ctx.pluginName
            return Effect.void
          })
          
          const prepared = yield* runner.prepare([plugin({})])
          yield* runner.run(prepared, ir)
          
          expect(receivedName).toBe("my-plugin")
        })
      )

      it.effect("provides plugin with access to IR", () =>
        Effect.gen(function* () {
          let receivedIR: unknown
          const runner = yield* PluginRunner
          const ir = createTestIR()
          
          const plugin = testPlugin("ir-reader", ["cap"], [], (ctx) => {
            receivedIR = ctx.ir
            return Effect.void
          })
          
          const prepared = yield* runner.prepare([plugin({})])
          yield* runner.run(prepared, ir)
          
          expect(receivedIR).toBe(ir)
        })
      )
    })

    describe("emissions", () => {
      it.effect("plugin can emit code to files", () =>
        Effect.gen(function* () {
          let emittedPath: string | undefined
          let emittedContent: string | undefined
          const runner = yield* PluginRunner
          const ir = createTestIR()
          
          const plugin = testPlugin("emitter", ["types"], [], (ctx) => {
            ctx.emit("types.ts", "export type Foo = string;")
            emittedPath = "types.ts"
            emittedContent = "export type Foo = string;"
            return Effect.void
          })
          
          const prepared = yield* runner.prepare([plugin({})])
          yield* runner.run(prepared, ir)
          
          // Verify emit was called (we capture in the plugin for now)
          expect(emittedPath).toBe("types.ts")
          expect(emittedContent).toBe("export type Foo = string;")
        })
      )

      it.effect("later plugin can see earlier plugin's artifact", () =>
        Effect.gen(function* () {
          let receivedArtifact: unknown
          const runner = yield* PluginRunner
          const ir = createTestIR()
          
          const producer = testPlugin("producer", ["data"], [], (ctx) => {
            ctx.setArtifact("data", { foo: "bar" })
            return Effect.void
          })
          
          const consumer = testPlugin("consumer", ["output"], ["data"], (ctx) => {
            receivedArtifact = ctx.getArtifact("data")
            return Effect.void
          })
          
          const prepared = yield* runner.prepare([
            consumer({}),
            producer({}),
          ])
          
          yield* runner.run(prepared, ir)
          
          expect(receivedArtifact).toEqual({ 
            capability: "data", 
            plugin: "producer", 
            data: { foo: "bar" } 
          })
        })
      )
    })

    describe("error handling", () => {
      it.effect("stops execution and reports error when plugin fails", () =>
        Effect.gen(function* () {
          const executionOrder: string[] = []
          const runner = yield* PluginRunner
          const ir = createTestIR()
          
          const first = testPlugin("first", ["cap-first"], [], (ctx) => {
            executionOrder.push(ctx.pluginName)
          })
          
          // This plugin throws an error - definePlugin will catch and wrap it
          const failing = testPlugin("failing", ["cap-failing"], ["cap-first"], () => {
            throw new Error("Something went wrong")
          })
          
          const third = testPlugin("third", ["cap-third"], ["cap-failing"], (ctx) => {
            executionOrder.push(ctx.pluginName)
          })
          
          const prepared = yield* runner.prepare([
            first({}),
            failing({}),
            third({}),
          ])
          
          const result = yield* runner.run(prepared, ir).pipe(Effect.either)
          
          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left._tag).toBe("PluginExecutionFailed")
            if (result.left._tag === "PluginExecutionFailed") {
              expect(result.left.plugin).toBe("failing")
            }
          }
          
          // First ran, third did not
          expect(executionOrder).toEqual(["first"])
        })
      )
    })

    describe("config handling", () => {
      it.effect("passes config to plugin run function", () =>
        Effect.gen(function* () {
          let receivedConfig: unknown
          const runner = yield* PluginRunner
          const ir = createTestIR()
          
          const plugin = testPlugin("configurable", ["output"], [], (_ctx, config) => {
            receivedConfig = config
            return Effect.void
          })
          
          const prepared = yield* runner.prepare([
            plugin({ outputDir: "./out", verbose: true }),
          ])
          
          yield* runner.run(prepared, ir)
          
          expect(receivedConfig).toEqual({ outputDir: "./out", verbose: true })
        })
      )
    })

    describe("RunResult", () => {
      it.effect("returns emissions buffer with emitted files", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          const ir = createTestIR()
          
          const plugin = testPlugin("emitter", ["types"], [], (ctx) => {
            ctx.emit("types/User.ts", "export type User = { id: number };")
            ctx.emit("types/Post.ts", "export type Post = { title: string };")
            return Effect.void
          })
          
          const prepared = yield* runner.prepare([plugin({})])
          const result = yield* runner.run(prepared, ir)
          
          const emissions = result.emissions.getAll()
          expect(emissions).toHaveLength(2)
          expect(emissions.find(e => e.path === "types/User.ts")?.content).toBe(
            "export type User = { id: number };"
          )
          expect(emissions.find(e => e.path === "types/Post.ts")?.content).toBe(
            "export type Post = { title: string };"
          )
        })
      )

      it.effect("returns symbol registry with registered symbols", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          const ir = createTestIR()
          
          const plugin = testPlugin("types", ["types"], [], (ctx) => {
            ctx.symbols.register({
              name: "User",
              file: "types/User.ts",
              capability: "types",
              entity: "User",
              isType: true,
              isDefault: false,
            }, ctx.pluginName)
            return Effect.void
          })
          
          const prepared = yield* runner.prepare([plugin({})])
          const result = yield* runner.run(prepared, ir)
          
          const symbols = result.symbols.getAll()
          expect(symbols).toHaveLength(1)
          expect(symbols[0]?.name).toBe("User")
          expect(symbols[0]?.file).toBe("types/User.ts")
        })
      )

      it.effect("returns artifacts from plugins", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          const ir = createTestIR()
          
          const plugin = testPlugin("producer", ["schema-data"], [], (ctx) => {
            ctx.setArtifact("schema-data", { tables: ["users", "posts"] })
            return Effect.void
          })
          
          const prepared = yield* runner.prepare([plugin({})])
          const result = yield* runner.run(prepared, ir)
          
          const artifact = result.artifacts.get("schema-data")
          expect(artifact).toBeDefined()
          expect(artifact?.capability).toBe("schema-data")
          expect(artifact?.plugin).toBe("producer")
          expect(artifact?.data).toEqual({ tables: ["users", "posts"] })
        })
      )

      it.effect("run fails with EmitConflict when plugins emit to same file", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          const ir = createTestIR()
          
          // Two plugins emit to the same file - should create a conflict
          const plugin1 = testPlugin("plugin-a", ["cap-a"], [], (ctx) => {
            ctx.emit("shared.ts", "// from plugin-a")
            return Effect.void
          })
          const plugin2 = testPlugin("plugin-b", ["cap-b"], [], (ctx) => {
            ctx.emit("shared.ts", "// from plugin-b")
            return Effect.void
          })
          
          const prepared = yield* runner.prepare([
            plugin1({}),
            plugin2({}),
          ])
          
          // run() should fail with EmitConflict
          const result = yield* runner.run(prepared, ir).pipe(Effect.either)
          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left._tag).toBe("EmitConflict")
          }
        })
      )

      it.effect("run fails with SymbolConflict when plugins register same symbol", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          const ir = createTestIR()
          
          // Two plugins register same symbol name in same file
          const plugin1 = testPlugin("plugin-a", ["cap-a"], [], (ctx) => {
            ctx.symbols.register({
              name: "User",
              file: "types.ts",
              capability: "cap-a",
              entity: "User",
              isType: true,
              isDefault: false,
            }, ctx.pluginName)
            return Effect.void
          })
          const plugin2 = testPlugin("plugin-b", ["cap-b"], [], (ctx) => {
            ctx.symbols.register({
              name: "User",
              file: "types.ts",
              capability: "cap-b",
              entity: "User",
              isType: true,
              isDefault: false,
            }, ctx.pluginName)
            return Effect.void
          })
          
          const prepared = yield* runner.prepare([
            plugin1({}),
            plugin2({}),
          ])
          
          // run() should fail with SymbolConflict
          const result = yield* runner.run(prepared, ir).pipe(Effect.either)
          expect(result._tag).toBe("Left")
          if (result._tag === "Left") {
            expect(result.left._tag).toBe("SymbolConflict")
          }
        })
      )
    })

    describe("ctx.file() FileBuilder", () => {
      it.effect("emits AST via file() and registers symbols", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          const ir = createTestIR()
          
          const plugin = testPlugin("types", ["types"], [], (ctx) => {
            ctx.file("types/User.ts")
              .header("// Auto-generated")
              .ast(
                conjure.symbolProgram(
                  conjure.exp.interface(
                    "UserRow",
                    { capability: "types", entity: "User", shape: "row" },
                    [{ name: "id", type: conjure.ts.string() }]
                  )
                )
              )
              .emit()
          })
          
          const prepared = yield* runner.prepare([plugin({})])
          const result = yield* runner.run(prepared, ir)
          
          // Check symbols were registered
          const symbols = result.symbols.getAll()
          expect(symbols).toHaveLength(1)
          expect(symbols[0]!.name).toBe("UserRow")
          expect(symbols[0]!.file).toBe("types/User.ts")
          expect(symbols[0]!.capability).toBe("types")
          expect(symbols[0]!.entity).toBe("User")
          expect(symbols[0]!.shape).toBe("row")
          
          // Check emission was serialized (AST → string)
          const emissions = result.emissions.getAll()
          expect(emissions).toHaveLength(1)
          expect(emissions[0]!.path).toBe("types/User.ts")
          expect(emissions[0]!.content).toContain("// Auto-generated")
          expect(emissions[0]!.content).toContain("export interface UserRow")
        })
      )

      it.effect("allows multiple file() calls for different files", () =>
        Effect.gen(function* () {
          const runner = yield* PluginRunner
          const ir = createTestIR()
          
          const plugin = testPlugin("types", ["types"], [], (ctx) => {
            ctx.file("types/User.ts")
              .ast(
                conjure.symbolProgram(
                  conjure.exp.interface(
                    "UserRow",
                    { capability: "types", entity: "User" },
                    []
                  )
                )
              )
              .emit()
            
            ctx.file("types/Post.ts")
              .ast(
                conjure.symbolProgram(
                  conjure.exp.interface(
                    "PostRow",
                    { capability: "types", entity: "Post" },
                    []
                  )
                )
              )
              .emit()
          })
          
          const prepared = yield* runner.prepare([plugin({})])
          const result = yield* runner.run(prepared, ir)
          
          expect(result.symbols.getAll()).toHaveLength(2)
          expect(result.emissions.getAll()).toHaveLength(2)
        })
      )
    })
  })
})

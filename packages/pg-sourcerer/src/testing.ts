/**
 * Testing Utilities
 *
 * Provides reusable test layers and helpers for plugin testing.
 */
import { Layer } from "effect"
import { InflectionLive } from "./services/inflection.js"
import { EmissionsLive } from "./services/emissions.js"
import { SymbolsLive } from "./services/symbols.js"
import { TypeHintsLive } from "./services/type-hints.js"
import { ArtifactStoreLive } from "./services/artifact-store.js"
import { PluginMeta } from "./services/plugin-meta.js"
import { IR } from "./services/ir.js"
import type { SemanticIR } from "./ir/semantic-ir.js"

/**
 * Base test layers for direct plugin testing.
 *
 * Provides all shared services except IR and PluginMeta,
 * which are test-specific.
 *
 * Usage:
 * ```typescript
 * const TestLayer = Layer.mergeAll(
 *   PluginTestLayers,
 *   Layer.succeed(IR, testIR),
 *   Layer.succeed(PluginMeta, { name: "test-plugin" }),
 * )
 * ```
 */
export const PluginTestLayers = Layer.mergeAll(
  InflectionLive,
  EmissionsLive,
  SymbolsLive,
  TypeHintsLive([]),
  ArtifactStoreLive
)

/**
 * Create a complete test layer for a specific plugin test.
 *
 * @param ir - The SemanticIR to provide
 * @param pluginName - The plugin name for PluginMeta
 * @returns Layer with all services for plugin testing
 *
 * Usage:
 * ```typescript
 * const testIR = freezeIR(createIRBuilder(["public"]))
 * const TestLayer = createPluginTestLayer(testIR, "my-plugin")
 *
 * layer(TestLayer)("MyPlugin tests", (it) => {
 *   it.effect("generates types", () =>
 *     Effect.gen(function* () {
 *       yield* myPlugin.run(config)
 *       const emissions = yield* Emissions
 *       expect(emissions.getAll()).toHaveLength(1)
 *     })
 *   )
 * })
 * ```
 */
export function createPluginTestLayer(ir: SemanticIR, pluginName: string) {
  return Layer.mergeAll(
    PluginTestLayers,
    Layer.succeed(IR, ir),
    Layer.succeed(PluginMeta, { name: pluginName })
  )
}

// Re-export commonly needed items for tests
export { IR } from "./services/ir.js"
export { PluginMeta } from "./services/plugin-meta.js"
export { Emissions } from "./services/emissions.js"
export { Symbols } from "./services/symbols.js"
export { runPlugins } from "./services/plugin-runner.js"
export { createIRBuilder, freezeIR } from "./ir/semantic-ir.js"

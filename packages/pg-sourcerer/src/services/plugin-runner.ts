/**
 * Plugin Runner Service
 *
 * Orchestrates the plugin system: registration → resolution → execution.
 */
import { Effect } from "effect"
import {
  type Plugin,
  type PluginError,
  createPluginRegistry,
} from "./plugin.js"
import { resolve } from "./resolution.js"
import { execute, type ExecutionServices } from "./execution.js"
import { createEmissionBuffer, type EmissionBuffer } from "./emissions.js"
import { createSymbolRegistry, type SymbolRegistry } from "./symbols.js"
import { createServiceRegistry } from "./service-registry.js"
import { createFileBuilderFactory } from "./file-builder.js"
import { EmitConflict, SymbolConflict, UndefinedReference } from "../errors.js"
import { conjure } from "../lib/conjure.js"
import type { SemanticIR } from "../ir/semantic-ir.js"
import type { TypeHintRegistry } from "./type-hints.js"
import type { CoreInflection } from "./inflection.js"

// ============================================================================
// Types
// ============================================================================

/**
 * Context required to run plugins.
 * Contains the IR and services that all plugins need access to.
 */
export interface PluginRunContext {
  readonly ir: SemanticIR
  readonly typeHints: TypeHintRegistry
  readonly inflection: CoreInflection
}

/**
 * Result of running plugins
 */
export interface PluginRunResult {
  readonly emissions: EmissionBuffer
  readonly symbols: SymbolRegistry
}

/**
 * Errors that can occur during plugin execution
 */
export type PluginRunError =
  | PluginError
  | EmitConflict
  | SymbolConflict
  | UndefinedReference

// ============================================================================
// Plugin Runner
// ============================================================================

/**
 * Run plugins through the full pipeline.
 *
 * @param plugins - Plugins to run (from config.plugins)
 * @param context - IR, type hints, and inflection for plugins to access
 * @returns Effect with emissions and symbols
 */
export const runPlugins = (
  plugins: readonly Plugin[],
  context: PluginRunContext
): Effect.Effect<PluginRunResult, PluginRunError> =>
  Effect.gen(function* () {
    // 1. Create shared state
    const emissions = createEmissionBuffer()
    const symbols = createSymbolRegistry()
    const registry = createPluginRegistry()

    // 2. Register all plugins
    for (const plugin of plugins) {
      registry.register(plugin)
    }

    // 3. Resolution phase - match requests to plugins, build DAG
    const plan = yield* resolve(registry)

    yield* Effect.logDebug(`Execution plan: ${plan.steps.length} steps`)
    for (const step of plan.steps) {
      yield* Effect.logDebug(`  - ${step.provider.name}: ${step.kind}`)
    }

    // 4. Execution phase - run plugins in topological order
    const serviceRegistry = createServiceRegistry()
    const services: ExecutionServices = {
      fileBuilder: createFileBuilderFactory("plugin-runner", emissions, symbols),
      symbols,
      ir: context.ir,
      typeHints: context.typeHints,
      inflection: context.inflection,
      serviceRegistry,
    }

    yield* execute(plan, registry, services)

    // 5. Serialize AST emissions (resolves imports)
    emissions.serializeAst(conjure.print, symbols)

    // 6. Check for unresolved symbol references
    const unresolvedRefs = emissions.getUnresolvedRefs()
    if (unresolvedRefs.length > 0) {
      yield* Effect.fail(
        new UndefinedReference({
          message: `Undefined symbol references: ${unresolvedRefs
            .map(
              (r) =>
                `${r.capability}/${r.entity}${r.shape ? `/${r.shape}` : ""} (requested by ${r.plugin} in ${r.file})`
            )
            .join(", ")}`,
          references: unresolvedRefs.map((r) => ({
            capability: r.capability,
            entity: r.entity,
            shape: r.shape,
            requestedBy: r.plugin,
            inFile: r.file,
          })),
        })
      )
    }

    // 7. Validate emissions for conflicts
    yield* emissions.validate()

    // 8. Validate symbols for collisions
    const collisions = symbols.validate()
    if (collisions.length > 0) {
      yield* Effect.fail(
        new SymbolConflict({
          message: `Symbol collision: "${collisions[0]!.symbol}" in ${collisions[0]!.file} from plugins: ${collisions[0]!.plugins.join(", ")}`,
          symbol: collisions[0]!.symbol,
          file: collisions[0]!.file,
          plugins: collisions[0]!.plugins,
        })
      )
    }

    return { emissions, symbols }
  })

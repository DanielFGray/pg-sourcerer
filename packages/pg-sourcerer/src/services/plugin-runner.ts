/**
 * Plugin Runner Service
 *
 * Orchestrates plugin execution: capability resolution, ordering, and execution.
 *
 * Functional Effect patterns:
 * - Method-style .pipe() for Effect chains
 * - pipe() from effect only for pure data transformations
 * - HashMap/Array for immutable collections
 * - Effect.reduce for foldable operations with failure
 * - Graph module for dependency algorithms
 */
import { Effect, HashMap, Array as Arr, pipe, Graph, Option, Schema as S, ParseResult, Layer } from "effect";
import type { SemanticIR, CapabilityKey, Artifact } from "../ir/index.js";
import type { ConfiguredPlugin } from "./plugin.js";
import {
  CapabilityConflict,
  CapabilityCycle,
  CapabilityNotSatisfied,
  DuplicatePlugin,
  EmitConflict,
  PluginConfigInvalid,
  PluginExecutionFailed,
  SymbolConflict,
} from "../errors.js";
import { type EmissionBuffer, Emissions, createEmissionBuffer } from "./emissions.js";
import { type SymbolRegistry, Symbols, createSymbolRegistry } from "./symbols.js";
import { TypeHints } from "./type-hints.js";
import { Inflection, InflectionLive } from "./inflection.js";
import { IR } from "./ir.js";
import { ArtifactStore, createArtifactStore } from "./artifact-store.js";
import { PluginMeta } from "./plugin-meta.js";
import { conjure } from "../lib/conjure.js";

// ============================================================================
// Re-export types from plugin.ts for backwards compatibility
// ============================================================================

export type { Plugin, ConfiguredPlugin, PluginInflection } from "./plugin.js";

/**
 * Result of running plugins - contains all outputs for validation and writing
 */
export interface RunResult {
  /** Emission buffer containing all emitted code */
  readonly emissions: EmissionBuffer;
  /** Symbol registry for import resolution */
  readonly symbols: SymbolRegistry;
  /** Artifacts produced by plugins, keyed by capability */
  readonly artifacts: ReadonlyMap<CapabilityKey, Artifact>;
}

// ============================================================================
// Pure Functions (use pipe for data transformations)
// ============================================================================

/** Expand "a:b:c" → ["a:b:c", "a:b", "a"] */
const expandCapability = (cap: CapabilityKey): readonly CapabilityKey[] =>
  pipe(
    Arr.range(1, cap.split(":").length),
    Arr.map(n => cap.split(":").slice(0, n).join(":")),
  );

/** Extract (capability, pluginName) pairs from plugins with expansion */
const capabilityPairs = (plugins: readonly ConfiguredPlugin[]) =>
  plugins.flatMap(({ plugin }) =>
    plugin.provides.flatMap(expandCapability).map(cap => [cap, plugin.name] as const),
  );

/** Extract (required, pluginName) pairs from plugins */
const requirementPairs = (plugins: readonly ConfiguredPlugin[]) =>
  plugins.flatMap(({ plugin }) => (plugin.requires ?? []).map(req => [req, plugin.name] as const));

/** Build directed graph from plugins and their dependencies (pure) */
const buildGraph = (
  plugins: readonly ConfiguredPlugin[],
  providers: HashMap.HashMap<CapabilityKey, string>,
): Graph.DirectedGraph<string, void> => {
  const names = Arr.map(plugins, ({ plugin }) => plugin.name);

  const edges = plugins.flatMap(({ plugin }) =>
    Arr.filterMap(plugin.requires ?? [], req =>
      HashMap.get(providers, req).pipe(
        Option.filter(provider => provider !== plugin.name),
        Option.map(provider => [provider, plugin.name] as const),
      ),
    ),
  );

  // Mutation confined to Graph.directed callback
  return Graph.directed<string, void>(g => {
    const indices = Object.fromEntries(names.map(name => [name, Graph.addNode(g, name)]));
    edges.forEach(([from, to]) => {
      Graph.addEdge(g, indices[from]!, indices[to]!, undefined);
    });
  });
};

/** Extract cycle from graph's strongly connected components */
const extractCycle = (graph: Graph.DirectedGraph<string, void>): string[] =>
  pipe(
    Graph.stronglyConnectedComponents(graph),
    Arr.findFirst(scc => scc.length > 1),
    Option.getOrElse(() => [] as number[]),
    Arr.map(idx => Graph.getNode(graph, idx).pipe(Option.getOrElse(() => "unknown"))),
  );

// ============================================================================
// Effectful Operations (use .pipe() method on Effects)
// ============================================================================

/** Check for duplicate plugin names */
const checkDuplicates = (
  plugins: readonly ConfiguredPlugin[],
): Effect.Effect<void, DuplicatePlugin> =>
  pipe(
    plugins.map(({ plugin }) => plugin.name),
    names => {
      const seen = new Set<string>();
      for (const name of names) {
        if (seen.has(name)) {
          return Effect.fail(
            new DuplicatePlugin({
              message: `Plugin "${name}" is registered multiple times`,
              plugin: name,
            }),
          );
        }
        seen.add(name);
      }
      return Effect.void;
    },
  );

/** Validate a single plugin's config against its schema */
const validatePluginConfig = (
  cp: ConfiguredPlugin,
): Effect.Effect<ConfiguredPlugin, PluginConfigInvalid> =>
  S.decodeUnknown(cp.plugin.configSchema)(cp.config).pipe(
    Effect.map(validatedConfig => ({
      plugin: cp.plugin,
      config: validatedConfig,
    })),
    Effect.mapError(parseError => {
      const formatted = ParseResult.ArrayFormatter.formatErrorSync(parseError);
      const errors = formatted.map(e => {
        const path = e.path.length > 0 ? `${e.path.join(".")}: ` : "";
        return `${path}${e.message}`;
      });
      return new PluginConfigInvalid({
        message: `Invalid config for plugin "${cp.plugin.name}": ${errors.join("; ")}`,
        plugin: cp.plugin.name,
        errors,
      });
    }),
  );

/** Validate all plugin configs, failing on first invalid */
const validateConfigs = (
  plugins: readonly ConfiguredPlugin[],
): Effect.Effect<readonly ConfiguredPlugin[], PluginConfigInvalid> =>
  Effect.forEach(plugins, validatePluginConfig);

/**
 * Build capability → provider map, failing on first conflict.
 * Single-pass fold that validates during construction.
 */
const buildProviderMap = (
  plugins: readonly ConfiguredPlugin[],
): Effect.Effect<HashMap.HashMap<CapabilityKey, string>, CapabilityConflict> =>
  Effect.reduce(
    capabilityPairs(plugins),
    HashMap.empty<CapabilityKey, string>(),
    (map, [cap, name]) =>
      pipe(
        HashMap.get(map, cap),
        Option.match({
          onNone: () => Effect.succeed(HashMap.set(map, cap, name)),
          onSome: existing =>
            existing === name
              ? Effect.succeed(map)
              : Effect.fail(
                  new CapabilityConflict({
                    message: `Capability "${cap}" provided by multiple plugins: ${existing}, ${name}`,
                    capability: cap,
                    providers: [existing, name],
                  }),
                ),
        }),
      ),
  );

/** Verify all requirements are satisfiable */
const checkRequirements = (
  plugins: readonly ConfiguredPlugin[],
  providers: HashMap.HashMap<CapabilityKey, string>,
): Effect.Effect<void, CapabilityNotSatisfied> =>
  pipe(
    requirementPairs(plugins),
    Arr.findFirst(([req]) => !HashMap.has(providers, req)),
    Option.match({
      onNone: () => Effect.void,
      onSome: ([req, name]) =>
        Effect.fail(
          new CapabilityNotSatisfied({
            message: `Plugin "${name}" requires "${req}" but no plugin provides it`,
            required: req,
            requiredBy: name,
          }),
        ),
    }),
  );

/** Sort plugins topologically, detecting cycles */
const topoSort = (
  plugins: readonly ConfiguredPlugin[],
  graph: Graph.DirectedGraph<string, void>,
) => {
  const byName = Object.groupBy(plugins, cp => cp.plugin.name);

  return Effect.if(Graph.isAcyclic(graph), {
    onTrue: () =>
      Effect.succeed(Array.from(Graph.values(Graph.topo(graph))).flatMap(n => byName[n]!)),
    onFalse: () =>
      Effect.fail(
        new CapabilityCycle({
          message: `Circular dependency: ${extractCycle(graph).join(" → ")}`,
          cycle: extractCycle(graph),
        }),
      ),
  });
};

// ============================================================================
// Prepare (standalone - no dependencies)
// ============================================================================

const prepare = (
  plugins: readonly ConfiguredPlugin[],
): Effect.Effect<
  readonly ConfiguredPlugin[],
  CapabilityConflict | CapabilityCycle | CapabilityNotSatisfied | DuplicatePlugin | PluginConfigInvalid
> =>
  Effect.if(plugins.length === 0, {
    onTrue: () => Effect.succeed(plugins),
    onFalse: () =>
      checkDuplicates(plugins).pipe(
        Effect.andThen(validateConfigs(plugins)),
        Effect.flatMap(validatedPlugins =>
          buildProviderMap(validatedPlugins).pipe(
            Effect.tap(providers => checkRequirements(validatedPlugins, providers)),
            Effect.flatMap(providers => topoSort(validatedPlugins, buildGraph(validatedPlugins, providers))),
          ),
        ),
      ),
  });

// ============================================================================
// PluginRunner Service
// ============================================================================

/**
 * PluginRunner service - orchestrates plugin execution.
 *
 * Depends on Inflection service (captured at construction time via layer).
 *
 * Usage:
 *   const runner = yield* PluginRunner
 *   const prepared = yield* runner.prepare(plugins)
 *   const result = yield* runner.run(prepared, ir)
 */
export class PluginRunner extends Effect.Service<PluginRunner>()("PluginRunner", {
  effect: Effect.gen(function* () {
    const inflection = yield* Inflection;

    const run = (
      plugins: readonly ConfiguredPlugin[],
      ir: SemanticIR,
    ): Effect.Effect<RunResult, PluginExecutionFailed | EmitConflict | SymbolConflict, TypeHints> =>
      Effect.gen(function* () {
        // Create shared state for all plugins in this run
        const emissions = createEmissionBuffer();
        const symbols = createSymbolRegistry();
        
        // Yield TypeHints from context - caller must provide via layer
        const typeHints = yield* TypeHints;

        // Create artifact store instance once (it's stateful)
        const artifactStore = createArtifactStore();

        // Build shared layers for this run - all using the same instances
        const sharedLayers = Layer.mergeAll(
          Layer.succeed(IR, ir),
          Layer.succeed(Inflection, inflection),
          Layer.succeed(Emissions, emissions),
          Layer.succeed(Symbols, symbols),
          Layer.succeed(TypeHints, typeHints),
          Layer.succeed(ArtifactStore, artifactStore),
        );

        // Execute plugins sequentially, stopping on first failure
        // Each plugin gets a fresh PluginMeta layer with its name
        // and logging annotations for structured logging
        yield* Effect.forEach(
          plugins,
          ({ plugin, config }) => {
            const pluginMetaLayer = Layer.succeed(PluginMeta, { name: plugin.name });
            const allLayers = Layer.merge(sharedLayers, pluginMetaLayer);

            return plugin.run(config).pipe(
              Effect.provide(allLayers),
              // Add plugin name as log annotation for Effect-native plugins
              Effect.annotateLogs("plugin", plugin.name)
            );
          },
          { discard: true },
        );

        // Serialize AST emissions to string content (with import resolution)
        emissions.serializeAst(conjure.print, symbols);

        // Validate emissions for conflicts
        yield* emissions.validate();

        // Validate symbols for collisions
        const collisions = symbols.validate();
        if (collisions.length > 0) {
          yield* Effect.fail(
            new SymbolConflict({
              message: `Symbol collision: "${collisions[0]!.symbol}" in ${collisions[0]!.file} from plugins: ${collisions[0]!.plugins.join(", ")}`,
              symbol: collisions[0]!.symbol,
              file: collisions[0]!.file,
              plugins: collisions[0]!.plugins,
            }),
          );
        }

        return {
          emissions,
          symbols,
          artifacts: artifactStore.getAll(),
        };
      });

    return { prepare, run };
  }),
  dependencies: [InflectionLive],
}) {}

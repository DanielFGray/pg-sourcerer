import { Effect, Layer, Array as Arr, FiberRef, pipe } from "effect";
import type { Plugin, Capability, RenderedSymbol } from "./types.js";
import { SymbolRegistry, SymbolRegistryImpl } from "./registry.js";
import { validateAll } from "./validation.js";
import type { FileAssignmentConfig, AssignedSymbol } from "./file-assignment.js";
import { assignSymbolsToFiles, groupByFile } from "./file-assignment.js";
import { IR } from "../services/ir.js";
import { Inflection, type CoreInflection } from "../services/inflection.js";
import { TypeHints, type TypeHintRegistry } from "../services/type-hints.js";
import type { SemanticIR } from "../ir/semantic-ir.js";
import { Conjure, CurrentPluginContext, makeConjureService } from "../services/conjure.js";
import { IRExtensions, IRExtensionsImpl } from "../services/ir-extensions.js";

/**
 * Result of running the orchestrator.
 */
export interface OrchestratorResult {
  /** All rendered symbols from all plugins */
  readonly rendered: readonly RenderedSymbol[];

  /** Symbols grouped by output file */
  readonly fileGroups: ReadonlyMap<string, readonly AssignedSymbol<RenderedSymbol>[]>;

  /** The symbol registry for lookups */
  readonly registry: SymbolRegistryImpl;

  /**
   * Cross-references tracked during render phase.
   * Maps: capability -> capabilities it references
   * Used by emit phase to generate imports.
   */
  readonly references: ReadonlyMap<Capability, readonly Capability[]>;
}

/**
 * Configuration for the orchestrator.
 */
export interface OrchestratorConfig {
  /** Plugins to run (or plugin factories) */
  readonly plugins: readonly Plugin[];

  /** Semantic IR */
  readonly ir: SemanticIR;

  /** Inflection service instance */
  readonly inflection: CoreInflection;

  /** Type hints registry */
  readonly typeHints: TypeHintRegistry;

  /** Default file for unmatched symbols */
  readonly defaultFile?: string;

  /** Base output directory (plugins' fileDefaults may use this via FileNamingContext) */
  readonly outputDir: string;
}

/**
 * Run plugins through render-first execution.
 *
 * Phases:
 * 1. Render: All plugins generate AST via Conjure (symbols auto-register)
 * 2. Validate: Check for conflicts and missing refs (post-render)
 * 3. Assign: Assign symbols to output files
 *
 * @param config - Orchestrator configuration
 */
/**
 * Sort plugins topologically based on provides/consumes dependencies.
 * Plugins that provide capabilities must run before plugins that consume them.
 */
function sortPluginsByDependencies(plugins: readonly Plugin[]): readonly Plugin[] {
  // Build a map of category -> providing plugin
  const categoryProviders = new Map<string, Plugin>();
  for (const plugin of plugins) {
    for (const cap of plugin.provides) {
      if (!cap.includes(":")) {
        categoryProviders.set(cap, plugin);
      }
    }
  }

  // Build dependency graph: plugin -> plugins it depends on
  const dependsOn = new Map<Plugin, Set<Plugin>>();
  for (const plugin of plugins) {
    const deps = new Set<Plugin>();
    for (const cap of plugin.consumes ?? []) {
      const provider = categoryProviders.get(cap);
      if (provider && provider !== plugin) {
        deps.add(provider);
      }
    }
    dependsOn.set(plugin, deps);
  }

  // Topological sort using Kahn's algorithm
  const sorted: Plugin[] = [];
  const remaining = new Set(plugins);

  while (remaining.size > 0) {
    // Find plugins with no unsatisfied dependencies
    const ready: Plugin[] = [];
    for (const plugin of remaining) {
      const deps = dependsOn.get(plugin) ?? new Set();
      const unsatisfied = [...deps].filter(d => remaining.has(d));
      if (unsatisfied.length === 0) {
        ready.push(plugin);
      }
    }

    if (ready.length === 0) {
      // Circular dependency - just take any remaining plugin
      ready.push([...remaining][0]!);
    }

    for (const plugin of ready) {
      sorted.push(plugin);
      remaining.delete(plugin);
    }
  }

  return sorted;
}

export const runPlugins = (config: OrchestratorConfig) =>
  Effect.gen(function* () {
    const registry = new SymbolRegistryImpl();

    // Sort plugins by dependencies - providers before consumers
    const plugins = sortPluginsByDependencies(config.plugins);
    // Debug: log plugin order
    // console.log("Plugin order:", plugins.map(p => `${p.name}(provides:${p.provides.join(",")},consumes:${(p.consumes ?? []).join(",")})`));

    // Collect file defaults from all plugins
    const pluginFileDefaults = Arr.flatMap(plugins, p => p.fileDefaults ?? []);

    // Build file assignment config
    const fileAssignment: FileAssignmentConfig = {
      outputDir: config.outputDir,
      rules: pluginFileDefaults,
      defaultFile: config.defaultFile ?? "index.ts",
      inflection: config.inflection,
    };

    // Build service layers
    const irLayer = Layer.succeed(IR, config.ir);
    const inflectionLayer = Layer.succeed(Inflection, config.inflection);
    const typeHintsLayer = Layer.succeed(TypeHints, config.typeHints);
    const baseLayer = Layer.mergeAll(irLayer, inflectionLayer, typeHintsLayer);

    // Phase 0: Register category providers
    // Categories are bare strings in `provides` (no colons), e.g., "queries", "schema"
    // This must happen before render so capability resolution works
    const categoryRegistrations = pipe(
      plugins,
      Arr.flatMap(plugin =>
        plugin.provides
          .filter(cap => !cap.includes(":"))
          .map(cap => ({ cap, pluginName: plugin.name })),
      ),
    );
    yield* Effect.forEach(categoryRegistrations, ({ cap, pluginName }) =>
      registry.registerCategoryProvider(cap, pluginName),
    );

    // Phase 1: Render - add SymbolRegistry, Conjure, and IRExtensions services
    const registryLayer = Layer.succeed(SymbolRegistry, registry.toService());

    // Create Conjure service with the registry
    const conjureService = makeConjureService({
      register: decl => registry.register(decl),
      storeRenderedSymbol: symbol => registry.storeRenderedSymbol(symbol),
      import: capability => registry.import(capability),
      forSymbol: <T>(capability: string, fn: () => T) => registry.forSymbol(capability, fn),
    });
    const conjureLayer = Layer.succeed(Conjure, conjureService);

    // Create IRExtensions service for plugin coordination (schema builder sharing)
    const irExtensions = new IRExtensionsImpl();
    const irExtensionsLayer = Layer.succeed(IRExtensions, irExtensions.toService());

    const renderLayer = Layer.mergeAll(baseLayer, registryLayer, conjureLayer, irExtensionsLayer);

    // Run render phase for all plugins
    yield* Effect.forEach(
      plugins,
      plugin =>
        Effect.gen(function* () {
          // Handle renderWithImports - record references before render
          (plugin.renderWithImports ?? []).forEach(cap => {
            registry.import(cap).ref();
          });

          // Set plugin context in FiberRef for Conjure service capability inference
          yield* FiberRef.set(CurrentPluginContext, {
            pluginName: plugin.name,
            provides: plugin.provides,
          });

          // Run render - plugins return AST statements, Conjure populates registry
          yield* plugin.render.pipe(Effect.provide(renderLayer));

          // Clear plugin context after render
          yield* FiberRef.set(CurrentPluginContext, null);
        }),
      { discard: true },
    );

    // Collect rendered symbols from registry (populated by Conjure's exp.* calls)
    const allRendered = registry.getAllRenderedSymbols();

    // Phase 2: Validate (post-render)
    yield* validateAll(plugins, registry);

    // Phase 3: Assign symbols to files (using RenderedSymbol)
    const assigned = assignSymbolsToFiles(allRendered, fileAssignment);
    const fileGroups = groupByFile(assigned);

    return {
      rendered: allRendered,
      fileGroups,
      registry,
      references: registry.getAllReferences(),
    };
  });

import { Effect, Layer, Array } from "effect";
import type { Plugin, SymbolDeclaration, RenderedSymbol, Capability } from "./types.js";
import { SymbolRegistry, SymbolRegistryImpl } from "./registry.js";
import { validateAll } from "./validation.js";
import type { FileAssignmentConfig, AssignedSymbol } from "./file-assignment.js";
import { assignSymbolsToFiles, groupByFile } from "./file-assignment.js";
import { IR } from "../services/ir.js";
import { Inflection, type CoreInflection } from "../services/inflection.js";
import { TypeHints, type TypeHintRegistry } from "../services/type-hints.js";
import type { SemanticIR } from "../ir/semantic-ir.js";

/**
 * Result of running the orchestrator.
 */
export interface OrchestratorResult {
  /** All symbol declarations from all plugins */
  readonly declarations: readonly SymbolDeclaration[];

  /** All rendered symbols from all plugins */
  readonly rendered: readonly RenderedSymbol[];

  /** Symbols grouped by output file */
  readonly fileGroups: ReadonlyMap<string, readonly AssignedSymbol[]>;

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
 * Run plugins through two-phase execution.
 *
 * Phases:
 * 1. Declare: All plugins declare their symbols (with IR, Inflection, TypeHints services)
 * 2. Validate: Check capability satisfaction and dependency cycles
 * 3. Assign: Assign symbols to output files
 * 4. Render: All plugins render their symbol bodies (with SymbolRegistry service added)
 *
 * @param config - Orchestrator configuration
 */
export const runPlugins = (config: OrchestratorConfig) =>
  Effect.gen(function* () {
    const registry = new SymbolRegistryImpl();

    const plugins = config.plugins;

    // Collect file defaults from all plugins
    const pluginFileDefaults = Array.flatMap(plugins, p => p.fileDefaults ?? []);

    // Use plugin file defaults directly (no user overrides - plugins handle their own config)
    const mergedRules = pluginFileDefaults;

    // Build file assignment config
    const fileAssignment: FileAssignmentConfig = {
      outputDir: config.outputDir,
      rules: mergedRules,
      defaultFile: config.defaultFile ?? "index.ts",
      inflection: config.inflection,
    };

    // Build service layers
    const irLayer = Layer.succeed(IR, config.ir);
    const inflectionLayer = Layer.succeed(Inflection, config.inflection);
    const typeHintsLayer = Layer.succeed(TypeHints, config.typeHints);
    const declareLayer = Layer.mergeAll(irLayer, inflectionLayer, typeHintsLayer);

    // Phase 0: Register category providers
    // Categories are bare strings in `provides` (no colons), e.g., "queries", "schema"
    // This must happen before declare phase so capability resolution works
    for (const plugin of plugins) {
      for (const cap of plugin.provides) {
        // A category is a bare string without colons
        if (!cap.includes(":")) {
          yield* registry.registerCategoryProvider(cap, plugin.name);
        }
      }
    }

    // Phase 1: Declare - collect all symbol declarations
    // Track which plugin declared which capabilities for Phase 4
    const allDeclarations: SymbolDeclaration[] = [];
    const capabilitiesByPlugin = new Map<Plugin, readonly Capability[]>();

    for (const plugin of plugins) {
      const decls = yield* plugin.declare.pipe(Effect.provide(declareLayer));
      yield* registry.registerAll(decls);
      allDeclarations.push(...decls);
      capabilitiesByPlugin.set(plugin, decls.map(d => d.capability));
    }

    // Phase 2: Validate
    yield* validateAll(plugins, registry);

    // Phase 3: Assign symbols to files
    const assigned = assignSymbolsToFiles(allDeclarations, fileAssignment);
    const fileGroups = groupByFile(assigned);

    // Phase 4: Render - add SymbolRegistry service
    const registryLayer = Layer.succeed(SymbolRegistry, registry.toService());
    const renderLayer = Layer.merge(declareLayer, registryLayer);

    const allRendered: RenderedSymbol[] = [];
    for (const plugin of plugins) {
      // Set context so registry knows which capabilities are being rendered
      // Use the capabilities declared by this plugin in Phase 1
      const pluginCapabilities = capabilitiesByPlugin.get(plugin) ?? [];
      registry.setCurrentCapabilities(pluginCapabilities);

      // Set owned declarations so plugins can iterate with registry.own()
      const pluginDeclarations = allDeclarations.filter(d =>
        pluginCapabilities.includes(d.capability),
      );
      registry.setOwnedDeclarations(pluginDeclarations);

      // Handle renderWithImports - record references before render
      // We need to actually call .ref() to trigger reference tracking
      if (plugin.renderWithImports) {
        for (const cap of plugin.renderWithImports) {
          registry.import(cap).ref(); // Call ref() to record the reference
        }
      }

      const rendered = yield* plugin.render.pipe(Effect.provide(renderLayer));

      // Store rendered output and metadata for consumers
      for (const symbol of rendered) {
        registry.setRendered(symbol.capability, symbol.node, symbol.metadata);
      }

      allRendered.push(...rendered);

      registry.clearCurrentCapabilities();
    }

    return {
      declarations: allDeclarations,
      rendered: allRendered,
      fileGroups,
      registry,
      references: registry.getAllReferences(),
    };
  });

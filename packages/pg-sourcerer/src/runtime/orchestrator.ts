import { Effect, Layer, Array as Arr, FiberRef, pipe } from "effect";
import type { Plugin, SymbolDeclaration, RenderedSymbol, Capability } from "./types.js";
import { SymbolRegistry, SymbolRegistryImpl } from "./registry.js";
import { validateAll } from "./validation.js";
import type { FileAssignmentConfig, AssignedSymbol } from "./file-assignment.js";
import { assignSymbolsToFiles, groupByFile } from "./file-assignment.js";
import { IR } from "../services/ir.js";
import { Inflection, type CoreInflection } from "../services/inflection.js";
import { TypeHints, type TypeHintRegistry } from "../services/type-hints.js";
import type { SemanticIR } from "../ir/semantic-ir.js";
import { Conjure, CurrentPluginContext, makeConjureService } from "../services/conjure.js";

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
    const pluginFileDefaults = Arr.flatMap(plugins, p => p.fileDefaults ?? []);

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

    // Phase 1: Declare - collect all symbol declarations
    // Track which plugin declared which capabilities for Phase 4
    const declarationResults = yield* Effect.forEach(plugins, plugin =>
      Effect.gen(function* () {
        const decls = yield* plugin.declare.pipe(Effect.provide(declareLayer));
        yield* registry.registerAll(decls);
        return { plugin, decls };
      }),
    );

    const allDeclarations = Arr.flatMap(declarationResults, r => r.decls);
    const capabilitiesByPlugin = new Map<Plugin, readonly Capability[]>(
      declarationResults.map(({ plugin, decls }) => [plugin, decls.map(d => d.capability)]),
    );

    // Phase 2: Validate
    yield* validateAll(plugins, registry);

    // Phase 3: Assign symbols to files
    const assigned = assignSymbolsToFiles(allDeclarations, fileAssignment);
    const fileGroups = groupByFile(assigned);

    // Phase 4: Render - add SymbolRegistry and Conjure services
    const registryLayer = Layer.succeed(SymbolRegistry, registry.toService());
    
    // Create Conjure service with the registry
    const conjureService = makeConjureService({
      register: (decl) => registry.register(decl),
      setRendered: (capability, node, metadata) => registry.setRendered(capability, node, metadata),
      import: (capability) => registry.import(capability),
    });
    const conjureLayer = Layer.succeed(Conjure, conjureService);
    
    const renderLayer = Layer.mergeAll(declareLayer, registryLayer, conjureLayer);

    // Helper to safely record a schema reference for a symbol
    const recordSchemaRef = (capability: Capability, refName: string): void => {
      try {
        registry.forSymbol(capability, () => {
          try {
            registry.import(`schema:${refName}`).ref();
          } catch {
            // ignore missing capabilities
          }
        });
      } catch {
        // ignore
      }
    };

    // Helper to process rendered symbols (record refs, set rendered output)
    const processRenderedSymbols = (rendered: readonly RenderedSymbol[]): void => {
      rendered.forEach(symbol => {
        // If conjure attached metadata with referenced identifiers (refs),
        // record cross-file references by importing the corresponding schema
        // capabilities. This allows conjure-created `typeof X` usages to be
        // attributed to the proper capability without plugins calling
        // registry.import(...) themselves.
        const refs = symbol.refs;
        if (refs && Array.isArray(refs)) {
          refs.forEach(refName => recordSchemaRef(symbol.capability, refName));
        }

        // Store rendered output and metadata for consumers
        registry.setRendered(symbol.capability, symbol.node, symbol.metadata);
      });
    };

    const renderResults = yield* Effect.forEach(plugins, plugin =>
      Effect.gen(function* () {
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
        (plugin.renderWithImports ?? []).forEach(cap => {
          registry.import(cap).ref();
        });

        // Set plugin context in FiberRef for Conjure service capability inference
        yield* FiberRef.set(CurrentPluginContext, {
          pluginName: plugin.name,
          provides: plugin.provides,
        });

        const rendered = yield* plugin.render.pipe(Effect.provide(renderLayer));

        processRenderedSymbols(rendered);

        // Clear plugin context after render
        yield* FiberRef.set(CurrentPluginContext, null);
        registry.clearCurrentCapabilities();

        return rendered;
      }),
    );

    const allRendered = Arr.flatten(renderResults);

    return {
      declarations: allDeclarations,
      rendered: allRendered,
      fileGroups,
      registry,
      references: registry.getAllReferences(),
    };
  });

import { Effect, Layer } from "effect";
import type { Plugin, SymbolDeclaration, RenderedSymbol, Capability } from "./types.js";
import { SymbolRegistry, SymbolRegistryImpl, type SymbolCollision } from "./registry.js";
import { validateAll, type UnsatisfiedCapability, type CircularDependency } from "./validation.js";
import type { FileAssignmentConfig, AssignedSymbol } from "./file-assignment.js";
import { assignSymbolsToFiles, groupByFile } from "./file-assignment.js";
import { IR } from "../services/ir.js";
import { Inflection, type CoreInflection } from "../services/inflection.js";
import { TypeHints, type TypeHintRegistry } from "../services/type-hints.js";
import type { SemanticIR } from "../ir/semantic-ir.js";
import type { DeclareError, RenderError } from "./errors.js";

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
  /** Semantic IR */
  readonly ir: SemanticIR;

  /** Inflection service instance */
  readonly inflection: CoreInflection;

  /** Type hints registry */
  readonly typeHints: TypeHintRegistry;

  /** File assignment configuration */
  readonly fileAssignment: FileAssignmentConfig;
}

/** All errors that can occur during plugin execution */
export type PluginExecutionError =
  | UnsatisfiedCapability
  | CircularDependency
  | SymbolCollision
  | DeclareError
  | RenderError;

/**
 * Run plugins through two-phase execution.
 *
 * Phases:
 * 1. Declare: All plugins declare their symbols (with IR, Inflection, TypeHints services)
 * 2. Validate: Check capability satisfaction and dependency cycles
 * 3. Assign: Assign symbols to output files
 * 4. Render: All plugins render their symbol bodies (with SymbolRegistry service added)
 */
export function runPlugins(
  plugins: readonly Plugin[],
  config: OrchestratorConfig,
): Effect.Effect<OrchestratorResult, PluginExecutionError> {
  return Effect.gen(function* () {
    const registry = new SymbolRegistryImpl();

    // Build service layers
    const irLayer = Layer.succeed(IR, config.ir);
    const inflectionLayer = Layer.succeed(Inflection, config.inflection);
    const typeHintsLayer = Layer.succeed(TypeHints, config.typeHints);
    const declareLayer = Layer.mergeAll(irLayer, inflectionLayer, typeHintsLayer);

    // Phase 1: Declare - collect all symbol declarations
    const allDeclarations: SymbolDeclaration[] = [];
    for (const plugin of plugins) {
      const decls = yield* plugin.declare.pipe(Effect.provide(declareLayer));
      yield* registry.registerAll(decls);
      allDeclarations.push(...decls);
    }

    // Phase 2: Validate
    yield* validateAll(plugins, registry);

    // Phase 3: Assign symbols to files
    const assigned = assignSymbolsToFiles(allDeclarations, config.fileAssignment);
    const fileGroups = groupByFile(assigned);

    // Phase 4: Render - add SymbolRegistry service
    const registryLayer = Layer.succeed(SymbolRegistry, registry.toService());
    const renderLayer = Layer.merge(declareLayer, registryLayer);

    const allRendered: RenderedSymbol[] = [];
    for (const plugin of plugins) {
      // Set context so registry knows which capabilities are being rendered
      registry.setCurrentCapabilities(plugin.provides);

      // Handle renderWithImports - record references before render
      // We need to actually call .ref() to trigger reference tracking
      if (plugin.renderWithImports) {
        for (const cap of plugin.renderWithImports) {
          registry.import(cap).ref(); // Call ref() to record the reference
        }
      }

      const rendered = yield* plugin.render.pipe(Effect.provide(renderLayer));
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
}

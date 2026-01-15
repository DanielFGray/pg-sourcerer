import recast from "recast";
import type { namedTypes as n } from "ast-types";
import type { ExpressionKind } from "ast-types/lib/gen/kinds.js";
import { Context, Effect, Schema } from "effect";
import type { Capability, SymbolDeclaration, SymbolRef, SymbolHandle } from "./types.js";

const b = recast.types.builders;

function toExpr(node: n.Expression): ExpressionKind {
  return node as ExpressionKind;
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error thrown when two plugins try to register the same capability.
 */
export class SymbolCollision extends Schema.TaggedError<SymbolCollision>()("SymbolCollision", {
  message: Schema.String,
  capability: Schema.String,
  existingSymbol: Schema.String,
  newSymbol: Schema.String,
}) {}

/**
 * Error when trying to get a handle for an unregistered capability.
 */
export class CapabilityNotFound extends Schema.TaggedError<CapabilityNotFound>()(
  "CapabilityNotFound",
  {
    message: Schema.String,
    capability: Schema.String,
  },
) {}

// =============================================================================
// SymbolHandle Implementation
// =============================================================================

/**
 * Creates a SymbolHandle that tracks cross-references.
 *
 * @param decl - The symbol being referenced
 * @param onReference - Callback when ref() or call() is invoked (for import tracking)
 */
export function createSymbolHandle(
  decl: SymbolDeclaration,
  onReference?: (capability: Capability) => void,
): SymbolHandle {
  return {
    name: decl.name,
    capability: decl.capability,
    ref: () => {
      onReference?.(decl.capability);
      return b.identifier(decl.name);
    },
    call: (...args: unknown[]) => {
      onReference?.(decl.capability);
      return b.callExpression(
        b.identifier(decl.name),
        args.map(arg => toExpr(arg as n.Expression)),
      );
    },
  };
}

// =============================================================================
// SymbolRegistry Service Interface
// =============================================================================

/**
 * Service interface for SymbolRegistry - what plugins see.
 */
export interface SymbolRegistryService {
  /** Resolve a capability to its symbol reference */
  readonly resolve: (capability: Capability) => SymbolRef | undefined;

  /** Get a handle for importing another symbol (tracks cross-references) */
  readonly import: (capability: Capability) => SymbolHandle;
}

/**
 * Effect Context tag for SymbolRegistry service.
 * Plugins access this in render phase via `yield* SymbolRegistry`.
 */
export class SymbolRegistry extends Context.Tag("SymbolRegistry")<
  SymbolRegistry,
  SymbolRegistryService
>() {}

// =============================================================================
// SymbolRegistry Implementation
// =============================================================================

/**
 * Internal registry implementation that tracks all declared symbols.
 *
 * Used during the two-phase plugin execution:
 * 1. Declare phase: Plugins register symbols via register()
 * 2. Render phase: Plugins lookup symbols via resolve()/import()
 *
 * During render phase, tracks cross-references between capabilities
 * for import generation in the emit phase.
 */
export class SymbolRegistryImpl {
  private symbols = new Map<Capability, SymbolDeclaration>();
  private referenceCallbacks = new Map<Capability, Set<(capability: Capability) => void>>();

  /**
   * Cross-reference tracking: Maps source capability -> set of referenced capabilities.
   * Populated during render phase when registry.import(cap).ref() is called.
   */
  private references = new Map<Capability, Set<Capability>>();

  /**
   * Current capabilities being rendered. Set by orchestrator before calling render().
   * When a handle's ref()/call() is invoked, edges are added from these to the target.
   */
  private currentCapabilities: readonly Capability[] = [];

  /**
   * Register a symbol declaration. Called during declare phase.
   * Returns Effect that fails with SymbolCollision if capability already registered.
   */
  register(decl: SymbolDeclaration): Effect.Effect<void, SymbolCollision> {
    return Effect.gen(this, function* () {
      if (this.symbols.has(decl.capability)) {
        const existing = this.symbols.get(decl.capability)!;
        return yield* new SymbolCollision({
          message: `Capability "${decl.capability}" already registered by symbol "${existing.name}"`,
          capability: decl.capability,
          existingSymbol: existing.name,
          newSymbol: decl.name,
        });
      }
      this.symbols.set(decl.capability, decl);
    });
  }

  /**
   * Register multiple declarations at once.
   */
  registerAll(decls: readonly SymbolDeclaration[]): Effect.Effect<void, SymbolCollision> {
    return Effect.forEach(decls, decl => this.register(decl), { discard: true });
  }

  /**
   * Resolve a capability to its symbol reference.
   * Returns undefined if not found.
   */
  resolve(capability: Capability): SymbolRef | undefined {
    const decl = this.symbols.get(capability);
    if (!decl) return undefined;
    return { name: decl.name, capability: decl.capability };
  }

  /**
   * Check if a capability is registered.
   */
  has(capability: Capability): boolean {
    return this.symbols.has(capability);
  }

  /**
   * Register a callback to be invoked when a symbol is referenced.
   * Used for import tracking across files.
   */
  onReference(capability: Capability, callback: (capability: Capability) => void): void {
    if (!this.referenceCallbacks.has(capability)) {
      this.referenceCallbacks.set(capability, new Set());
    }
    this.referenceCallbacks.get(capability)!.add(callback);
  }

  /**
   * Get a SymbolHandle for referencing another symbol.
   * The handle tracks when ref()/call() are used for import generation.
   * Returns Effect that fails with CapabilityNotFound if not registered.
   */
  getHandle(capability: Capability): Effect.Effect<SymbolHandle, CapabilityNotFound> {
    return Effect.gen(this, function* () {
      const decl = this.symbols.get(capability);
      if (!decl) {
        return yield* new CapabilityNotFound({
          message: `Capability "${capability}" not found in registry`,
          capability,
        });
      }
      return createSymbolHandle(decl, cap => {
        this.recordReference(cap);
        const callbacks = this.referenceCallbacks.get(cap);
        callbacks?.forEach(cb => cb(cap));
      });
    });
  }

  /**
   * Get a SymbolHandle synchronously (for service interface).
   * Throws if not found.
   */
  import(capability: Capability): SymbolHandle {
    const decl = this.symbols.get(capability);
    if (!decl) {
      throw new Error(`Capability "${capability}" not found in registry`);
    }
    return createSymbolHandle(decl, cap => {
      this.recordReference(cap);
      const callbacks = this.referenceCallbacks.get(cap);
      callbacks?.forEach(cb => cb(cap));
    });
  }

  /**
   * Get all registered symbols.
   */
  all(): readonly SymbolDeclaration[] {
    return Array.from(this.symbols.values());
  }

  /**
   * Get symbols that match a capability pattern.
   * Pattern uses simple prefix matching: "type:" matches all types.
   */
  query(pattern: string): readonly SymbolDeclaration[] {
    return this.all().filter(decl => decl.capability.startsWith(pattern));
  }

  /**
   * Get the declaration for a specific capability.
   */
  get(capability: Capability): SymbolDeclaration | undefined {
    return this.symbols.get(capability);
  }

  // ===========================================================================
  // Reference Tracking (for render phase)
  // ===========================================================================

  /**
   * Set the current capabilities being rendered.
   * Called by orchestrator before each plugin's render() phase.
   */
  setCurrentCapabilities(caps: readonly Capability[]): void {
    this.currentCapabilities = caps;
  }

  /**
   * Clear current capabilities context.
   * Called by orchestrator after each plugin's render() completes.
   */
  clearCurrentCapabilities(): void {
    this.currentCapabilities = [];
  }

  /**
   * Record a reference from current capabilities to target.
   * Called internally when SymbolHandle.ref() or .call() is invoked.
   */
  private recordReference(target: Capability): void {
    for (const source of this.currentCapabilities) {
      if (source === target) continue;
      if (!this.references.has(source)) {
        this.references.set(source, new Set());
      }
      this.references.get(source)!.add(target);
    }
  }

  /**
   * Get all capabilities referenced by a given capability.
   */
  getReferences(capability: Capability): readonly Capability[] {
    const refs = this.references.get(capability);
    return refs ? Array.from(refs) : [];
  }

  /**
   * Get the full reference map for emit phase.
   * Maps: source capability -> capabilities it references
   */
  getAllReferences(): ReadonlyMap<Capability, readonly Capability[]> {
    const result = new Map<Capability, readonly Capability[]>();
    for (const [source, targets] of this.references) {
      result.set(source, Array.from(targets));
    }
    return result;
  }

  /**
   * Create a service instance that conforms to SymbolRegistryService.
   * Used by orchestrator to provide the service to plugins.
   */
  toService(): SymbolRegistryService {
    return {
      resolve: cap => this.resolve(cap),
      import: cap => this.import(cap),
    };
  }
}

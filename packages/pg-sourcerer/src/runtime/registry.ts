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

/**
 * Error when multiple plugins try to provide the same capability category.
 */
export class CategoryConflict extends Schema.TaggedError<CategoryConflict>()("CategoryConflict", {
  message: Schema.String,
  category: Schema.String,
  existingProvider: Schema.String,
  newProvider: Schema.String,
}) {}

// =============================================================================
// SymbolHandle Implementation
// =============================================================================

/**
 * Metadata shape that includes an optional consume callback.
 * Schema plugins use this to provide validation wrappers.
 */
interface ConsumeableMetadata {
  consume?: (input: unknown) => unknown;
  [key: string]: unknown;
}

/**
 * Creates a SymbolHandle that tracks cross-references.
 *
 * @param decl - The symbol being referenced
 * @param metadata - Optional metadata from render phase (may include consume callback)
 * @param onReference - Callback when ref() or call() is invoked (for import tracking)
 */
export function createSymbolHandle(
  decl: SymbolDeclaration,
  metadata: unknown | undefined,
  onReference?: (capability: Capability) => void,
): SymbolHandle {
  // Extract consume callback from metadata if present
  const consumeFn = (metadata as ConsumeableMetadata | undefined)?.consume;

  return {
    name: decl.name,
    capability: decl.capability,
    metadata,
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
    consume: consumeFn
      ? (input: unknown) => {
          onReference?.(decl.capability);
          return consumeFn(input);
        }
      : undefined,
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

  /** Query for capabilities matching a prefix pattern */
  readonly query: (pattern: string) => readonly SymbolDeclaration[];

  /** Check if a capability is registered */
  readonly has: (capability: Capability) => boolean;

  /** Get rendered metadata for a capability */
  readonly getMetadata: (capability: Capability) => unknown;

  /**
   * Get declarations owned by the current plugin.
   * Returns only the symbols declared by this plugin in Phase 1.
   */
  readonly own: () => readonly SymbolDeclaration[];

  /**
   * Scope cross-reference tracking to a single symbol.
   * All `import().ref()` calls within the callback are attributed
   * only to the specified capability, not all plugin capabilities.
   *
   * @example
   * ```typescript
   * for (const decl of registry.own()) {
   *   registry.forSymbol(decl.capability, () => {
   *     const queryFn = registry.import(`queries:kysely:${entityName}`);
   *     queryFn.ref(); // Only attributed to decl.capability
   *   });
   * }
   * ```
   */
  readonly forSymbol: <T>(capability: Capability, fn: () => T) => T;
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
  private rendered = new Map<Capability, { node: unknown; metadata?: unknown }>();
  private referenceCallbacks = new Map<Capability, Set<(capability: Capability) => void>>();

  /**
   * Category providers: Maps category name -> provider plugin name.
   * e.g., "queries" -> "kysely", "schema" -> "zod"
   * Used to resolve generic capability prefixes to implementation-specific ones.
   */
  private categoryProviders = new Map<string, string>();

  /**
   * Cross-reference tracking: Maps source capability -> set of referenced capabilities.
   * Populated during render phase when registry.import(cap).ref() is called.
   */
  private references = new Map<Capability, Set<Capability>>();

  /**
   * Current capabilities being rendered. Set by orchestrator before calling render().
   * When a handle's ref()/call() is invoked, edges are added from these to the target.
   * 
   * When forSymbol() is active, this contains only the single scoped capability.
   */
  private currentCapabilities: readonly Capability[] = [];

  /**
   * Declarations owned by the current plugin.
   * Set by orchestrator before render phase.
   */
  private ownedDeclarations: readonly SymbolDeclaration[] = [];

  /**
   * Stack for nested forSymbol() calls (though nesting is unusual).
   * Stores the previous currentCapabilities to restore after forSymbol() completes.
   */
  private capabilityStack: (readonly Capability[])[] = [];

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
   * Store rendered output for a symbol. Called during render phase.
   */
  setRendered(capability: Capability, node: unknown, metadata?: unknown): void {
    this.rendered.set(capability, { node, metadata });
  }

  /**
   * Get rendered metadata for a capability.
   */
  getRenderedMetadata(capability: Capability): unknown {
    return this.rendered.get(capability)?.metadata;
  }

  /**
   * Register multiple declarations at once.
   */
  registerAll(decls: readonly SymbolDeclaration[]): Effect.Effect<void, SymbolCollision> {
    return Effect.forEach(decls, decl => this.register(decl), { discard: true });
  }

  // ===========================================================================
  // Category Provider Registration
  // ===========================================================================

  /**
   * Register a plugin as the provider for a capability category.
   * Only one plugin can provide each category.
   *
   * @param category - Category name (e.g., "queries", "schema")
   * @param pluginName - Name of the plugin providing this category
   */
  registerCategoryProvider(
    category: string,
    pluginName: string,
  ): Effect.Effect<void, CategoryConflict> {
    return Effect.gen(this, function* () {
      if (this.categoryProviders.has(category)) {
        const existing = this.categoryProviders.get(category)!;
        return yield* new CategoryConflict({
          message: `Category "${category}" already provided by "${existing}", cannot add "${pluginName}"`,
          category,
          existingProvider: existing,
          newProvider: pluginName,
        });
      }
      this.categoryProviders.set(category, pluginName);
    });
  }

  /**
   * Get the provider name for a category.
   */
  getCategoryProvider(category: string): string | undefined {
    return this.categoryProviders.get(category);
  }

  /**
   * Resolve a generic capability to implementation-specific.
   *
   * Examples:
   * - "queries:User:findById" → "queries:kysely:User:findById" (if kysely provides queries)
   * - "schema:UserInsert" → "schema:zod:UserInsert" (if zod provides schema)
   * - "queries:kysely:User:findById" → unchanged (already specific)
   * - "type:User" → unchanged (no category provider needed)
   */
  resolveCapability(capability: Capability): Capability {
    const colonIdx = capability.indexOf(":");
    if (colonIdx === -1) return capability;

    const category = capability.slice(0, colonIdx);
    const rest = capability.slice(colonIdx + 1);

    const provider = this.categoryProviders.get(category);
    if (!provider) return capability; // No provider for this category

    // Check if rest already starts with the provider name (already specific)
    if (rest.startsWith(`${provider}:`)) return capability;

    // Also check if rest starts with a known provider (different from current)
    // This handles the case where the capability is already implementation-specific
    // We can detect this by checking if there's another colon and the first segment
    // looks like a provider name (lowercase, short)
    const nextColonIdx = rest.indexOf(":");
    if (nextColonIdx !== -1) {
      const possibleProvider = rest.slice(0, nextColonIdx);
      // If this looks like a provider name (e.g., "kysely", "zod", "drizzle"),
      // assume it's already specific. Simple heuristic: no uppercase, short.
      if (possibleProvider.length <= 15 && possibleProvider === possibleProvider.toLowerCase()) {
        // Check if we have this registered as ANY category provider
        for (const [, p] of this.categoryProviders) {
          if (p === possibleProvider) return capability; // Already specific
        }
      }
    }

    // Resolve: queries:User:findById → queries:kysely:User:findById
    return `${category}:${provider}:${rest}`;
  }

  /**
   * Resolve a capability to its symbol reference.
   * Automatically resolves generic capabilities to implementation-specific.
   * Returns undefined if not found.
   */
  resolve(capability: Capability): SymbolRef | undefined {
    const resolved = this.resolveCapability(capability);
    const decl = this.symbols.get(resolved);
    if (!decl) return undefined;
    return { name: decl.name, capability: decl.capability };
  }

  /**
   * Check if a capability is registered.
   * Automatically resolves generic capabilities to implementation-specific.
   */
  has(capability: Capability): boolean {
    const resolved = this.resolveCapability(capability);
    return this.symbols.has(resolved);
  }

  /**
   * Register a callback to be invoked when a symbol is referenced.
   * Used for import tracking across files.
   */
  onReference(capability: Capability, callback: (capability: Capability) => void): void {
    const resolved = this.resolveCapability(capability);
    if (!this.referenceCallbacks.has(resolved)) {
      this.referenceCallbacks.set(resolved, new Set());
    }
    this.referenceCallbacks.get(resolved)!.add(callback);
  }

  /**
   * Get a SymbolHandle for referencing another symbol.
   * The handle tracks when ref()/call() are used for import generation.
   * Automatically resolves generic capabilities to implementation-specific.
   * Returns Effect that fails with CapabilityNotFound if not registered.
   */
  getHandle(capability: Capability): Effect.Effect<SymbolHandle, CapabilityNotFound> {
    return Effect.gen(this, function* () {
      const resolved = this.resolveCapability(capability);
      const decl = this.symbols.get(resolved);
      if (!decl) {
        return yield* new CapabilityNotFound({
          message: `Capability "${capability}" not found in registry (resolved to "${resolved}")`,
          capability,
        });
      }
      const metadata = this.getRenderedMetadata(resolved);
      return createSymbolHandle(decl, metadata, cap => {
        this.recordReference(cap);
        const callbacks = this.referenceCallbacks.get(cap);
        callbacks?.forEach(cb => cb(cap));
      });
    });
  }

  /**
   * Get a SymbolHandle synchronously (for service interface).
   * Automatically resolves generic capabilities to implementation-specific.
   * Throws if not found.
   */
  import(capability: Capability): SymbolHandle {
    const resolved = this.resolveCapability(capability);
    const decl = this.symbols.get(resolved);
    if (!decl) {
      throw new Error(`Capability "${capability}" not found in registry (resolved to "${resolved}")`);
    }
    const metadata = this.getRenderedMetadata(resolved);
    return createSymbolHandle(decl, metadata, cap => {
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
   * Note: For category-based queries, use the implementation-specific prefix
   * (e.g., "queries:kysely:") or query by category pattern (e.g., "queries:").
   */
  query(pattern: string): readonly SymbolDeclaration[] {
    // If pattern is a bare category (e.g., "queries:"), resolve to provider prefix
    const colonIdx = pattern.indexOf(":");
    if (colonIdx !== -1 && pattern.endsWith(":")) {
      const category = pattern.slice(0, colonIdx);
      const provider = this.categoryProviders.get(category);
      if (provider) {
        // Query with resolved prefix: "queries:" → "queries:kysely:"
        const resolvedPattern = `${category}:${provider}:`;
        return this.all().filter(decl => decl.capability.startsWith(resolvedPattern));
      }
    }
    return this.all().filter(decl => decl.capability.startsWith(pattern));
  }

  /**
   * Get the declaration for a specific capability.
   * Automatically resolves generic capabilities to implementation-specific.
   */
  get(capability: Capability): SymbolDeclaration | undefined {
    const resolved = this.resolveCapability(capability);
    return this.symbols.get(resolved);
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
    this.ownedDeclarations = [];
    this.capabilityStack = [];
  }

  /**
   * Set the declarations owned by the current plugin.
   * Called by orchestrator before render phase.
   */
  setOwnedDeclarations(decls: readonly SymbolDeclaration[]): void {
    this.ownedDeclarations = decls;
  }

  /**
   * Get declarations owned by the current plugin.
   * Returns only the symbols declared by this plugin in Phase 1.
   */
  own(): readonly SymbolDeclaration[] {
    return this.ownedDeclarations;
  }

  /**
   * Scope cross-reference tracking to a single symbol.
   * All `import().ref()` calls within the callback are attributed
   * only to the specified capability.
   * 
   * @param capability - The capability to scope refs to
   * @param fn - Function to execute with scoped context
   * @returns The result of fn()
   */
  forSymbol<T>(capability: Capability, fn: () => T): T {
    // Push current state onto stack
    this.capabilityStack.push(this.currentCapabilities);
    // Set single capability as current
    this.currentCapabilities = [capability];
    try {
      return fn();
    } finally {
      // Restore previous state
      this.currentCapabilities = this.capabilityStack.pop() ?? [];
    }
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
      query: pattern => this.query(pattern),
      has: cap => this.has(cap),
      getMetadata: cap => this.getRenderedMetadata(cap),
      own: () => this.own(),
      forSymbol: <T>(cap: Capability, fn: () => T) => this.forSymbol(cap, fn),
    };
  }
}

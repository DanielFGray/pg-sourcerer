import * as recast from "recast";
import type { namedTypes as n } from "ast-types";
import type { ExpressionKind } from "ast-types/lib/gen/kinds.js";
import { Context, Effect, Schema, pipe, Array as Arr } from "effect";
import type { Capability, SymbolDeclaration, SymbolRef, SymbolHandle, RenderedSymbol } from "./types.js";

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
  consume?: (input: recast.types.ASTNode) => recast.types.ASTNode;
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
      ? (input: recast.types.ASTNode) => {
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

  /**
   * Store a complete RenderedSymbol directly.
   * Used for virtual symbols that have no AST node (e.g., schema builders).
   */
  readonly storeRenderedSymbol: (symbol: RenderedSymbol) => void;
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
   * Full RenderedSymbol storage for automatic symbol tracking.
   * Populated by Conjure service's exp.* methods during render phase.
   */
  private renderedSymbols = new Map<Capability, RenderedSymbol>();

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
        // Idempotent: if same name, already registered - skip
        if (existing.name === decl.name) {
          return;
        }
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
   *
   * Also records cross-file references from the symbol's refs field.
   * Refs are identifier names extracted from AST; we find matching
   * symbol declarations by name and prefer schema/type capabilities.
   *
   * @param capability - The capability being rendered
   * @param node - The rendered AST node
   * @param metadata - Optional metadata from the plugin
   * @param refs - Identifier names referenced by this symbol
   */
  setRendered(
    capability: Capability,
    node: unknown,
    metadata?: unknown,
    refs?: readonly string[],
  ): void {
    this.rendered.set(capability, { node, metadata });

    // Record cross-file references from provided refs
    if (refs && refs.length > 0) {
      for (const refName of refs) {
        // Find candidate declarations with the referenced name
        const candidates = Array.from(this.symbols.values()).filter(d => d.name === refName);
        if (candidates.length === 0) continue;

        // Prefer schema/type capabilities when ambiguous
        const chosen =
          candidates.find(c => c.capability.startsWith("schema:")) ||
          candidates.find(c => c.capability.startsWith("type:")) ||
          candidates[0];

        // Record cross-file reference: capability -> chosen.capability
        if (chosen && chosen.capability !== capability) {
          if (!this.references.has(capability)) {
            this.references.set(capability, new Set());
          }
          this.references.get(capability)!.add(chosen.capability);
        }
      }
    }
  }

  /**
   * Get rendered metadata for a capability.
   */
  getRenderedMetadata(capability: Capability): unknown {
    return this.rendered.get(capability)?.metadata;
  }

  /**
   * Store a complete RenderedSymbol. Called by Conjure's exp.* methods.
   * This is the primary storage for automatic symbol tracking.
   */
  storeRenderedSymbol(symbol: RenderedSymbol): void {
    // Register in symbols map so import() can find it
    if (!this.symbols.has(symbol.capability)) {
      this.symbols.set(symbol.capability, {
        name: symbol.name,
        capability: symbol.capability,
        baseEntityName: symbol.baseEntityName,
      });
    }

    this.renderedSymbols.set(symbol.capability, symbol);
    // Also update legacy rendered map for backward compatibility
    this.rendered.set(symbol.capability, { node: symbol.node, metadata: symbol.metadata });

    // Record cross-file references from provided refs
    if (symbol.refs && symbol.refs.length > 0) {
      for (const refName of symbol.refs) {
        const candidates = Array.from(this.symbols.values()).filter(d => d.name === refName);
        if (candidates.length === 0) continue;

        const chosen =
          candidates.find(c => c.capability.startsWith("schema:")) ||
          candidates.find(c => c.capability.startsWith("type:")) ||
          candidates[0];

        if (chosen && chosen.capability !== symbol.capability) {
          if (!this.references.has(symbol.capability)) {
            this.references.set(symbol.capability, new Set());
          }
          this.references.get(symbol.capability)!.add(chosen.capability);
        }
      }
    }
  }

  /**
   * Get rendered symbols for specific capabilities.
   * Used by orchestrator to collect symbols after render phase.
   */
  getRenderedSymbols(capabilities: readonly Capability[]): readonly RenderedSymbol[] {
    return pipe(
      capabilities,
      Arr.map(cap => this.renderedSymbols.get(cap)),
      Arr.filter((s): s is RenderedSymbol => s !== undefined),
    );
  }

  /**
   * Get all rendered symbols from all plugins.
   * Used by orchestrator when collecting final results.
   */
  getAllRenderedSymbols(): readonly RenderedSymbol[] {
    return Arr.fromIterable(this.renderedSymbols.values());
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
   * Categories like "schema" use Standard Schema API and are interchangeable,
   * so we don't inject provider names. Other categories like "queries" may need
   * implementation-specific resolution.
   *
   * Examples:
   * - "queries:User:findById" → "queries:kysely:User:findById" (if kysely provides queries)
   * - "schema:UserInsert" → "schema:UserInsert" (unchanged - Standard Schema is interchangeable)
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

    // Schema and type capabilities use the Standard Schema API - all implementations
    // are interchangeable. Do NOT inject provider name for these categories so
    // declarations remain stable across providers.
    if (category === "schema" || category === "type") return capability;

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
        const isKnownProvider = pipe(
          Arr.fromIterable(this.categoryProviders.values()),
          Arr.some(p => p === possibleProvider),
        );
        if (isKnownProvider) return capability; // Already specific
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
    pipe(
      this.currentCapabilities,
      Arr.filter(source => source !== target),
      Arr.forEach(source => {
        if (!this.references.has(source)) {
          this.references.set(source, new Set());
        }
        this.references.get(source)!.add(target);
      }),
    );
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
    return pipe(
      Arr.fromIterable(this.references.entries()),
      Arr.reduce(new Map<Capability, readonly Capability[]>(), (result, [source, targets]) => {
        result.set(source, Arr.fromIterable(targets));
        return result;
      }),
    );
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
      storeRenderedSymbol: symbol => this.storeRenderedSymbol(symbol),
    };
  }
}

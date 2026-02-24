/**
 * Conjure - Effect service for contextual AST building with automatic symbol tracking
 *
 * Provides AST builders that automatically register symbols with the orchestrator.
 * Plugins access via `yield* Conjure` to get context-aware instance.
 */
import { Context, Effect, FiberRef } from "effect";
import type { namedTypes as n } from "ast-types";
import { conjure as conjureApi, extractIdentifierRefs } from "../conjure/index.js";
import type { RenderedSymbol, SymbolHandle } from "../runtime/types.js";
import type { ExternalImport } from "../runtime/emit.js";
import type { UserModuleRef } from "../user-module.js";
import { SymbolCollision } from "../runtime/registry.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Options for exp.* methods
 */
export interface ExpOpts {
  /**
   * Capability identifier for this symbol.
   * If omitted, inferred from plugin context + symbol name.
   */
  capability?: string;

  /**
   * External package imports needed by this symbol
   */
  imports?: readonly ExternalImport[];

  /**
   * Consumer callback: how to use/validate through this symbol.
   * Enables Liskov Substitution—consumers don't care if Zod or Effect Schema.
   */
  consume?: (input: n.Expression) => n.Expression;

  /**
   * Export style override (default: "named")
   */
  exports?: "named" | "default" | false;

  /**
   * Arbitrary metadata attached to this symbol
   */
  metadata?: unknown;

  /**
   * User module imports for this symbol.
   * These are resolved relative to the config file and converted to
   * correct relative paths for each output file at emit time.
   */
  userImports?: readonly UserModuleRef[];

  /**
   * The base entity name for file grouping purposes.
   * For shapes like "CommentInsert", this would be "Comment".
   */
  baseEntityName?: string;

  /**
   * Raw code to prepend to the output file (e.g., helper type definitions).
   * Deduplicated across symbols in the same file.
   */
  fileHeader?: string;
}


/**
 * Interface property specification
 */
export interface InterfaceProp {
  name: string;
  type: n.TSType;
  optional?: boolean;
  readonly?: boolean;
}

/**
 * Plugin context tracked via FiberRef
 */
export interface PluginContext {
  pluginName: string;
  provides: readonly string[];
}

/**
 * Registry interface for symbol registration
 * (Simplified interface that Conjure needs from SymbolRegistry)
 */
export interface ConjureRegistry {
  /** Register a symbol declaration (makes it findable) */
  register(decl: { name: string; capability: string }): Effect.Effect<void, SymbolCollision>;

  /** Store a complete RenderedSymbol (new API for automatic tracking) */
  storeRenderedSymbol(symbol: RenderedSymbol): void;

  /** Get a handle to an already-registered symbol */
  import(capability: string): SymbolHandle;

  /**
   * Scope cross-reference tracking to a single symbol.
   * All `import().ref()` calls within the callback are attributed
   * only to the specified capability.
   */
  forSymbol<T>(capability: string, fn: () => T): T;
}

// =============================================================================
// Conjure Service Interface
// =============================================================================

export interface ConjureService {
  // ═══════════════════════════════════════════════════════════════════════════
  // Tracked exports - these register symbols automatically
  // ═══════════════════════════════════════════════════════════════════════════

  readonly exp: {
    /** Export const: `export const name = init` */
    const(name: string, init: n.Expression, opts?: ExpOpts): Effect.Effect<n.Statement, SymbolCollision>;

    /** Export type alias: `export type Name = Type` */
    type(name: string, type: n.TSType, opts?: ExpOpts): Effect.Effect<n.Statement, SymbolCollision>;

    /** Export interface: `export interface Name { ... }` */
    interface(
      name: string,
      props: InterfaceProp[],
      opts?: ExpOpts,
    ): Effect.Effect<n.Statement, SymbolCollision>;

    /** Export function: `export function name(...) { ... }` */
    fn(decl: n.FunctionDeclaration, opts?: ExpOpts): Effect.Effect<n.Statement, SymbolCollision>;

    /** Export class: `export class Name extends ... {}` */
    class(name: string, decl: n.ClassDeclaration, opts?: ExpOpts): Effect.Effect<n.Statement, SymbolCollision>;
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Cross-plugin references
  // ═══════════════════════════════════════════════════════════════════════════

  /** Import a symbol from another plugin, returns handle for AST generation */
  use(capability: string): SymbolHandle;

  // ═══════════════════════════════════════════════════════════════════════════
  // Pure AST builders - delegates to conjure API (no tracking)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Start chain from identifier */
  id: typeof conjureApi.id;

  /** Start chain from expression */
  chain: typeof conjureApi.chain;

  /** Object literal builder */
  obj: typeof conjureApi.obj;

  /** Array literal builder */
  arr: typeof conjureApi.arr;

  /** Function builder */
  fn: typeof conjureApi.fn;

  /** Literals */
  str: typeof conjureApi.str;
  num: typeof conjureApi.num;
  bool: typeof conjureApi.bool;

  /** TypeScript types */
  readonly ts: typeof conjureApi.ts;

  /** Statement builders */
  readonly stmt: typeof conjureApi.stmt;

  /** Parameter builders */
  readonly param: typeof conjureApi.param;
}

// =============================================================================
// Service Tag
// =============================================================================

export class Conjure extends Context.Tag("@pgsourcerer/Conjure")<Conjure, ConjureService>() {}

// =============================================================================
// FiberRef for Plugin Context
// =============================================================================

export const CurrentPluginContext = FiberRef.unsafeMake<PluginContext | null>(null);

// =============================================================================
// Implementation
// =============================================================================

/**
 * Infer capability from plugin context and symbol name
 */
function inferCapability(ctx: PluginContext | null, name: string, explicitCap?: string): string {
  if (explicitCap) return explicitCap;

  if (!ctx) {
    throw new Error(
      `Cannot infer capability for "${name}" - no plugin context. Either provide explicit capability or ensure plugin context is set.`,
    );
  }

  // Simple inference: pluginName:primaryProvides:name
  // e.g., "zod" provides ["schema"] → "schema:zod:User"
  const primaryProvides = ctx.provides[0];
  if (!primaryProvides) {
    throw new Error(
      `Cannot infer capability for "${name}" - plugin "${ctx.pluginName}" provides no capabilities`,
    );
  }

  return `${primaryProvides}:${ctx.pluginName}:${name}`;
}

/**
 * Build metadata object from ExpOpts
 */
function buildMetadata(opts?: ExpOpts): unknown {
  if (!opts?.consume && !opts?.metadata) return undefined;
  return {
    consume: opts?.consume,
    ...(typeof opts?.metadata === "object" ? opts?.metadata : { data: opts?.metadata }),
  };
}

/**
 * Create the Conjure service implementation
 */
export function makeConjureService(registry: ConjureRegistry): ConjureService {
  const exp = {
    const: (name: string, init: n.Expression, opts?: ExpOpts) =>
      Effect.gen(function* () {
        const ctx = yield* FiberRef.get(CurrentPluginContext);
        const capability = inferCapability(ctx, name, opts?.capability);

        // Register the declaration (makes symbol findable by other plugins)
        yield* registry.register({ name, capability });

        // Build the AST node - scoped for ref tracking
        const node = registry.forSymbol(capability, () => conjureApi.export.const(name, init));
        const refs = extractIdentifierRefs(node);

        // Store complete RenderedSymbol
        registry.storeRenderedSymbol({
          name,
          capability,
          node,
          exports: opts?.exports ?? "named",
          imports: opts?.imports,
          metadata: buildMetadata(opts),
          refs,
          userImports: opts?.userImports,
          baseEntityName: opts?.baseEntityName,
          fileHeader: opts?.fileHeader,
        });

        return node;
      }),

    type: (name: string, type: n.TSType, opts?: ExpOpts) =>
      Effect.gen(function* () {
        const ctx = yield* FiberRef.get(CurrentPluginContext);
        const capability = inferCapability(ctx, name, opts?.capability);

        // Register the declaration
        yield* registry.register({ name, capability });

        // Build the AST node - scoped for ref tracking
        const node = registry.forSymbol(capability, () => conjureApi.export.type(name, type));
        const refs = extractIdentifierRefs(node);

        // Store complete RenderedSymbol
        registry.storeRenderedSymbol({
          name,
          capability,
          node,
          exports: opts?.exports ?? "named",
          imports: opts?.imports,
          metadata: buildMetadata(opts),
          refs,
          userImports: opts?.userImports,
          baseEntityName: opts?.baseEntityName,
          fileHeader: opts?.fileHeader,
        });

        return node;
      }),

    interface: (name: string, props: InterfaceProp[], opts?: ExpOpts) =>
      Effect.gen(function* () {
        const ctx = yield* FiberRef.get(CurrentPluginContext);
        const capability = inferCapability(ctx, name, opts?.capability);

        // Register the declaration
        yield* registry.register({ name, capability });

        // Build the AST node - scoped for ref tracking
        const node = registry.forSymbol(capability, () => conjureApi.export.interface(name, props));
        const refs = extractIdentifierRefs(node);

        // Store complete RenderedSymbol
        registry.storeRenderedSymbol({
          name,
          capability,
          node,
          exports: opts?.exports ?? "named",
          imports: opts?.imports,
          metadata: buildMetadata(opts),
          refs,
          userImports: opts?.userImports,
          baseEntityName: opts?.baseEntityName,
          fileHeader: opts?.fileHeader,
        });

        return node;
      }),

    fn: (decl: n.FunctionDeclaration, opts?: ExpOpts) =>
      Effect.gen(function* () {
        const ctx = yield* FiberRef.get(CurrentPluginContext);

        // Extract function name from declaration
        const nameNode = decl.id;
        if (!nameNode || typeof nameNode !== "object" || !("name" in nameNode)) {
          throw new Error("Function declaration must have a name");
        }
        const name = nameNode.name as string;

        const capability = inferCapability(ctx, name, opts?.capability);

        // Register the declaration
        yield* registry.register({ name, capability });

        // Build the AST node - scoped for ref tracking
        const node = registry.forSymbol(capability, () => conjureApi.export.fn(decl));
        const refs = extractIdentifierRefs(node);

        // Store complete RenderedSymbol
        registry.storeRenderedSymbol({
          name,
          capability,
          node,
          exports: opts?.exports ?? "named",
          imports: opts?.imports,
          metadata: buildMetadata(opts),
          refs,
          userImports: opts?.userImports,
          baseEntityName: opts?.baseEntityName,
          fileHeader: opts?.fileHeader,
        });

        return node;
      }),

    class: (name: string, decl: n.ClassDeclaration, opts?: ExpOpts) =>
      Effect.gen(function* () {
        const ctx = yield* FiberRef.get(CurrentPluginContext);
        const capability = inferCapability(ctx, name, opts?.capability);

        // Register the declaration
        yield* registry.register({ name, capability });

        // Build the exported class node - scoped for ref tracking
        const node = registry.forSymbol(capability, () =>
          conjureApi.b.exportNamedDeclaration(decl, []),
        );
        const refs = extractIdentifierRefs(node);

        // Store complete RenderedSymbol
        registry.storeRenderedSymbol({
          name,
          capability,
          node,
          exports: opts?.exports ?? "named",
          imports: opts?.imports,
          metadata: buildMetadata(opts),
          refs,
          userImports: opts?.userImports,
          baseEntityName: opts?.baseEntityName,
          fileHeader: opts?.fileHeader,
        });

        return node;
      }),
  };

  const use = (capability: string) => {
    return registry.import(capability);
  };

  return {
    exp,
    use,
    // Delegate pure AST builders to conjure API
    id: conjureApi.id,
    chain: conjureApi.chain,
    obj: conjureApi.obj,
    arr: conjureApi.arr,
    fn: conjureApi.fn,
    str: conjureApi.str,
    num: conjureApi.num,
    bool: conjureApi.bool,
    ts: conjureApi.ts,
    stmt: conjureApi.stmt,
    param: conjureApi.param,
  };
}

/**
 * Create a Conjure Layer with the provided registry
 */
export function makeConjureLayer(registry: ConjureRegistry) {
  return Conjure.of(makeConjureService(registry));
}

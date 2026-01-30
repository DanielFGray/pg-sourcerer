/**
 * Conjure - Effect service for contextual AST building with automatic symbol tracking
 *
 * Provides AST builders that automatically register symbols with the orchestrator.
 * Plugins access via `yield* Conjure` to get context-aware instance.
 */
import { Context, Effect, FiberRef } from "effect";
import type { namedTypes as n } from "ast-types";
import { conjure as conjureApi, extractIdentifierRefs } from "../conjure/index.js";
import type { RenderedSymbol } from "../runtime/types.js";
import type { ExternalImport } from "../runtime/emit.js";

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
  imports?: ExternalImport[];

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
 * Symbol handle for cross-plugin references
 */
export interface SymbolHandle {
  name: string;
  capability: string;
  consume?: (input: n.Expression) => n.Expression;
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
  setRendered(capability: string, node: unknown, metadata?: unknown): void;
  import(capability: string): SymbolHandle;
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
    const(name: string, init: n.Expression, opts?: ExpOpts): Effect.Effect<n.Statement>;

    /** Export type alias: `export type Name = Type` */
    type(name: string, type: n.TSType, opts?: ExpOpts): Effect.Effect<n.Statement>;

    /** Export interface: `export interface Name { ... }` */
    interface(
      name: string,
      props: InterfaceProp[],
      opts?: ExpOpts,
    ): Effect.Effect<n.Statement>;

    /** Export function: `export function name(...) { ... }` */
    fn(decl: n.FunctionDeclaration, opts?: ExpOpts): Effect.Effect<n.Statement>;
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Cross-plugin references
  // ═══════════════════════════════════════════════════════════════════════════

  /** Import a symbol from another plugin, returns handle for AST generation */
  use(capability: string): Effect.Effect<SymbolHandle>;

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
 * Create the Conjure service implementation
 */
export function makeConjureService(registry: ConjureRegistry): ConjureService {
  const exp = {
    const: (name: string, init: n.Expression, opts?: ExpOpts) =>
      Effect.gen(function* () {
        const ctx = yield* FiberRef.get(CurrentPluginContext);
        const capability = inferCapability(ctx, name, opts?.capability);

        const node = conjureApi.export.const(name, init);
        const refs = extractIdentifierRefs(node);

        // Build metadata that includes consume callback and any user-provided metadata
        const metadata = opts?.consume || opts?.metadata
          ? {
              consume: opts?.consume,
              ...(typeof opts?.metadata === "object" ? opts?.metadata : { data: opts?.metadata }),
            }
          : undefined;

        // Register with the registry
        registry.setRendered(capability, node, metadata);

        return node;
      }),

    type: (name: string, type: n.TSType, opts?: ExpOpts) =>
      Effect.gen(function* () {
        const ctx = yield* FiberRef.get(CurrentPluginContext);
        const capability = inferCapability(ctx, name, opts?.capability);

        const node = conjureApi.export.type(name, type);
        const refs = extractIdentifierRefs(node);

        const metadata = opts?.consume || opts?.metadata
          ? {
              consume: opts?.consume,
              ...(typeof opts?.metadata === "object" ? opts?.metadata : { data: opts?.metadata }),
            }
          : undefined;

        registry.setRendered(capability, node, metadata);
        return node;
      }),

    interface: (name: string, props: InterfaceProp[], opts?: ExpOpts) =>
      Effect.gen(function* () {
        const ctx = yield* FiberRef.get(CurrentPluginContext);
        const capability = inferCapability(ctx, name, opts?.capability);

        const node = conjureApi.export.interface(name, props);
        const refs = extractIdentifierRefs(node);

        const metadata = opts?.consume || opts?.metadata
          ? {
              consume: opts?.consume,
              ...(typeof opts?.metadata === "object" ? opts?.metadata : { data: opts?.metadata }),
            }
          : undefined;

        registry.setRendered(capability, node, metadata);
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

        const node = conjureApi.export.fn(decl);
        const refs = extractIdentifierRefs(node);

        const metadata = opts?.consume || opts?.metadata
          ? {
              consume: opts?.consume,
              ...(typeof opts?.metadata === "object" ? opts?.metadata : { data: opts?.metadata }),
            }
          : undefined;

        registry.setRendered(capability, node, metadata);
        return node;
      }),
  };

  const use = (capability: string) =>
    Effect.sync(() => {
      return registry.import(capability);
    });

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

/**
 * Runtime Types for Two-Phase Plugin Execution
 */
import type { Effect } from "effect";
import type { IR } from "../services/ir.js";
import type { Inflection } from "../services/inflection.js";
import type { TypeHints } from "../services/type-hints.js";
import type { SymbolRegistry } from "./registry.js";
import type { DeclareError, RenderError } from "./errors.js";

/**
 * Capability identifier for symbol categorization.
 *
 * Examples:
 * - "type:User" - A TypeScript type for the User entity
 * - "schema:zod:User" - A Zod schema for User
 * - "query:findUserById" - A query function
 *
 * Combined with `name`, forms a unique symbol identity.
 */
export type Capability = string;

/**
 * What a plugin declares it will produce in Phase 1.
 *
 * Symbols are identified by `(name, capability)` tuple, allowing
 * multiple plugins to create symbols with the same name but different
 * capabilities (e.g., "User" as type vs "User" as Zod schema).
 */
export interface SymbolDeclaration {
  /** Symbol name, e.g., "User", "findUserById" */
  readonly name: string;

  /** Capability identifier, e.g., "type:User", "query:findUserById" */
  readonly capability: Capability;

  /** Capabilities this symbol requires from other plugins */
  readonly dependsOn?: readonly Capability[];
}

/**
 * Reference to a symbol for cross-plugin dependencies.
 */
export interface SymbolRef {
  /** Symbol name */
  readonly name: string;

  /** Capability identifier */
  readonly capability: Capability;
}

/**
 * What `render()` returns for each symbol in Phase 2.
 *
 * Contains the AST node and optional export configuration.
 */
export interface RenderedSymbol {
  /** Symbol name */
  readonly name: string;

  /** Capability identifier */
  readonly capability: Capability;

  /** AST node (recast/AST types - kept loose for flexibility) */
  readonly node: unknown;

  /** Export behavior: false=internal, true='named', 'default'=default export */
  readonly exports?: boolean | "default" | "named";
}

/**
 * Handle for referencing another symbol with automatic import tracking.
 *
 * Calling `.ref()` or `.call()` records the cross-reference, which the
 * runtime uses to auto-generate imports between files.
 */
export interface SymbolHandle {
  /** Symbol name */
  readonly name: string;

  /** Capability identifier */
  readonly capability: Capability;

  /** Use as type reference - returns AST node and tracks reference */
  ref: () => unknown;

  /** Use as call expression - returns AST node and tracks reference */
  call: (...args: unknown[]) => unknown;
}

// =============================================================================
// Services available to plugins
// =============================================================================

/**
 * Services available during declare phase.
 * Plugins access these via `yield* ServiceTag`.
 */
export type DeclareServices = IR | Inflection | TypeHints;

/**
 * Services available during render phase.
 * Includes DeclareServices plus SymbolRegistry for cross-plugin references.
 */
export type RenderServices = DeclareServices | SymbolRegistry;

// =============================================================================
// Plugin Interface
// =============================================================================

/**
 * Plugin interface for two-phase code generation.
 *
 * Plugins are Effects that access services and return immutable data.
 *
 * Example:
 * ```typescript
 * const typesPlugin: Plugin = {
 *   name: "types",
 *   provides: ["type:User"],
 *
 *   declare: Effect.gen(function* () {
 *     const ir = yield* IR
 *     return Array.from(ir.entities.values())
 *       .filter(isTableEntity)
 *       .map(e => ({ name: e.name, capability: `type:${e.name}` }))
 *   }),
 *
 *   render: Effect.gen(function* () {
 *     const ir = yield* IR
 *     const registry = yield* SymbolRegistry
 *     // ... generate AST
 *     return renderedSymbols
 *   }),
 * }
 * ```
 */
export interface Plugin {
  /** Plugin name for error messages and debugging */
  readonly name: string;

  /** Capabilities this plugin provides to the system */
  readonly provides: readonly Capability[];

  /** Capabilities this plugin requires from other plugins */
  readonly consumes?: readonly Capability[];

  /**
   * Capabilities to import during render phase.
   * These will be tracked as cross-references for import generation.
   * Alternative to calling registry.import() in render Effect.
   */
  readonly renderWithImports?: readonly Capability[];

  /** Phase 1: Declare symbols (Effect with DeclareServices) */
  readonly declare: Effect.Effect<readonly SymbolDeclaration[], DeclareError, DeclareServices>;

  /** Phase 2: Render symbol bodies (Effect with RenderServices) */
  readonly render: Effect.Effect<readonly RenderedSymbol[], RenderError, RenderServices>;
}

/**
 * Runtime Types for Two-Phase Plugin Execution
 */
import type { Effect } from "effect";
import type { namedTypes as n } from "ast-types";
import type { IR } from "../services/ir.js";
import type { Inflection } from "../services/inflection.js";
import type { TypeHints } from "../services/type-hints.js";
import type { SymbolRegistry, SymbolCollision } from "./registry.js";
import type { Conjure } from "../services/conjure.js";
import type { IRExtensions } from "../services/ir-extensions.js";
import type { RenderError } from "./errors.js";

/**
 * Union of errors that can occur during render phase.
 * Includes RenderError for plugin-level failures and SymbolCollision
 * for duplicate capability registration (via Conjure's exp.* methods).
 */
export type RenderPhaseError = RenderError | SymbolCollision;
import type { ExternalImport } from "./emit.js";
import type { FileRule } from "./file-assignment.js";
import type { UserModuleRef } from "../user-module.js";
import type recast from "recast";

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

  /**
   * Explicit output path for this symbol.
   * Relative to the output directory.
   * If not set, the file assignment rules will determine the path.
   */
  readonly outputPath?: string;

  /**
   * The base entity name for file grouping purposes.
   * For shapes like "CommentInsert", this would be "Comment".
   * If not set, falls back to parsing from capability/name.
   */
  readonly baseEntityName?: string;
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

  /** AST node for this symbol */
  readonly node: recast.types.ASTNode;

  /** Export behavior: 'named' | 'default' | false (false = internal/not exported) */
  readonly exports: "named" | "default" | false;

  /** Plugin-specific metadata for consumers (e.g., QueryDescriptor for query plugins) */
  readonly metadata?: unknown;

  /** External imports needed by this symbol (e.g., from npm packages) */
  readonly imports?: readonly ExternalImport[];

  /**
   * Identifier names referenced in this symbol's AST.
   * Used for automatic cross-file import tracking.
   * Populated by conjure.symbol.* or extracted from node.
   */
  readonly refs?: readonly string[];

  /**
   * User module imports for this symbol.
   * These are resolved relative to the config file and converted to
   * correct relative paths for each output file at emit time.
   */
  readonly userImports?: readonly UserModuleRef[];

  /**
   * @deprecated Use `userImports` instead. Raw code to prepend to the file.
   */
  readonly fileHeader?: string;

  /**
   * The base entity name for file grouping purposes.
   * For shapes like "CommentInsert", this would be "Comment".
   * Used by file assignment to group related symbols.
   */
  readonly baseEntityName?: string;
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

  /** Plugin-specific metadata (e.g., QueryDescriptor for query symbols) */
  readonly metadata?: unknown;

  /** Use as identifier - returns AST node and tracks reference */
  ref: () => recast.types.ASTNode;

  /** Use as call expression - returns AST node and tracks reference */
  call: (...args: recast.types.ASTNode[]) => recast.types.ASTNode;

  /**
   * Consume/validate input through this symbol.
   *
   * Used by schema plugins to provide validation wrappers that HTTP plugins
   * can use without knowing the specific schema library.
   *
   * Examples:
   * - Zod: `Schema.parse(input)` or `Schema.safeParse(input)`
   * - ArkType: `Schema(input)` or `Schema.assert(input)`
   * - Valibot: `v.parse(Schema, input)`
   *
   * Returns undefined if this symbol doesn't support consumption (e.g., types).
   */
  consume?: (input: recast.types.ASTNode) => recast.types.ASTNode;
}

// =============================================================================
// Finalize Hooks
// =============================================================================

/**
 * A file before writing to disk.
 * Used by transformFile hook.
 */
export interface FileOutput {
  /** Output path relative to outputDir */
  readonly path: string;
  /** Generated TypeScript code */
  readonly content: string;
}

/**
 * Error that can be returned from validate hook.
 */
export interface FinalizeValidationError {
  readonly message: string;
  readonly capability?: Capability;
}

/**
 * Hooks for transforming output before emit.
 *
 * Use cases:
 * - Custom formatting
 * - Adding license headers
 * - Removing debug code
 * - Additional validation rules
 * - Metrics/logging
 *
 * @example
 * ```typescript
 * defineConfig({
 *   hooks: {
 *     // Add license header to all files
 *     transformFile: (file) => ({
 *       ...file,
 *       content: `// Copyright 2024 My Company\n\n${file.content}`,
 *     }),
 *
 *     // Validate no console.log statements
 *     validate: (symbols) => {
 *       for (const sym of symbols) {
 *         // custom validation logic
 *       }
 *     },
 *   },
 * })
 * ```
 */
export interface FinalizeHooks {
  /**
   * Transform individual symbols after render, before emit.
   * Called for each rendered symbol. Return the transformed symbol.
   */
  readonly transformSymbol?: (symbol: RenderedSymbol) => RenderedSymbol;

  /**
   * Transform entire file before writing.
   * Called for each file after all symbols are collected.
   * Return the transformed file.
   */
  readonly transformFile?: (file: FileOutput) => FileOutput;

  /**
   * Validate rendered symbols.
   * Called after render but before emit.
   * Throw or return an error to fail generation.
   */
  readonly validate?: (symbols: readonly RenderedSymbol[]) => void | FinalizeValidationError;
}

// =============================================================================
// Services available to plugins
// =============================================================================

/**
 * Services available during render phase.
 * Plugins access these via `yield* ServiceTag`.
 */
export type RenderServices = IR | Inflection | TypeHints | SymbolRegistry | Conjure | IRExtensions;

// =============================================================================
// Plugin Interface
// =============================================================================

/**
 * Plugin interface for render-first code generation.
 *
 * Plugins are Effects that access services and return AST statements.
 * Symbol registration happens automatically via Conjure's exp.* methods.
 *
 * Example:
 * ```typescript
 * const typesPlugin: Plugin = {
 *   name: "types",
 *   provides: ["type"],
 *
 *   render: Effect.gen(function* () {
 *     const ir = yield* IR
 *     const cj = yield* Conjure
 *
 *     const statements: n.Statement[] = []
 *     for (const entity of ir.entities.values()) {
 *       if (!isTableEntity(entity)) continue
 *       statements.push(yield* cj.exp.interface(entity.name, [...]))
 *     }
 *     return statements
 *   }),
 * }
 * ```
 */
export interface Plugin {
  /** Plugin name for error messages and debugging */
  readonly name: string;

  /**
   * Capabilities this plugin provides to the system.
   *
   * Can include:
   * - **Category declarations**: e.g., `"queries"`, `"schema"` - declares this plugin
   *   as THE provider for that category. Only one plugin can provide each category.
   *   Consumer plugins use generic prefixes that resolve to the registered provider.
   * - **Specific capabilities**: e.g., `"type:User"` - declares a specific symbol.
   *
   * For category providers, the registry resolves generic capabilities:
   * - `queries:User:findById` → `queries:kysely:User:findById` (if kysely provides "queries")
   * - `schema:UserInsert` → `schema:zod:UserInsert` (if zod provides "schema")
   */
  readonly provides: readonly Capability[];

  /** Capabilities this plugin requires from other plugins */
  readonly consumes?: readonly Capability[];

  /**
   * Capabilities to import during render phase.
   * These will be tracked as cross-references for import generation.
   * Alternative to calling registry.import() in render Effect.
   */
  readonly renderWithImports?: readonly Capability[];

  /**
   * Default file assignment rules for symbols this plugin produces.
   * Users can override these via fileOverrides in their config.
   * First matching rule wins.
   */
  readonly fileDefaults?: readonly FileRule[];

  /**
   * Render phase: Generate AST via Conjure (Effect with RenderServices).
   *
   * Returns AST statements. Symbol registration happens automatically
   * via Conjure's exp.* methods which populate the registry.
   */
  readonly render: Effect.Effect<readonly n.Statement[], RenderPhaseError, RenderServices>;
}

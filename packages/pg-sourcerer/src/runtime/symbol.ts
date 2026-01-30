/**
 * Factory functions for creating RenderedSymbol objects.
 *
 * Provides a clean API for plugin authors to construct symbols without
 * manually managing all fields.
 */
import type { RenderedSymbol } from "./types.js";
import type recast from "recast";
import type { ExternalImport } from "./emit.js";
import type { UserModuleRef } from "../user-module.js";

/**
 * Input for symbol() factory.
 * Provides a simplified interface for creating RenderedSymbol objects.
 */
export interface SymbolInput {
  /** Symbol name */
  readonly name: string;

  /** Capability identifier */
  readonly capability: string;

  /** AST node */
  readonly node: recast.types.ASTNode;

  /**
   * Export behavior override.
   * If not provided, automatically inferred from node type:
   * - ExportNamedDeclaration → "named"
   * - ExportDefaultDeclaration → "default"
   * - Otherwise → false (internal symbol)
   */
  readonly exports?: boolean | "default" | "named";

  /** Plugin-specific metadata for consumers */
  readonly metadata?: unknown;

  /** External imports needed by this symbol */
  readonly imports?: readonly ExternalImport[];

  /** Identifier names referenced in this symbol (for cross-file import tracking) */
  readonly refs?: readonly string[];

  /** User module imports for this symbol */
  readonly userImports?: readonly UserModuleRef[];

  /**
   * @deprecated Use `userImports` instead. Raw code to prepend to the file.
   */
  readonly fileHeader?: string;
}

/**
 * Input for virtualSymbol() factory.
 * Virtual symbols have no AST node - used for metadata/descriptors.
 */
export interface VirtualSymbolInput {
  /** Symbol name */
  readonly name: string;

  /** Capability identifier */
  readonly capability: string;

  /** Plugin-specific metadata for consumers */
  readonly metadata?: unknown;

  /** External imports needed by symbols that consume this virtual symbol */
  readonly imports?: readonly ExternalImport[];

  /** User module imports for symbols that consume this virtual symbol */
  readonly userImports?: readonly UserModuleRef[];

  /**
   * @deprecated Use `userImports` instead.
   */
  readonly fileHeader?: string;
}

/**
 * Infer export behavior from AST node type.
 *
 * Rules:
 * - ExportNamedDeclaration → "named"
 * - ExportDefaultDeclaration → "default"
 * - Otherwise → false (internal symbol)
 */
function inferExports(node: recast.types.ASTNode): "named" | "default" | false {
  if (node.type === "ExportNamedDeclaration") {
    return "named";
  }
  if (node.type === "ExportDefaultDeclaration") {
    return "default";
  }
  return false;
}

/**
 * Create a RenderedSymbol with smart export inference.
 *
 * Export behavior is automatically inferred from the AST node type unless
 * explicitly overridden via `exports` field.
 *
 * @example
 * ```typescript
 * // Automatically inferred as "named" export
 * symbol({
 *   name: "User",
 *   capability: "type:User",
 *   node: b.exportNamedDeclaration(
 *     b.tsInterfaceDeclaration(...)
 *   ),
 * })
 *
 * // Override inference
 * symbol({
 *   name: "helper",
 *   capability: "util:helper",
 *   node: b.functionDeclaration(...),
 *   exports: false,  // Keep internal despite function declaration
 * })
 * ```
 */
export function symbol(input: SymbolInput): RenderedSymbol {
  // Infer export behavior from node type if not explicitly provided
  const inferred = inferExports(input.node);

  const result: RenderedSymbol = {
    name: input.name,
    capability: input.capability,
    node: input.node,
    // precedence: explicit input.exports -> inferred from node type
    // Convert boolean to proper type (true -> "named", false -> false)
    exports: input.exports !== undefined 
      ? (input.exports === true ? "named" : input.exports === false ? false : input.exports)
      : inferred,
    metadata: input.metadata,
    imports: input.imports,
    refs: input.refs,
    userImports: input.userImports,
    fileHeader: input.fileHeader,
  };

  return result;
}

/**
 * Create a virtual symbol (metadata-only, no AST node).
 *
 * Virtual symbols are used for descriptors and contracts that other plugins
 * consume but don't directly emit code. For example, query descriptors that
 * HTTP plugins use to generate endpoints.
 *
 * @example
 * ```typescript
 * virtualSymbol({
 *   name: "findUserById",
 *   capability: "queries:User:findById",
 *   metadata: {
 *     kind: "select-one",
 *     params: [{ name: "id", type: "string" }],
 *     returnType: "User",
 *   },
 * })
 * ```
 */
export function virtualSymbol(input: VirtualSymbolInput): RenderedSymbol {
  return {
    name: input.name,
    capability: input.capability,
    node: null,
    exports: false,
    metadata: input.metadata,
    imports: input.imports,
    userImports: input.userImports,
    fileHeader: input.fileHeader,
  };
}

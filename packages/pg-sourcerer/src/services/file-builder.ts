/**
 * FileBuilder - Fluent API for structured file emission
 *
 * Provides a builder pattern for constructing files with:
 * - Header comments
 * - Import declarations (resolved after all plugins run)
 * - AST program body with symbol metadata extraction
 */
import type { namedTypes as n } from "ast-types"
import type { SymbolMeta, SymbolProgram } from "../lib/conjure.js"
import type { EmissionBuffer } from "./emissions.js"
import type { SymbolRegistry, Symbol } from "./symbols.js"

// =============================================================================
// Import Reference Types
// =============================================================================

/**
 * Reference to a symbol from another file (resolved via SymbolRegistry)
 */
export interface SymbolImportRef {
  readonly kind: "symbol"
  readonly ref: {
    readonly capability: string
    readonly entity: string
    readonly shape?: string
  }
}

/**
 * Import from an external package
 */
export interface PackageImportRef {
  readonly kind: "package"
  readonly names?: readonly string[]
  readonly types?: readonly string[]
  readonly default?: string
  readonly from: string
}

/**
 * Import from a relative path (not tracked in SymbolRegistry)
 */
export interface RelativeImportRef {
  readonly kind: "relative"
  readonly names?: readonly string[]
  readonly types?: readonly string[]
  readonly default?: string
  readonly from: string
}

/**
 * All import reference types
 */
export type ImportRef = SymbolImportRef | PackageImportRef | RelativeImportRef

// =============================================================================
// FileBuilder Interface
// =============================================================================

/**
 * Fluent builder for constructing files with imports, headers, and AST content
 */
export interface FileBuilder {
  /**
   * Add a header comment or statements to the file
   * Can be called multiple times - headers are concatenated
   */
  header(content: string | readonly n.Statement[]): FileBuilder

  /**
   * Request an import (resolved after all plugins run)
   */
  import(ref: ImportRef): FileBuilder

  /**
   * Add AST content to the file
   * Can be called multiple times - bodies are concatenated
   * Extracts symbols from SymbolProgram automatically
   */
  ast(program: n.Program | SymbolProgram): FileBuilder

  /**
   * Add raw string content (mutually exclusive with ast())
   */
  content(text: string): FileBuilder

  /**
   * Finalize and emit the file
   * Registers symbols and queues for serialization
   */
  emit(): void
}

// =============================================================================
// Type Guards
// =============================================================================

function isSymbolProgram(
  prog: n.Program | SymbolProgram
): prog is SymbolProgram {
  return "_tag" in prog && prog._tag === "SymbolProgram"
}

// =============================================================================
// FileBuilder Implementation
// =============================================================================

interface FileBuilderState {
  path: string
  plugin: string
  headers: string[]
  imports: ImportRef[]
  statements: n.Statement[]
  symbols: SymbolMeta[]
  rawContent: string | null
}

/**
 * Create a FileBuilder instance
 */
export function createFileBuilder(
  path: string,
  plugin: string,
  emissions: EmissionBuffer,
  symbolRegistry: SymbolRegistry
): FileBuilder {
  const state: FileBuilderState = {
    path,
    plugin,
    headers: [],
    imports: [],
    statements: [],
    symbols: [],
    rawContent: null,
  }

  const builder: FileBuilder = {
    header(content) {
      if (typeof content === "string") {
        state.headers.push(content)
      } else {
        // Convert statements to string via placeholder
        // For now, just store a marker - actual serialization happens in emit()
        throw new Error(
          "AST headers not yet implemented - use string headers for now"
        )
      }
      return builder
    },

    import(ref) {
      state.imports.push(ref)
      return builder
    },

    ast(program) {
      if (state.rawContent !== null) {
        throw new Error(
          `Cannot mix ast() and content() for file ${state.path}`
        )
      }

      if (isSymbolProgram(program)) {
        // Extract statements and symbols
        state.statements.push(...(program.node.body as n.Statement[]))
        state.symbols.push(...program.symbols)
      } else {
        // Plain n.Program - just extract statements
        state.statements.push(...(program.body as n.Statement[]))
      }
      return builder
    },

    content(text) {
      if (state.statements.length > 0) {
        throw new Error(
          `Cannot mix content() and ast() for file ${state.path}`
        )
      }
      state.rawContent =
        state.rawContent !== null ? state.rawContent + text : text
      return builder
    },

    emit() {
      // Register all symbols with file path
      for (const meta of state.symbols) {
        const baseSymbol = {
          name: meta.name,
          file: state.path,
          capability: meta.capability,
          entity: meta.entity,
          isType: meta.isType,
          isDefault: meta.isDefault ?? false,
        }
        const symbol: Symbol =
          meta.shape !== undefined
            ? { ...baseSymbol, shape: meta.shape }
            : baseSymbol
        symbolRegistry.register(symbol, state.plugin)
      }

      // Build header string
      const headerStr =
        state.headers.length > 0 ? state.headers.join("\n") + "\n" : undefined

      if (state.rawContent !== null) {
        // Raw content mode
        const fullContent = headerStr
          ? headerStr + state.rawContent
          : state.rawContent
        emissions.emit(state.path, fullContent, state.plugin)
      } else {
        // AST mode - create program and emit via emitAst
        // Import resolution will happen in a later pass
        const recast = require("recast")
        const b = recast.types.builders
        const program = b.program(state.statements)

        // Emit AST with imports for resolution during serializeAst
        emissions.emitAst(
          state.path,
          program,
          state.plugin,
          headerStr,
          state.imports.length > 0 ? state.imports : undefined
        )
      }
    },
  }

  return builder
}

// =============================================================================
// FileBuilder Factory
// =============================================================================

/**
 * Factory function type for creating FileBuilders
 */
export type FileBuilderFactory = (path: string) => FileBuilder

/**
 * Create a factory that produces FileBuilders with shared context
 */
export function createFileBuilderFactory(
  plugin: string,
  emissions: EmissionBuffer,
  symbolRegistry: SymbolRegistry
): FileBuilderFactory {
  return (path: string) =>
    createFileBuilder(path, plugin, emissions, symbolRegistry)
}

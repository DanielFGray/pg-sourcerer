/**
 * Import Collector Service
 *
 * Collects import requests during plugin execution for deferred resolution.
 * Plugins request imports without knowing final file locations - resolution
 * happens after all plugins run, using the SymbolRegistry for cross-file imports.
 */
import { Context, Layer } from "effect"
import type { SymbolRef, SymbolRegistry, ImportStatement } from "./symbols.js"

/**
 * Reference to a symbol from the registry (another plugin's output)
 */
export interface SymbolImportRef {
  readonly kind: "symbol"
  readonly ref: SymbolRef
}

/**
 * External package import (npm, etc.) - path used as-is
 */
export interface PackageImportRef {
  readonly kind: "package"
  readonly names?: readonly string[]
  readonly types?: readonly string[]
  readonly default?: string
  readonly from: string
}

/**
 * User-specified relative path import (from TypeHints, etc.)
 * Path is relative to the importing file
 */
export interface RelativeImportRef {
  readonly kind: "relative"
  readonly names?: readonly string[]
  readonly types?: readonly string[]
  readonly default?: string
  readonly from: string
}

/**
 * Union of all import reference types
 */
export type ImportRef = SymbolImportRef | PackageImportRef | RelativeImportRef

/**
 * Import collector interface
 */
export interface ImportCollector {
  /**
   * Request an import for a specific output file.
   *
   * @param forFile - The file that needs this import
   * @param ref - What to import
   */
  readonly request: (forFile: string, ref: ImportRef) => void

  /**
   * Get all import requests for a file.
   *
   * @param forFile - The file to get requests for
   */
  readonly getRequests: (forFile: string) => readonly ImportRef[]

  /**
   * Get all files that have pending import requests.
   */
  readonly getFiles: () => readonly string[]

  /**
   * Resolve all import requests for a file into ImportStatements.
   *
   * @param forFile - The file to resolve imports for
   * @param symbols - SymbolRegistry for resolving symbol refs
   */
  readonly resolve: (forFile: string, symbols: SymbolRegistry) => readonly ImportStatement[]

  /**
   * Clear all import requests (for testing)
   */
  readonly clear: () => void
}

/**
 * ImportCollector service tag
 */
export class Imports extends Context.Tag("Imports")<
  Imports,
  ImportCollector
>() {}

/**
 * Normalize a file path for consistent lookup
 */
function normalizePath(path: string): string {
  return path.replace(/^\.\//, "")
}

/**
 * Create an ImportStatement, only including default if present.
 * This handles exactOptionalPropertyTypes correctly.
 */
function makeImportStatement(
  from: string,
  named: readonly string[],
  types: readonly string[],
  defaultImport: string | undefined
): ImportStatement {
  const base: ImportStatement = { from, named, types }
  if (defaultImport !== undefined) {
    return { ...base, default: defaultImport }
  }
  return base
}

/**
 * Merge import statements that share the same `from` path.
 * Combines named imports and type imports.
 */
function mergeImports(imports: ImportStatement[]): ImportStatement[] {
  const byFrom = new Map<string, ImportStatement>()

  for (const imp of imports) {
    const existing = byFrom.get(imp.from)
    if (existing) {
      // Merge named and types, keeping unique values
      const named = [...new Set([...existing.named, ...imp.named])]
      const types = [...new Set([...existing.types, ...imp.types])]
      const defaultImport = existing.default ?? imp.default

      byFrom.set(imp.from, makeImportStatement(imp.from, named, types, defaultImport))
    } else {
      byFrom.set(imp.from, makeImportStatement(
        imp.from,
        [...imp.named],
        [...imp.types],
        imp.default
      ))
    }
  }

  // Sort by from path for deterministic output
  return [...byFrom.values()].sort((a, b) => a.from.localeCompare(b.from))
}

/**
 * Create a new import collector
 */
export function createImportCollector(): ImportCollector {
  // Map from normalized file path to import requests
  const requests = new Map<string, ImportRef[]>()

  return {
    request: (forFile, ref) => {
      const key = normalizePath(forFile)
      const existing = requests.get(key) ?? []
      existing.push(ref)
      requests.set(key, existing)
    },

    getRequests: (forFile) => {
      const key = normalizePath(forFile)
      return requests.get(key) ?? []
    },

    getFiles: () => [...requests.keys()],

    resolve: (forFile, symbols) => {
      const key = normalizePath(forFile)
      const refs = requests.get(key) ?? []

      const statements: ImportStatement[] = []

      for (const ref of refs) {
        switch (ref.kind) {
          case "symbol": {
            // Resolve via symbol registry
            const symbol = symbols.resolve(ref.ref)
            if (symbol) {
              statements.push(symbols.importFor(symbol, forFile))
            }
            // If symbol not found, skip (could warn in future)
            break
          }

          case "package": {
            // External package - use path as-is
            statements.push(makeImportStatement(
              ref.from,
              ref.names ? [...ref.names] : [],
              ref.types ? [...ref.types] : [],
              ref.default
            ))
            break
          }

          case "relative": {
            // User-specified relative path - use as-is
            // The user is responsible for providing correct relative path
            statements.push(makeImportStatement(
              ref.from,
              ref.names ? [...ref.names] : [],
              ref.types ? [...ref.types] : [],
              ref.default
            ))
            break
          }
        }
      }

      return mergeImports(statements)
    },

    clear: () => {
      requests.clear()
    },
  }
}

/**
 * Live layer - creates fresh import collector per use
 */
export const ImportsLive = Layer.sync(Imports, () => createImportCollector())

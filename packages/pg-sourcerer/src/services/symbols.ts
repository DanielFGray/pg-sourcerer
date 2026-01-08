/**
 * Symbol Registry Service
 *
 * Tracks emitted symbols for cross-file import resolution.
 */
import { Array as Arr, Context, Layer, MutableHashMap, Option, pipe } from "effect"
import type { CapabilityKey } from "../ir/index.js"

/**
 * Reference to a symbol
 */
export interface SymbolRef {
  readonly capability: CapabilityKey
  readonly entity: string
  readonly shape?: string
}

/**
 * A registered symbol
 */
export interface Symbol {
  readonly name: string
  readonly file: string
  readonly capability: CapabilityKey
  readonly entity: string
  readonly shape?: string
  readonly isType: boolean
  readonly isDefault: boolean
}

/**
 * Import statement to add to a file
 */
export interface ImportStatement {
  readonly from: string
  readonly named: readonly string[]
  readonly types: readonly string[]
  readonly default?: string
}

/**
 * Symbol collision info
 */
export interface SymbolCollision {
  readonly symbol: string
  readonly file: string
  readonly plugins: readonly string[]
}

/**
 * Symbol registry interface
 */
export interface SymbolRegistry {
  /**
   * Register a symbol (called by plugins during emit)
   */
  readonly register: (symbol: Symbol, plugin: string) => void

  /**
   * Resolve a reference to a symbol
   */
  readonly resolve: (ref: SymbolRef) => Symbol | undefined

  /**
   * Generate import statement from one file to another
   */
  readonly importFor: (symbol: Symbol, fromFile: string) => ImportStatement

  /**
   * Check for conflicts (same name in same file from different plugins)
   */
  readonly validate: () => readonly SymbolCollision[]

  /**
   * Get all registered symbols
   */
  readonly getAll: () => readonly Symbol[]
}

/**
 * SymbolRegistry service tag
 */
export class Symbols extends Context.Tag("Symbols")<
  Symbols,
  SymbolRegistry
>() {}

/**
 * Create a new symbol registry
 */
export function createSymbolRegistry(): SymbolRegistry {
  const symbols = MutableHashMap.empty<
    string,
    { symbol: Symbol; plugin: string }[]
  >()

  // Key for deduplication: capability:entity:shape
  const makeKey = (ref: SymbolRef): string =>
    `${ref.capability}:${ref.entity}:${ref.shape ?? ""}`

  return {
    register: (symbol, plugin) => {
      const key = makeKey(symbol)
      pipe(
        MutableHashMap.get(symbols, key),
        Option.match({
          onNone: () => MutableHashMap.set(symbols, key, [{ symbol, plugin }]),
          onSome: (existing) => {
            existing.push({ symbol, plugin })
            MutableHashMap.set(symbols, key, existing)
          }
        })
      )
    },

    resolve: (ref) => {
      const key = makeKey(ref)
      return pipe(
        MutableHashMap.get(symbols, key),
        Option.flatMap((entries) => Option.fromNullable(entries[0])),
        Option.map((entry) => entry.symbol),
        Option.getOrUndefined
      )
    },

    importFor: (symbol, fromFile) => {
      // TODO: implement relative path calculation
      const relativePath = calculateRelativePath(fromFile, symbol.file)
      
      if (symbol.isDefault) {
        return {
          from: relativePath,
          named: [],
          types: [],
          default: symbol.name,
        }
      }

      if (symbol.isType) {
        return {
          from: relativePath,
          named: [],
          types: [symbol.name],
        }
      }

      return {
        from: relativePath,
        named: [symbol.name],
        types: [],
      }
    },

    validate: () => {
      // Flatten all entries, group by file+name, find collisions
      const allEntries = pipe(
        MutableHashMap.values(symbols),
        Arr.fromIterable,
        Arr.flatten
      )

      // Group by file:name
      const byFileAndName = pipe(
        allEntries,
        Arr.reduce(
          new Map<string, { symbol: Symbol; plugin: string }[]>(),
          (map, entry) => {
            const key = `${entry.symbol.file}:${entry.symbol.name}`
            const existing = map.get(key) ?? []
            existing.push(entry)
            map.set(key, existing)
            return map
          }
        )
      )

      // Find entries with multiple plugins
      return pipe(
        [...byFileAndName.entries()],
        Arr.filterMap(([key, entries]) => {
          if (entries.length <= 1) return Option.none()
          const [file, symbol] = key.split(":") as [string, string]
          const plugins = [...new Set(entries.map((e) => e.plugin))]
          return plugins.length > 1
            ? Option.some({ symbol, file, plugins } as SymbolCollision)
            : Option.none()
        })
      )
    },

    getAll: () =>
      pipe(
        MutableHashMap.values(symbols),
        Arr.fromIterable,
        Arr.flatMap((entries) => entries.map((e) => e.symbol))
      ),
  }
}

/**
 * Calculate relative import path from one file to another.
 *
 * Both paths are relative to the output directory root.
 * Returns a path with .js extension for ESM compatibility.
 *
 * @example
 * calculateRelativePath("types/User.ts", "schemas/User.ts")
 * // => "../schemas/User.js"
 *
 * calculateRelativePath("types/User.ts", "types/Post.ts")
 * // => "./Post.js"
 */
function calculateRelativePath(fromFile: string, toFile: string): string {
  // Normalize paths - remove leading ./ if present
  const normalizedFrom = fromFile.replace(/^\.\//, "")
  const normalizedTo = toFile.replace(/^\.\//, "")

  // Split into directory parts and filename
  const fromParts = normalizedFrom.split("/")
  const toParts = normalizedTo.split("/")

  // Get the filename from the target (without .ts, add .js)
  const toFilename = toParts.pop() ?? ""
  const toFilenameJs = toFilename.replace(/\.ts$/, ".js")

  // Get the directory of the source file (remove filename)
  fromParts.pop()

  // Find common prefix length
  let commonLength = 0
  const minLength = Math.min(fromParts.length, toParts.length)
  while (commonLength < minLength && fromParts[commonLength] === toParts[commonLength]) {
    commonLength++
  }

  // Calculate how many directories to go up from fromFile
  const upCount = fromParts.length - commonLength

  // Build the relative path
  const upPath = upCount > 0 ? "../".repeat(upCount) : "./"

  // Add remaining directories from toFile
  const remainingDirs = toParts.slice(commonLength)
  const dirPath = remainingDirs.length > 0 ? remainingDirs.join("/") + "/" : ""

  return upPath + dirPath + toFilenameJs
}

/**
 * Live layer - creates fresh symbol registry per use
 */
export const SymbolsLive = Layer.sync(Symbols, () => createSymbolRegistry())

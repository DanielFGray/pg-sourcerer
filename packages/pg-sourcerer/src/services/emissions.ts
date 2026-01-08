/**
 * Emission Buffer Service
 * 
 * Buffers code emissions from plugins before writing to disk.
 * Supports both string content and AST nodes (serialized by the plugin runner).
 * AST emissions to the same file are merged automatically.
 */
import { Array as Arr, Context, Effect, Layer, MutableHashMap, MutableHashSet, Option, pipe } from "effect"
import type { namedTypes as n } from "ast-types"
import type {
  ImportSpecifierKind,
  ImportNamespaceSpecifierKind,
  ImportDefaultSpecifierKind,
  StatementKind,
} from "ast-types/lib/gen/kinds.js"
import { EmitConflict } from "../errors.js"
import type { ImportRef } from "./file-builder.js"
import type { SymbolRegistry } from "./symbols.js"

/**
 * Emission entry - a single file to be written
 */
export interface EmissionEntry {
  readonly path: string
  readonly content: string
  readonly plugin: string
}

/**
 * AST emission entry - buffered until serialization
 */
export interface AstEmissionEntry {
  readonly path: string
  readonly ast: n.Program
  readonly plugin: string
  /** Optional header to prepend (e.g., comments) */
  readonly header?: string
  /** Import requests to resolve during serialization */
  readonly imports?: readonly ImportRef[]
}

/**
 * Emission buffer interface
 */
export interface EmissionBuffer {
  /**
   * Emit string content to a file (buffered)
   */
  readonly emit: (path: string, content: string, plugin: string) => void

  /**
   * Emit an AST program to a file (buffered, serialized later by runner)
   * Multiple emissions to the same path are merged automatically.
   */
  readonly emitAst: (
    path: string,
    ast: n.Program,
    plugin: string,
    header?: string,
    imports?: readonly ImportRef[]
  ) => void

  /**
   * Append to an already-emitted file (same plugin only, string emissions only)
   */
  readonly appendEmit: (path: string, content: string, plugin: string) => void

  /**
   * Get all string emissions
   */
  readonly getAll: () => readonly EmissionEntry[]

  /**
   * Get all AST emissions (for serialization by runner)
   */
  readonly getAstEmissions: () => readonly AstEmissionEntry[]

  /**
   * Serialize all AST emissions to string emissions.
   * Called by the plugin runner after all plugins have run.
   * Resolves imports via the provided SymbolRegistry.
   */
  readonly serializeAst: (
    serialize: (ast: n.Program) => string,
    symbols: SymbolRegistry
  ) => void

  /**
   * Check for conflicts (same path from different plugins for string emissions)
   * Note: AST emissions are merged, not conflicted.
   */
  readonly validate: () => Effect.Effect<void, EmitConflict>

  /**
   * Clear all emissions
   */
  readonly clear: () => void
}

/**
 * EmissionBuffer service tag
 */
export class Emissions extends Context.Tag("Emissions")<
  Emissions,
  EmissionBuffer
>() {}

// =============================================================================
// Import Resolution Helpers
// =============================================================================

import recast from "recast"
const b = recast.types.builders

/**
 * Resolve imports and prepend import statements to AST
 */
function prependImports(
  ast: n.Program,
  imports: readonly ImportRef[],
  forFile: string,
  symbols: SymbolRegistry
): n.Program {
  // Group imports by source path for merging
  const bySource = pipe(
    imports,
    Arr.reduce(
      new Map<string, { named: Set<string>; types: Set<string>; default?: string }>(),
      (map, ref) => {
        const resolved = resolveImportRef(ref, forFile, symbols)
        if (!resolved) return map

        const { source, named, types, defaultImport } = resolved
        const existing = map.get(source) ?? { named: new Set<string>(), types: new Set<string>() }
        named.forEach((n) => existing.named.add(n))
        types.forEach((t) => existing.types.add(t))
        if (defaultImport) existing.default = defaultImport
        map.set(source, existing)
        return map
      }
    )
  )

  // Generate import statements
  type ImportSpecifier = ImportSpecifierKind | ImportNamespaceSpecifierKind | ImportDefaultSpecifierKind
  const statements: StatementKind[] = pipe(
    [...bySource.entries()],
    Arr.flatMap(([source, { named, types, default: defaultImport }]) => {
      const result: StatementKind[] = []

      // Value imports (default + named)
      const valueSpecifiers: ImportSpecifier[] = [
        ...(defaultImport ? [b.importDefaultSpecifier(b.identifier(defaultImport))] : []),
        ...pipe([...named], Arr.map((name) => b.importSpecifier(b.identifier(name), b.identifier(name)))),
      ]
      if (valueSpecifiers.length > 0) {
        result.push(b.importDeclaration(valueSpecifiers, b.stringLiteral(source)))
      }

      // Type imports as a separate type-only import declaration
      if (types.size > 0) {
        const typeSpecifiers: ImportSpecifier[] = pipe(
          [...types],
          Arr.map((name) => b.importSpecifier(b.identifier(name), b.identifier(name)))
        )
        const typeImport = b.importDeclaration(typeSpecifiers, b.stringLiteral(source))
        typeImport.importKind = "type"
        result.push(typeImport)
      }

      return result
    })
  )

  // Prepend imports to program body
  return b.program([...statements, ...ast.body])
}

/** Normalize path for comparison (remove leading ./) */
const normalizePath = (path: string): string => path.replace(/^\.\//, "")

/** Resolve an ImportRef to source/named/types/default */
function resolveImportRef(
  ref: ImportRef,
  forFile: string,
  symbols: SymbolRegistry
): { source: string; named: string[]; types: string[]; defaultImport?: string } | undefined {
  switch (ref.kind) {
    case "symbol": {
      const symbol = symbols.resolve(ref.ref)
      if (!symbol) return undefined
      // Skip import if symbol is in the same file (already declared locally)
      if (normalizePath(symbol.file) === normalizePath(forFile)) return undefined
      const importStmt = symbols.importFor(symbol, forFile)
      const base = {
        source: importStmt.from,
        named: [...importStmt.named],
        types: [...importStmt.types],
      }
      return importStmt.default !== undefined
        ? { ...base, defaultImport: importStmt.default }
        : base
    }
    case "package":
    case "relative": {
      const base = {
        source: ref.from,
        named: ref.names ? [...ref.names] : [],
        types: ref.types ? [...ref.types] : [],
      }
      return ref.default !== undefined
        ? { ...base, defaultImport: ref.default }
        : base
    }
  }
}

// =============================================================================
// AST Emission Merging (Pure Functions)
// =============================================================================

/** Merge two import arrays */
const mergeImports = (
  a?: readonly ImportRef[],
  b?: readonly ImportRef[]
): readonly ImportRef[] => [...(a ?? []), ...(b ?? [])]

/** Merge two plugin attribution strings */
const mergePluginAttribution = (a: string, b: string): string => `${a}, ${b}`

/** Create an AST entry, only including optional fields when defined */
const makeAstEntry = (
  path: string,
  ast: n.Program,
  plugin: string,
  header?: string,
  imports?: readonly ImportRef[]
): AstEmissionEntry =>
  pipe(
    { path, ast, plugin } as AstEmissionEntry,
    (entry) => header !== undefined ? { ...entry, header } : entry,
    (entry) => imports && imports.length > 0 ? { ...entry, imports } : entry
  )

/** Merge a new emission into an existing one (keeps first header) */
const mergeAstEntries = (
  existing: AstEmissionEntry,
  ast: n.Program,
  plugin: string,
  _header?: string,
  imports?: readonly ImportRef[]
): AstEmissionEntry =>
  makeAstEntry(
    existing.path,
    b.program([...existing.ast.body, ...ast.body]),
    mergePluginAttribution(existing.plugin, plugin),
    existing.header,
    mergeImports(existing.imports, imports)
  )

// =============================================================================
// Emission Buffer Implementation
// =============================================================================

/**
 * Create a new emission buffer
 */
export function createEmissionBuffer(): EmissionBuffer {
  const emissions = MutableHashMap.empty<string, EmissionEntry>()
  const astEmissions = MutableHashMap.empty<string, AstEmissionEntry>()
  // Track plugins per path for string emission conflict detection
  const stringEmitPlugins = MutableHashMap.empty<string, MutableHashSet.MutableHashSet<string>>()

  return {
    emit: (path, content, plugin) => {
      // Track plugin for conflict detection
      MutableHashMap.modifyAt(stringEmitPlugins, path, Option.match({
        onNone: () => Option.some(MutableHashSet.make(plugin)),
        onSome: (set) => Option.some(MutableHashSet.add(set, plugin))
      }))
      MutableHashMap.set(emissions, path, { path, content, plugin })
    },

    emitAst: (path, ast, plugin, header, imports) => {
      MutableHashMap.modifyAt(astEmissions, path, Option.match({
        onNone: () => Option.some(makeAstEntry(path, ast, plugin, header, imports)),
        onSome: (existing) => Option.some(mergeAstEntries(existing, ast, plugin, header, imports))
      }))
    },

    appendEmit: (path, content, plugin) => {
      pipe(
        MutableHashMap.get(emissions, path),
        Option.match({
          onNone: () => {
            MutableHashMap.modifyAt(stringEmitPlugins, path, Option.match({
              onNone: () => Option.some(MutableHashSet.make(plugin)),
              onSome: (set) => Option.some(MutableHashSet.add(set, plugin))
            }))
            MutableHashMap.set(emissions, path, { path, content, plugin })
          },
          onSome: (existing) => {
            if (existing.plugin === plugin) {
              MutableHashMap.set(emissions, path, {
                path,
                content: existing.content + content,
                plugin,
              })
            } else {
              // Track conflict for validation
              MutableHashMap.modifyAt(stringEmitPlugins, path, Option.match({
                onNone: () => Option.some(MutableHashSet.make(plugin)),
                onSome: (set) => Option.some(MutableHashSet.add(set, plugin))
              }))
            }
          }
        })
      )
    },

    getAll: () => MutableHashMap.values(emissions),

    getAstEmissions: () => MutableHashMap.values(astEmissions),

    serializeAst: (serialize, symbols) => {
      for (const entry of MutableHashMap.values(astEmissions)) {
        const finalAst = entry.imports && entry.imports.length > 0
          ? prependImports(entry.ast, entry.imports, entry.path, symbols)
          : entry.ast
        
        const code = serialize(finalAst)
        const content = entry.header ? entry.header + code : code
        MutableHashMap.set(emissions, entry.path, { path: entry.path, content, plugin: entry.plugin })
      }
      MutableHashMap.clear(astEmissions)
    },

    validate: () =>
      pipe(
        [...stringEmitPlugins],
        Arr.findFirst(([_, plugins]) => MutableHashSet.size(plugins) > 1),
        Option.match({
          onNone: () => Effect.void,
          onSome: ([path, plugins]) => {
            const pluginList = [...plugins].join(", ")
            return Effect.fail(
              new EmitConflict({
                message: `Multiple plugins emitted to the same file: ${path} (plugins: ${pluginList})`,
                path,
                plugins: [...plugins],
              })
            )
          }
        })
      ),

    clear: () => {
      MutableHashMap.clear(emissions)
      MutableHashMap.clear(astEmissions)
      MutableHashMap.clear(stringEmitPlugins)
    },
  }
}

/**
 * Live layer - creates fresh emission buffer per use
 */
export const EmissionsLive = Layer.sync(Emissions, () => createEmissionBuffer())

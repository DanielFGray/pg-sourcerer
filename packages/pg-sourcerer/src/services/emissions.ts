/**
 * Emission Buffer Service
 * 
 * Buffers code emissions from plugins before writing to disk.
 * Supports both string content and AST nodes (serialized by the plugin runner).
 */
import { Context, Effect, Layer } from "effect"
import type { namedTypes as n } from "ast-types"
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
   * Check for conflicts (same path from different plugins)
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
  const statements: n.Statement[] = []

  // Group imports by source path for merging
  const bySource = new Map<
    string,
    { named: Set<string>; types: Set<string>; default?: string }
  >()

  for (const ref of imports) {
    let source: string
    let named: string[] = []
    let types: string[] = []
    let defaultImport: string | undefined

    switch (ref.kind) {
      case "symbol": {
        const symbol = symbols.resolve(ref.ref)
        if (!symbol) continue // Skip unresolved symbols
        const importStmt = symbols.importFor(symbol, forFile)
        source = importStmt.from
        named = [...importStmt.named]
        types = [...importStmt.types]
        defaultImport = importStmt.default
        break
      }

      case "package":
      case "relative": {
        source = ref.from
        named = ref.names ? [...ref.names] : []
        types = ref.types ? [...ref.types] : []
        defaultImport = ref.default
        break
      }
    }

    // Merge with existing imports from same source
    const existing = bySource.get(source) ?? {
      named: new Set<string>(),
      types: new Set<string>(),
    }
    named.forEach((n) => existing.named.add(n))
    types.forEach((t) => existing.types.add(t))
    if (defaultImport) existing.default = defaultImport
    bySource.set(source, existing)
  }

  // Generate import statements
  for (const [source, { named, types, default: defaultImport }] of bySource) {
    const specifiers: any[] = []

    // Default import
    if (defaultImport) {
      specifiers.push(b.importDefaultSpecifier(b.identifier(defaultImport)))
    }

    // Named imports
    for (const name of named) {
      specifiers.push(
        b.importSpecifier(b.identifier(name), b.identifier(name))
      )
    }

    // Type imports (using type-only import specifiers)
    for (const name of types) {
      const spec: any = b.importSpecifier(b.identifier(name), b.identifier(name))
      spec.importKind = "type"
      specifiers.push(spec)
    }

    if (specifiers.length > 0) {
      statements.push(b.importDeclaration(specifiers, b.stringLiteral(source)))
    }
  }

  // Prepend imports to program body
  return b.program([...statements, ...(ast.body as any[])])
}

/**
 * Create a new emission buffer
 */
export function createEmissionBuffer(): EmissionBuffer {
  const emissions = new Map<string, EmissionEntry>()
  const astEmissions = new Map<string, AstEmissionEntry>()
  // Track all plugins that have written to each path (for conflict detection)
  const pluginsByPath = new Map<string, Set<string>>()

  const trackPlugin = (path: string, plugin: string) => {
    const plugins = pluginsByPath.get(path) ?? new Set()
    plugins.add(plugin)
    pluginsByPath.set(path, plugins)
  }

  return {
    emit: (path, content, plugin) => {
      trackPlugin(path, plugin)
      // Store the emission (last write wins for content)
      emissions.set(path, { path, content, plugin })
    },

    emitAst: (path, ast, plugin, header, imports) => {
      trackPlugin(path, plugin)
      // Store the AST emission (last write wins)
      // Build entry conditionally to handle exactOptionalPropertyTypes
      let entry: AstEmissionEntry = { path, ast, plugin }
      if (header !== undefined) {
        entry = { ...entry, header }
      }
      if (imports !== undefined && imports.length > 0) {
        entry = { ...entry, imports }
      }
      astEmissions.set(path, entry)
    },

    appendEmit: (path, content, plugin) => {
      const existing = emissions.get(path)
      if (!existing) {
        trackPlugin(path, plugin)
        emissions.set(path, { path, content, plugin })
        return
      }
      if (existing.plugin !== plugin) {
        // Track the conflict - different plugin trying to append
        trackPlugin(path, plugin)
        return
      }
      emissions.set(path, {
        path,
        content: existing.content + content,
        plugin,
      })
    },

    getAll: () => [...emissions.values()],

    getAstEmissions: () => [...astEmissions.values()],

    serializeAst: (serialize, symbols) => {
      for (const [path, entry] of astEmissions) {
        // Resolve imports if any
        let finalAst = entry.ast
        if (entry.imports && entry.imports.length > 0) {
          finalAst = prependImports(entry.ast, entry.imports, path, symbols)
        }
        
        const code = serialize(finalAst)
        const content = entry.header ? entry.header + code : code
        emissions.set(path, { path, content, plugin: entry.plugin })
      }
      // Clear AST emissions after serialization
      astEmissions.clear()
    },

    validate: () =>
      Effect.gen(function* () {
        // Check for conflicts using the tracked plugins per path
        for (const [path, plugins] of pluginsByPath) {
          if (plugins.size > 1) {
            yield* Effect.fail(
              new EmitConflict({
                message: `Multiple plugins emitted to the same file: ${path}`,
                path,
                plugins: [...plugins],
              })
            )
          }
        }
      }),

    clear: () => {
      emissions.clear()
      astEmissions.clear()
      pluginsByPath.clear()
    },
  }
}

/**
 * Live layer - creates fresh emission buffer per use
 */
export const EmissionsLive = Layer.sync(Emissions, () => createEmissionBuffer())

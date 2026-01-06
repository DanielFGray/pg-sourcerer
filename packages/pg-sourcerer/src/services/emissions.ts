/**
 * Emission Buffer Service
 * 
 * Buffers code emissions from plugins before writing to disk.
 * Supports both string content and AST nodes (serialized by the plugin runner).
 */
import { Context, Effect, Layer } from "effect"
import type { namedTypes as n } from "ast-types"
import { EmitConflict } from "../errors.js"

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
  /** Optional header to prepend (e.g., imports that can't be in AST) */
  readonly header?: string
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
  readonly emitAst: (path: string, ast: n.Program, plugin: string, header?: string) => void

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
   */
  readonly serializeAst: (serialize: (ast: n.Program) => string) => void

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

    emitAst: (path, ast, plugin, header) => {
      trackPlugin(path, plugin)
      // Store the AST emission (last write wins)
      const entry: AstEmissionEntry = { path, ast, plugin }
      if (header !== undefined) {
        astEmissions.set(path, { ...entry, header })
      } else {
        astEmissions.set(path, entry)
      }
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

    serializeAst: (serialize) => {
      for (const [path, entry] of astEmissions) {
        const code = serialize(entry.ast)
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

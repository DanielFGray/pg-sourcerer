/**
 * Emission Buffer Service
 * 
 * Buffers code emissions from plugins before writing to disk.
 */
import { Context, Effect, Layer } from "effect"
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
 * Emission buffer interface
 */
export interface EmissionBuffer {
  /**
   * Emit code to a file (buffered)
   */
  readonly emit: (path: string, content: string, plugin: string) => void

  /**
   * Append to an already-emitted file (same plugin only)
   */
  readonly appendEmit: (path: string, content: string, plugin: string) => void

  /**
   * Get all emissions
   */
  readonly getAll: () => readonly EmissionEntry[]

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
  // Track all plugins that have written to each path (for conflict detection)
  const pluginsByPath = new Map<string, Set<string>>()

  return {
    emit: (path, content, plugin) => {
      // Track this plugin as having written to this path
      const plugins = pluginsByPath.get(path) ?? new Set()
      plugins.add(plugin)
      pluginsByPath.set(path, plugins)
      
      // Store the emission (last write wins for content)
      emissions.set(path, { path, content, plugin })
    },

    appendEmit: (path, content, plugin) => {
      const existing = emissions.get(path)
      if (!existing) {
        // Track this plugin as having written to this path
        const plugins = pluginsByPath.get(path) ?? new Set()
        plugins.add(plugin)
        pluginsByPath.set(path, plugins)
        
        emissions.set(path, { path, content, plugin })
        return
      }
      if (existing.plugin !== plugin) {
        // Track the conflict - different plugin trying to append
        const plugins = pluginsByPath.get(path) ?? new Set()
        plugins.add(plugin)
        pluginsByPath.set(path, plugins)
        return
      }
      emissions.set(path, {
        path,
        content: existing.content + content,
        plugin,
      })
    },

    getAll: () => [...emissions.values()],

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
      pluginsByPath.clear()
    },
  }
}

/**
 * Live layer - creates fresh emission buffer per use
 */
export const EmissionsLive = Layer.sync(Emissions, () => createEmissionBuffer())

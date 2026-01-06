/**
 * Plugin Meta Service
 *
 * Provides metadata about the currently executing plugin.
 * This is a per-plugin value - a new layer is created for each plugin.
 */
import { Context } from "effect"

/**
 * Plugin metadata interface
 */
export interface PluginMetaInfo {
  /** The plugin's name */
  readonly name: string
}

/**
 * PluginMeta service tag
 *
 * Usage in plugins:
 * ```typescript
 * const meta = yield* PluginMeta
 * console.log(`Running plugin: ${meta.name}`)
 * ```
 *
 * Layer is created per-plugin by PluginRunner:
 * ```typescript
 * const metaLayer = Layer.succeed(PluginMeta, { name: plugin.name })
 * ```
 */
export class PluginMeta extends Context.Tag("PluginMeta")<PluginMeta, PluginMetaInfo>() {}

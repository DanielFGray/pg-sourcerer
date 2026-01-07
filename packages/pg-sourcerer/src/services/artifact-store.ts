/**
 * Artifact Store Service
 *
 * Provides plugin-to-plugin data passing via artifacts.
 * Plugins can store artifacts keyed by capability, and downstream
 * plugins can retrieve them.
 *
 * This service is stateful - created once per run and shared across plugins.
 */
import { Context, Layer, MutableHashMap } from "effect"
import type { Artifact, CapabilityKey } from "../ir/semantic-ir.js"

/**
 * Artifact store interface
 */
export interface ArtifactStoreImpl {
  /**
   * Get an artifact by capability key
   */
  readonly get: (capability: CapabilityKey) => Artifact | undefined

  /**
   * Store an artifact for a capability
   * @param capability - The capability key
   * @param plugin - The plugin name (for attribution)
   * @param data - The artifact data
   */
  readonly set: (capability: CapabilityKey, plugin: string, data: unknown) => void

  /**
   * Get all artifacts as a readonly map
   */
  readonly getAll: () => ReadonlyMap<CapabilityKey, Artifact>
}

/**
 * Create a new artifact store instance.
 * Used by PluginRunner to create a single shared instance per run.
 */
export function createArtifactStore(): ArtifactStoreImpl {
  const artifacts = MutableHashMap.empty<CapabilityKey, Artifact>()

  return {
    get: (capability: CapabilityKey) => {
      const result = MutableHashMap.get(artifacts, capability)
      return result._tag === "Some" ? result.value : undefined
    },

    set: (capability: CapabilityKey, plugin: string, data: unknown) => {
      MutableHashMap.set(artifacts, capability, {
        capability,
        plugin,
        data,
      })
    },

    getAll: () => {
      const result = new Map<CapabilityKey, Artifact>()
      for (const [key, value] of artifacts) {
        result.set(key, value)
      }
      return result as ReadonlyMap<CapabilityKey, Artifact>
    },
  }
}

/**
 * ArtifactStore service tag
 *
 * Usage in plugins:
 * ```typescript
 * const store = yield* ArtifactStore
 * const prev = store.get("types")
 * store.set("schemas", pluginName, myData)
 * ```
 */
export class ArtifactStore extends Context.Tag("ArtifactStore")<
  ArtifactStore,
  ArtifactStoreImpl
>() {}

/**
 * Live layer - creates a fresh artifact store
 */
export const ArtifactStoreLive = Layer.sync(ArtifactStore, createArtifactStore)

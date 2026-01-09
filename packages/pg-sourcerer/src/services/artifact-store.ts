/**
 * Artifact Store Service
 *
 * Provides plugin-to-plugin data passing via artifacts.
 * Plugins can store artifacts keyed by capability, and downstream
 * plugins can retrieve them.
 *
 * This service is stateful - created once per run and shared across plugins.
 */
import { Array as Arr, Context, Layer, MutableHashMap, Option, pipe } from "effect"
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
    get: (capability: CapabilityKey) =>
      Option.getOrUndefined(MutableHashMap.get(artifacts, capability)),

    set: (capability: CapabilityKey, plugin: string, data: unknown) => {
      MutableHashMap.set(artifacts, capability, {
        capability,
        plugin,
        data,
      })
    },

    getAll: () =>
      pipe(
        [...artifacts],
        Arr.reduce(new Map<CapabilityKey, Artifact>(), (map, [key, value]) => {
          map.set(key, value)
          return map
        }),
        (map) => map as ReadonlyMap<CapabilityKey, Artifact>
      ),
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

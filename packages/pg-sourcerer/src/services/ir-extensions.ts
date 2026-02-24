/**
 * IR Extensions Service
 *
 * Provides a generic, mutable extension point for plugins to share data during
 * render phase. The core doesn't know what plugins store here - it just provides
 * the mechanism. Plugins use conventions for keys.
 *
 * Two patterns supported:
 * 1. **Single values** - One value per key (e.g., "schema-builder")
 * 2. **Collections** - Multiple keyed entries (e.g., "entity-queries" → entityName → data)
 *
 * Convention for keys:
 * - Use kebab-case: "schema-builder", "entity-queries"
 * - Prefix with plugin category if ambiguous
 */
import { Context } from "effect";

/**
 * Service interface for IR extensions.
 *
 * Generic key-value store - core doesn't know what's stored.
 * Plugins define their own conventions for keys and types.
 */
export interface IRExtensionsService {
  // ===========================================================================
  // Single-value extensions
  // ===========================================================================

  /**
   * Get a single-value extension.
   * @param key - Extension key (e.g., "schema-builder")
   */
  readonly get: <T = unknown>(key: string) => T | undefined;

  /**
   * Set a single-value extension.
   * @param key - Extension key
   * @param value - The value to store
   */
  readonly set: <T = unknown>(key: string, value: T) => void;

  // ===========================================================================
  // Collection extensions (keyed by a secondary key)
  // ===========================================================================

  /**
   * Get an entry from a collection extension.
   * @param collection - Collection name (e.g., "entity-queries")
   * @param key - Entry key within collection (e.g., entity name)
   */
  readonly getEntry: <T = unknown>(collection: string, key: string) => T | undefined;

  /**
   * Set an entry in a collection extension.
   * @param collection - Collection name
   * @param key - Entry key within collection
   * @param value - The value to store
   */
  readonly setEntry: <T = unknown>(collection: string, key: string, value: T) => void;

  /**
   * Get all entries in a collection.
   * @param collection - Collection name
   */
  readonly getCollection: <T = unknown>(collection: string) => ReadonlyMap<string, T>;
}

/**
 * Effect Context tag for IR extensions service.
 * Plugins access this in render phase via `yield* IRExtensions`.
 */
export class IRExtensions extends Context.Tag("IRExtensions")<
  IRExtensions,
  IRExtensionsService
>() {}

/**
 * Implementation of IR extensions service.
 * Created fresh by orchestrator for each render phase.
 */
export class IRExtensionsImpl implements IRExtensionsService {
  /** Single-value extensions */
  private values = new Map<string, unknown>();

  /** Collection extensions: collection name → (key → value) */
  private collections = new Map<string, Map<string, unknown>>();

  get<T = unknown>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  set<T = unknown>(key: string, value: T): void {
    this.values.set(key, value);
  }

  getEntry<T = unknown>(collection: string, key: string): T | undefined {
    return this.collections.get(collection)?.get(key) as T | undefined;
  }

  setEntry<T = unknown>(collection: string, key: string, value: T): void {
    let col = this.collections.get(collection);
    if (!col) {
      col = new Map();
      this.collections.set(collection, col);
    }
    col.set(key, value);
  }

  getCollection<T = unknown>(collection: string): ReadonlyMap<string, T> {
    return (this.collections.get(collection) as Map<string, T>) ?? new Map<string, T>();
  }

  /**
   * Create a service instance for Effect context.
   */
  toService(): IRExtensionsService {
    return {
      get: <T>(key: string) => this.get<T>(key),
      set: <T>(key: string, value: T) => this.set(key, value),
      getEntry: <T>(collection: string, key: string) => this.getEntry<T>(collection, key),
      setEntry: <T>(collection: string, key: string, value: T) => this.setEntry(collection, key, value),
      getCollection: <T>(collection: string) => this.getCollection<T>(collection),
    };
  }
}

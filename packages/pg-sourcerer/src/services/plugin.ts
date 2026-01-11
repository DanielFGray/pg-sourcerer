/**
 * Plugin System
 *
 * A generic request/plugin coordination system. Core routes requests to plugins
 * without understanding what resources represent (schemas, queries, routes, etc.).
 *
 * Key concepts:
 * - Plugin: Handles requests for a resource kind
 * - Request: A need for a resource with specific params
 * - DeferredResource: A placeholder resolved after plugin execution
 *
 * Execution phases:
 * 1. Registration - Plugins registered, singletons identified
 * 2. Collection - Requests collected via ctx.request()
 * 3. Resolution - Match requests to plugins, build DAG
 * 4. Execution - Run plugins in topological order
 * 5. Finalization - Emit files, resolve imports
 */
import { Context, Data, Layer, MutableHashMap, MutableList, Option, pipe, Schema as S } from "effect"
import type { FileBuilder } from "./file-builder.js"
import type { SymbolRegistry } from "./symbols.js"
import type { SemanticIR } from "../ir/semantic-ir.js"
import type { TypeHintRegistry } from "./type-hints.js"
import type { CoreInflection } from "./inflection.js"

// ============================================================================
// Core Types - Domain Agnostic
// ============================================================================

/**
 * A request for a resource of a specific kind with arbitrary params.
 *
 * Core does not interpret the params - they are opaque data passed to providers.
 */
export interface ResourceRequest {
  /** The resource kind (e.g., "validation-schema", "query-functions") */
  readonly kind: string
  /** Opaque params interpreted by the provider */
  readonly params: unknown
}

/**
 * A service handler function that processes requests for a specific kind.
 *
 * Registered by plugins via ctx.registerHandler() and invoked by ctx.request().
 * This enables on-demand generation where a later plugin can request resources
 * from an earlier plugin's handler.
 *
 * @typeParam TParams - The request params shape
 * @typeParam TResult - The result shape
 */
export type ServiceHandler<TParams = unknown, TResult = unknown> = (
  params: TParams,
  ctx: PluginContext
) => TResult

/**
 * A deferred resource reference.
 *
 * Created when a provider calls ctx.request(). The result is populated
 * after the resolution and execution phases complete.
 */
export interface DeferredResource<T = unknown> {
  /** The resource kind this request is for */
  readonly kind: string
  /** The params used for this request */
  readonly params: unknown
  /**
   * The resolved result. Accessing before resolution throws.
   * After resolution, contains the provider's return value.
   */
  readonly result: T
}

/**
 * Context provided to plugins during the provide() call.
 *
 * Allows plugins to:
 * - Access the semantic IR
 * - Access type hints and inflection
 * - Register service handlers for on-demand requests
 * - Make requests to other plugins' handlers
 * - Emit files
 * - Register symbols
 */
export interface PluginContext {
  /**
   * The semantic IR containing all entities, enums, relations, etc.
   */
  readonly ir: SemanticIR

  /**
   * Type hint registry for user-configured type overrides.
   */
  readonly typeHints: TypeHintRegistry

  /**
   * Inflection service for naming transformations.
   */
  readonly inflection: CoreInflection

  /**
   * Register a service handler for a resource kind.
   *
   * Other plugins can then call ctx.request(kind, params) to invoke this handler.
   * This enables on-demand generation patterns where consumers drive what gets generated.
   *
   * @example
   * ```typescript
   * // In zod plugin:
   * ctx.registerHandler("schemas", (params, ctx) => {
   *   if (params.variant === "params") {
   *     return generateParamSchema(params.entity, params.method)
   *   }
   *   return generateEntitySchema(params.entity, params.shape)
   * })
   *
   * // In http-elysia plugin:
   * const schema = ctx.request("schemas", { entity: "User", method: "findById", variant: "params" })
   * ```
   *
   * @param kind - Resource kind this handler provides
   * @param handler - Function to handle requests
   */
  readonly registerHandler: <TParams = unknown, TResult = unknown>(
    kind: string,
    handler: ServiceHandler<TParams, TResult>
  ) => void

  /**
   * Request a resource from a registered handler.
   *
   * Invokes the handler registered for the given kind with the provided params.
   * If no handler is registered, falls back to the result cache (for static dependencies).
   *
   * @param kind - Resource kind to request
   * @param params - Opaque params for the handler
   * @returns The result from the handler
   * @throws If no handler is registered and no cached result exists
   */
  readonly request: <T = unknown>(kind: string, params: unknown) => T

  /**
   * Create a FileBuilder for structured file emission.
   *
   * @param path - Output file path relative to outputDir
   */
  readonly file: (path: string) => FileBuilder

  /**
   * Symbol registry for cross-file imports.
   * Also used for method symbol registration (plugin-to-plugin coordination).
   */
  readonly symbols: SymbolRegistry
}

/**
 * A plugin handles requests for a specific resource kind.
 *
 * Core calls canProvide() to match requests to plugins, then calls
 * provide() to generate the resource.
 *
 * @typeParam TParams - The expected params shape (opaque to core)
 * @typeParam TResult - The result shape (opaque to core)
 */
export interface Plugin<TParams = unknown, TResult = unknown> {
  /**
   * Unique plugin name for identification and error messages.
   */
  readonly name: string

  /**
   * The resource kind this plugin handles.
   * Multiple plugins can handle the same kind - first match wins.
   */
  readonly kind: string

  /**
   * If true, this plugin runs once automatically without explicit request.
   * The result is shared by all dependents.
   *
   * Typical singletons: introspection, semantic-ir
   */
  readonly singleton?: boolean

  /**
   * Params to use for singleton execution.
   * Only meaningful when singleton is true.
   */
  readonly singletonParams?: TParams

  /**
   * Check if this plugin can handle a request with the given params.
   *
   * Called during resolution to match requests to plugins.
   * First plugin that returns true wins.
   *
   * @param params - The request params (opaque to core)
   * @returns true if this plugin can handle the request
   */
  readonly canProvide: (params: TParams) => boolean

  /**
   * Declare what resources this plugin needs before it can run.
   *
   * Used to build the dependency DAG. The results are passed to provide().
   *
   * @param params - The request params
   * @returns Array of resource requests that must be resolved first
   */
  readonly requires?: (params: TParams) => readonly ResourceRequest[]

  /**
   * Declare optional dependencies that enhance this plugin if available.
   *
   * Unlike `requires`, missing optional dependencies don't cause errors.
   * If a provider exists, the dependency is resolved and ordering is enforced.
   * If no provider exists, the dependency is silently skipped.
   *
   * Useful for plugins that have fallback behavior when an optional dependency
   * isn't available (e.g., http-elysia falling back to TypeBox when no schema
   * plugin is registered).
   *
   * @param params - The request params
   * @returns Array of optional resource requests
   */
  readonly optionalRequires?: (params: TParams) => readonly ResourceRequest[]

  /**
   * Generate the resource.
   *
   * Called during execution phase after all dependencies are resolved.
   *
   * @param params - The request params
   * @param deps - Resolved results from requires() in same order
   * @param ctx - Plugin context for sub-requests and emission
   * @returns The resource result (shape is plugin-defined)
   */
  readonly provide: (params: TParams, deps: readonly unknown[], ctx: PluginContext) => TResult
}

// ============================================================================
// Plugin Errors - Domain Agnostic
// ============================================================================

/**
 * No plugin could handle a request.
 */
export class PluginNotFound extends Data.TaggedError("PluginNotFound")<{
  readonly message: string
  readonly kind: string
  readonly params: unknown
  readonly requestedBy?: string
}> {}

/**
 * A cycle was detected in plugin dependencies.
 */
export class PluginCycle extends Data.TaggedError("PluginCycle")<{
  readonly message: string
  readonly cycle: readonly string[]
}> {}

/**
 * A plugin failed during execution.
 */
export class PluginExecutionFailed extends Data.TaggedError("PluginExecutionFailed")<{
  readonly message: string
  readonly plugin: string
  readonly kind: string
  readonly params: unknown
  readonly cause: unknown
}> {}

/**
 * Attempted to access a deferred resource before resolution.
 */
export class ResourceNotResolved extends Data.TaggedError("ResourceNotResolved")<{
  readonly message: string
  readonly kind: string
  readonly params: unknown
}> {}

/**
 * Union of all plugin-related errors.
 */
export type PluginError =
  | PluginNotFound
  | PluginCycle
  | PluginExecutionFailed
  | ResourceNotResolved

// ============================================================================
// Internal Types for Registry/Resolution
// ============================================================================

/**
 * A pending request tracked by the registry.
 * @internal
 */
export interface PendingRequest {
  readonly kind: string
  readonly params: unknown
  readonly requestedBy: string
  readonly deferred: MutableDeferredResource
}

/**
 * A mutable deferred resource used during resolution.
 * @internal
 */
export interface MutableDeferredResource<T = unknown> {
  readonly kind: string
  readonly params: unknown
  resolved: boolean
  value: T | undefined
}

/**
 * Create a mutable deferred resource.
 * @internal
 */
export const createDeferredResource = <T = unknown>(
  kind: string,
  params: unknown
): MutableDeferredResource<T> => ({
  kind,
  params,
  resolved: false,
  value: undefined,
})

/**
 * Create a read-only deferred resource view.
 * Throws if accessed before resolution.
 * @internal
 */
export const asDeferredResource = <T>(mutable: MutableDeferredResource<T>): DeferredResource<T> => ({
  kind: mutable.kind,
  params: mutable.params,
  get result(): T {
    if (!mutable.resolved) {
      throw new ResourceNotResolved({
        message: `Resource "${mutable.kind}" has not been resolved yet`,
        kind: mutable.kind,
        params: mutable.params,
      })
    }
    return mutable.value as T
  },
})

// ============================================================================
// Service Registry - On-demand request handling
// ============================================================================

/**
 * Registry for service handlers.
 *
 * Plugins register handlers during their provide() call.
 * Other plugins can then invoke these handlers via ctx.request().
 */
export interface ServiceRegistry {
  /**
   * Register a handler for a resource kind.
   * Multiple handlers can be registered for the same kind - they're tried in order.
   *
   * @param kind - Resource kind this handler provides
   * @param handler - Function to handle requests
   * @param pluginName - Name of the plugin registering (for error messages)
   */
  readonly register: (kind: string, handler: ServiceHandler, pluginName: string) => void

  /**
   * Invoke a handler for the given kind and params.
   *
   * @param kind - Resource kind to request
   * @param params - Opaque params for the handler
   * @param ctx - Plugin context to pass to handler
   * @returns The handler result, or undefined if no handler matched
   */
  readonly invoke: <T = unknown>(kind: string, params: unknown, ctx: PluginContext) => T | undefined

  /**
   * Check if any handler is registered for a kind.
   */
  readonly hasHandler: (kind: string) => boolean
}

/**
 * Create a service registry for handler registration and invocation.
 */
export const createServiceRegistry = (): ServiceRegistry => {
  const handlers = MutableHashMap.empty<string, MutableList.MutableList<{ handler: ServiceHandler; plugin: string }>>()

  return {
    register: (kind, handler, pluginName) => {
      pipe(
        MutableHashMap.get(handlers, kind),
        Option.match({
          onNone: () => {
            MutableHashMap.set(handlers, kind, MutableList.make({ handler, plugin: pluginName }))
          },
          onSome: (list) => {
            MutableList.append(list, { handler, plugin: pluginName })
          },
        })
      )
    },

    invoke: <T>(kind: string, params: unknown, ctx: PluginContext): T | undefined => {
      return pipe(
        MutableHashMap.get(handlers, kind),
        Option.flatMap((list) => {
          // Try each handler until one returns a result
          for (const { handler } of list) {
            try {
              const result = handler(params, ctx)
              if (result !== undefined) {
                return Option.some(result as T)
              }
            } catch {
              // Handler threw - try next one
              continue
            }
          }
          return Option.none()
        }),
        Option.getOrUndefined
      )
    },

    hasHandler: (kind) => MutableHashMap.has(handlers, kind),
  }
}

/**
 * Effect service tag for ServiceRegistry.
 */
export class Services extends Context.Tag("Services")<Services, ServiceRegistry>() {}

// ============================================================================
// Service Tag for DI
// ============================================================================

/**
 * Plugin registry service interface.
 *
 * Manages plugin registration and request collection during execution.
 */
export interface PluginRegistry {
  /**
   * Register a plugin for a resource kind.
   *
   * @param plugin - The plugin to register
   */
  readonly register: (plugin: Plugin) => void

  /**
   * Request a resource. Returns a deferred reference.
   *
   * The deferred is populated after resolution and execution phases.
   *
   * @param kind - Resource kind to request
   * @param params - Opaque params for the plugin
   * @param requestedBy - Name of the requester (for error messages)
   * @returns A deferred resource reference
   */
  readonly request: <T = unknown>(kind: string, params: unknown, requestedBy: string) => DeferredResource<T>

  /**
   * Get all registered plugins.
   * @internal Used by resolution phase.
   */
  readonly getPlugins: () => readonly Plugin[]

  /**
   * Get all pending requests.
   * @internal Used by resolution phase.
   */
  readonly getPendingRequests: () => readonly PendingRequest[]

  /**
   * Get singleton plugins.
   * @internal Used by resolution phase to create implicit requests.
   */
  readonly getSingletons: () => readonly Plugin[]
}

/**
 * Effect service tag for PluginRegistry.
 */
export class Plugins extends Context.Tag("Plugins")<Plugins, PluginRegistry>() {}

// ============================================================================
// Schema for Serialization (if needed)
// ============================================================================

/**
 * Schema for ResourceRequest (for artifact serialization if needed).
 */
export const ResourceRequestSchema = S.Struct({
  kind: S.String,
  params: S.Unknown,
})

// ============================================================================
// Helper: definePlugin
// ============================================================================

/**
 * Define a plugin with type inference.
 *
 * @example
 * ```typescript
 * const zodSchemas = definePlugin({
 *   name: "zod-schemas",
 *   kind: "validation-schema",
 *   canProvide: (p) => !p.format || p.format === "zod",
 *   requires: () => [{ kind: "semantic-ir", params: {} }],
 *   provide: (params, [ir], ctx) => {
 *     // Generate schema, return symbol ref
 *   },
 * })
 * ```
 */
export function definePlugin<TParams = unknown, TResult = unknown>(
  plugin: Plugin<TParams, TResult>
): Plugin<TParams, TResult> {
  return plugin
}

// ============================================================================
// Plugin Registry Implementation
// ============================================================================

/**
 * Create a plugin registry for collecting plugins and requests.
 *
 * Used during generation to:
 * 1. Collect plugin registrations
 * 2. Collect requests during plugin execution
 * 3. Provide data to resolution phase
 */
export const createPluginRegistry = (): PluginRegistry => {
  const pluginsByKind = MutableHashMap.empty<string, MutableList.MutableList<Plugin>>()
  const allPlugins = MutableList.empty<Plugin>()
  const pendingRequests = MutableList.empty<PendingRequest>()

  return {
    register: (plugin) => {
      MutableList.append(allPlugins, plugin)

      pipe(
        MutableHashMap.get(pluginsByKind, plugin.kind),
        Option.match({
          onNone: () => {
            MutableHashMap.set(pluginsByKind, plugin.kind, MutableList.make(plugin))
          },
          onSome: (list) => {
            MutableList.append(list, plugin)
          },
        })
      )
    },

    request: <T>(kind: string, params: unknown, requestedBy: string) => {
      const mutable = createDeferredResource<T>(kind, params)
      MutableList.append(pendingRequests, {
        kind,
        params,
        requestedBy,
        deferred: mutable,
      })
      return asDeferredResource(mutable)
    },

    getPlugins: () => Array.from(allPlugins),

    getPendingRequests: () => Array.from(pendingRequests),

    getSingletons: () =>
      pipe(
        Array.from(allPlugins),
        (plugins) => plugins.filter((p) => p.singleton === true)
      ),
  }
}

/**
 * Layer providing a fresh plugin registry.
 */
export const PluginsLive = Layer.sync(Plugins, createPluginRegistry)

/**
 * Execution Phase
 *
 * Executes providers in topological order, populating deferred resources.
 */
import { Data, Effect, HashMap, Option, pipe } from "effect"
import type { FileBuilder } from "./file-builder.js"
import type { SymbolRegistry } from "./symbols.js"
import type { SemanticIR } from "../ir/semantic-ir.js"
import type { TypeHintRegistry } from "./type-hints.js"
import type { CoreInflection } from "./inflection.js"
import type { ServiceRegistry } from "./service-registry.js"
import {
  type MutableDeferredResource,
  type PendingRequest,
  type PluginContext,
  type PluginRegistry,
  type ServiceHandler,
  PluginExecutionFailed,
  PluginNotFound,
} from "./plugin.js"
import { type ExecutionPlan, type ResolvedRequest } from "./resolution.js"

// ============================================================================
// Types
// ============================================================================

/**
 * Result cache key: (kind, paramsJson)
 */
interface ResultKey {
  readonly kind: string
  readonly paramsJson: string
}

const makeResultKey = (kind: string, params: unknown): ResultKey =>
  Data.struct({
    kind,
    paramsJson: JSON.stringify(params ?? {}),
  })

/**
 * Services needed for execution.
 */
export interface ExecutionServices {
  readonly fileBuilder: (path: string) => FileBuilder
  readonly symbols: SymbolRegistry
  readonly ir: SemanticIR
  readonly typeHints: TypeHintRegistry
  readonly inflection: CoreInflection
  readonly serviceRegistry: ServiceRegistry
}

// ============================================================================
// Execution
// ============================================================================

/**
 * Execute a single provider step.
 */
const executeStep = (
  step: ResolvedRequest,
  resultCache: HashMap.HashMap<ResultKey, unknown>,
  services: ExecutionServices
): Effect.Effect<unknown, PluginExecutionFailed> => {
  // Gather dependency results
  const depResults = step.dependencies.map((dep) => {
    const key = makeResultKey(dep.kind, dep.params)
    return pipe(
      HashMap.get(resultCache, key),
      Option.getOrThrow // Dependencies should already be resolved
    )
  })

  // Build provider context
  const ctx: PluginContext = {
    ir: services.ir,
    typeHints: services.typeHints,
    inflection: services.inflection,
    registerHandler: <TParams, TResult>(kind: string, handler: ServiceHandler<TParams, TResult>) => {
      // Store handler in the service registry
      // We wrap it to make it callable via services.get()
      services.serviceRegistry.register(kind, handler)
    },
    request: <T>(kind: string, params: unknown): T => {
      // First check if there's a registered handler
      const handler = services.serviceRegistry.get<ServiceHandler<unknown, T>>(kind)
      if (handler) {
        return handler(params, ctx)
      }
      // Fall back to static result cache
      const key = makeResultKey(kind, params)
      return pipe(
        HashMap.get(resultCache, key),
        Option.getOrThrow
      ) as T
    },
    file: services.fileBuilder,
    symbols: services.symbols,
  }

  // Execute the plugin
  return Effect.try({
    try: () => step.provider.provide(step.params, depResults, ctx),
    catch: (cause) =>
      new PluginExecutionFailed({
        message: `Plugin "${step.provider.name}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        plugin: step.provider.name,
        kind: step.kind,
        params: step.params,
        cause,
      }),
  })
}

/**
 * Populate deferred resources from the result cache.
 */
const populateDeferreds = (
  pendingRequests: readonly PendingRequest[],
  resultCache: HashMap.HashMap<ResultKey, unknown>
): void => {
  for (const req of pendingRequests) {
    const key = makeResultKey(req.kind, req.params)
    const result = pipe(
      HashMap.get(resultCache, key),
      Option.getOrUndefined
    )

    if (result !== undefined) {
      const mutable = req.deferred as MutableDeferredResource
      mutable.resolved = true
      mutable.value = result
    }
  }
}

/**
 * Execute all providers in the execution plan.
 *
 * @param plan - Topologically sorted execution plan from resolution phase
 * @param registry - Provider registry with pending requests
 * @param services - File builder and symbol registry
 * @returns Effect that completes when all providers have executed
 */
export const execute = (
  plan: ExecutionPlan,
  registry: PluginRegistry,
  services: ExecutionServices
): Effect.Effect<void, PluginExecutionFailed> =>
  Effect.reduce(
    plan.steps,
    HashMap.empty<ResultKey, unknown>(),
    (cache, step) =>
      executeStep(step, cache, services).pipe(
        Effect.map((result) => {
          const key = makeResultKey(step.kind, step.params)
          return HashMap.set(cache, key, result)
        })
      )
  ).pipe(
    Effect.tap((cache) =>
      Effect.sync(() => populateDeferreds(registry.getPendingRequests(), cache))
    ),
    Effect.asVoid
  )

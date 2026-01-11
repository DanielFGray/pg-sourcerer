/**
 * Resolution Phase
 *
 * Matches requests to providers, expands dependencies, builds DAG,
 * detects cycles, and produces an execution plan.
 */
import { Array as Arr, Data, Effect, HashMap, Option, pipe } from "effect"
import {
  type PluginRegistry,
  type Plugin,
  type ResourceRequest,
  PluginCycle,
  PluginNotFound,
} from "./plugin.js"

// ============================================================================
// Types
// ============================================================================

/**
 * A resolved request: a request matched to a provider.
 */
export interface ResolvedRequest {
  readonly kind: string
  readonly params: unknown
  readonly provider: Plugin
  /** Required dependencies (from provider.requires) - always resolved */
  readonly dependencies: readonly ResourceRequest[]
  /** Optional dependencies that were successfully resolved (from provider.optionalRequires) */
  readonly optionalDependencies: readonly ResourceRequest[]
}

/**
 * Execution plan: topologically sorted list of resolved requests.
 */
export interface ExecutionPlan {
  readonly steps: readonly ResolvedRequest[]
}

/**
 * Key for deduplicating requests: (kind, paramsJson)
 * Uses Data.struct for proper value-based equality in HashMap.
 */
interface RequestKey {
  readonly kind: string
  readonly paramsJson: string
}

const makeKey = (kind: string, params: unknown): RequestKey =>
  Data.struct({
    kind,
    paramsJson: JSON.stringify(params ?? {}),
  })

// ============================================================================
// Resolution
// ============================================================================

/**
 * Find the first provider that can handle a request.
 * Returns Option.none() if no provider found.
 */
const findProviderOptional = (
  providers: readonly Plugin[],
  kind: string,
  params: unknown,
): Option.Option<Plugin> => {
  const byKind = providers.filter((p) => p.kind === kind)
  return Arr.findFirst(byKind, (p) => p.canProvide(params))
}

/**
 * Find the first provider that can handle a request.
 * Fails with PluginNotFound if none found.
 */
const findProvider = (
  providers: readonly Plugin[],
  kind: string,
  params: unknown,
  requestedBy: string
): Effect.Effect<Plugin, PluginNotFound> =>
  pipe(
    findProviderOptional(providers, kind, params),
    Option.match({
      onNone: () =>
        Effect.fail(
          new PluginNotFound({
            message: `No provider found for "${kind}"`,
            kind,
            params,
            requestedBy,
          })
        ),
      onSome: Effect.succeed,
    })
  )

/**
 * Resolve a single request: match to provider, get required dependencies.
 * Optional dependencies are handled separately in collectAndResolve.
 */
const resolveRequest = (
  providers: readonly Plugin[],
  kind: string,
  params: unknown,
  requestedBy: string
): Effect.Effect<ResolvedRequest, PluginNotFound> =>
  findProvider(providers, kind, params, requestedBy).pipe(
    Effect.map((provider) => ({
      kind,
      params,
      provider,
      dependencies: provider.requires?.(params) ?? [],
      optionalDependencies: [], // Filled in later by collectAndResolve
    }))
  )

/**
 * Collect all requests (including transitive dependencies) and resolve them.
 *
 * Returns a map of RequestKey → ResolvedRequest.
 */
const collectAndResolve = (
  registry: PluginRegistry
): Effect.Effect<HashMap.HashMap<RequestKey, ResolvedRequest>, PluginNotFound> => {
  const providers = registry.getPlugins()
  const pendingRequests = registry.getPendingRequests()
  const singletons = registry.getSingletons()

  // Initial requests: pending + singletons
  const initialRequests: readonly ResourceRequest[] = [
    ...pendingRequests.map((p) => ({ kind: p.kind, params: p.params })),
    ...singletons.map((s) => ({ kind: s.kind, params: s.singletonParams ?? {} })),
  ]

  // Track optional dependencies that were resolved for each request
  // Key: request key string, Value: array of resolved optional deps
  const resolvedOptionalDeps = new Map<string, ResourceRequest[]>()

  const keyToString = (k: RequestKey): string => `${k.kind}:${k.paramsJson}`

  // BFS to collect all requests
  const processQueue = (
    queue: readonly { req: ResourceRequest; requestedBy: string; isOptional: boolean }[],
    resolved: HashMap.HashMap<RequestKey, ResolvedRequest>
  ): Effect.Effect<HashMap.HashMap<RequestKey, ResolvedRequest>, PluginNotFound> => {
    if (queue.length === 0) {
      // Post-process: update resolved requests with their optional dependencies
      return Effect.succeed(
        HashMap.map(resolved, (req) => {
          const key = makeKey(req.kind, req.params)
          const optDeps = resolvedOptionalDeps.get(keyToString(key)) ?? []
          return { ...req, optionalDependencies: optDeps }
        })
      )
    }

    const [current, ...rest] = queue
    if (!current) return Effect.succeed(resolved)

    const key = makeKey(current.req.kind, current.req.params)

    // Skip if already resolved
    if (HashMap.has(resolved, key)) {
      return processQueue(rest, resolved)
    }

    // For optional requests, check if provider exists first
    if (current.isOptional) {
      const maybeProvider = findProviderOptional(providers, current.req.kind, current.req.params)
      if (Option.isNone(maybeProvider)) {
        // No provider for optional dep - skip silently
        return processQueue(rest, resolved)
      }
    }

    return resolveRequest(providers, current.req.kind, current.req.params, current.requestedBy).pipe(
      Effect.flatMap((resolvedReq) => {
        const newResolved = HashMap.set(resolved, key, resolvedReq)

        // Add required dependencies to queue
        const requiredItems = resolvedReq.dependencies.map((dep) => ({
          req: dep,
          requestedBy: resolvedReq.provider.name,
          isOptional: false,
        }))

        // Process optional dependencies
        const optionalReqs = resolvedReq.provider.optionalRequires?.(resolvedReq.params) ?? []
        const optionalItems: { req: ResourceRequest; requestedBy: string; isOptional: boolean }[] = []

        for (const optReq of optionalReqs) {
          // Check if provider exists for this optional dep
          const maybeProvider = findProviderOptional(providers, optReq.kind, optReq.params)
          if (Option.isSome(maybeProvider)) {
            // Provider exists - add to queue and track as optional dependency
            optionalItems.push({
              req: optReq,
              requestedBy: resolvedReq.provider.name,
              isOptional: true,
            })
            // Track that this was an optional dep of the current request
            const currentKeyStr = keyToString(key)
            const existing = resolvedOptionalDeps.get(currentKeyStr) ?? []
            existing.push(optReq)
            resolvedOptionalDeps.set(currentKeyStr, existing)
          }
          // If no provider, silently skip - that's the point of optional deps
        }

        return processQueue([...rest, ...requiredItems, ...optionalItems], newResolved)
      })
    )
  }

  const initialQueue = initialRequests.map((req) => ({
    req,
    requestedBy: "initial",
    isOptional: false,
  }))

  return processQueue(initialQueue, HashMap.empty())
}

/**
 * Build adjacency list for the dependency graph.
 * Node: RequestKey, Edges: dependencies (both required and optional, as keys)
 */
const buildAdjacencyList = (
  resolved: HashMap.HashMap<RequestKey, ResolvedRequest>
): HashMap.HashMap<RequestKey, readonly RequestKey[]> =>
  HashMap.map(resolved, (req) => {
    const requiredKeys = req.dependencies.map((dep) => makeKey(dep.kind, dep.params))
    const optionalKeys = req.optionalDependencies.map((dep) => makeKey(dep.kind, dep.params))
    return [...requiredKeys, ...optionalKeys]
  })

/**
 * Detect cycles using DFS with color marking.
 * WHITE = unvisited, GRAY = in progress, BLACK = done
 *
 * Uses string keys for the color map since Data.struct creates new instances.
 */
const detectCycles = (
  adjacency: HashMap.HashMap<RequestKey, readonly RequestKey[]>
): Effect.Effect<void, PluginCycle> => {
  type Color = "white" | "gray" | "black"

  // Use string serialization for Map keys since Data.struct instances are different objects
  const keyToString = (k: RequestKey): string => `${k.kind}:${k.paramsJson}`

  const nodes = HashMap.keys(adjacency)

  const dfs = (
    node: RequestKey,
    colors: Map<string, Color>,
    path: readonly RequestKey[]
  ): Effect.Effect<Map<string, Color>, PluginCycle> => {
    const nodeStr = keyToString(node)
    const color = colors.get(nodeStr) ?? "white"

    if (color === "gray") {
      // Cycle detected - find where in path this node appears
      const pathStrs = path.map(keyToString)
      const cycleStart = pathStrs.indexOf(nodeStr)
      const cyclePath = cycleStart >= 0 ? path.slice(cycleStart) : path
      const cycle = [...cyclePath, node].map((k) => {
        const params = JSON.parse(k.paramsJson)
        return Object.keys(params).length > 0 ? `${k.kind}(${k.paramsJson})` : k.kind
      })
      return Effect.fail(
        new PluginCycle({
          message: `Dependency cycle detected: ${cycle.join(" → ")}`,
          cycle,
        })
      )
    }

    if (color === "black") {
      return Effect.succeed(colors)
    }

    colors.set(nodeStr, "gray")

    const neighbors = pipe(
      HashMap.get(adjacency, node),
      Option.getOrElse(() => [] as readonly RequestKey[])
    )

    return Effect.reduce(neighbors, colors, (cols, neighbor) =>
      dfs(neighbor, cols, [...path, node])
    ).pipe(
      Effect.map((cols) => {
        cols.set(nodeStr, "black")
        return cols
      })
    )
  }

  return Effect.reduce(nodes, new Map<string, Color>(), (colors, node) =>
    dfs(node, colors, [])
  ).pipe(Effect.asVoid)
}

/**
 * Topological sort using Kahn's algorithm.
 */
const topologicalSort = (
  resolved: HashMap.HashMap<RequestKey, ResolvedRequest>,
  adjacency: HashMap.HashMap<RequestKey, readonly RequestKey[]>
): readonly ResolvedRequest[] => {
  const keyToString = (k: RequestKey): string => `${k.kind}:${k.paramsJson}`

  // Build in-degree map (how many things depend on each node)
  const inDegree = new Map<string, number>()
  const keysByString = new Map<string, RequestKey>()

  for (const key of HashMap.keys(adjacency)) {
    const keyStr = keyToString(key)
    keysByString.set(keyStr, key)
    if (!inDegree.has(keyStr)) inDegree.set(keyStr, 0)
  }

  for (const deps of HashMap.values(adjacency)) {
    for (const dep of deps) {
      const depStr = keyToString(dep)
      inDegree.set(depStr, (inDegree.get(depStr) ?? 0) + 1)
    }
  }

  // Start with nodes that have no dependencies on them (in-degree = 0)
  const queue: string[] = []
  for (const [keyStr, degree] of inDegree) {
    if (degree === 0) queue.push(keyStr)
  }

  const result: ResolvedRequest[] = []

  while (queue.length > 0) {
    const nodeStr = queue.shift()!
    const node = keysByString.get(nodeStr)!
    const resolvedReq = pipe(
      HashMap.get(resolved, node),
      Option.getOrThrow
    )
    result.push(resolvedReq)

    const deps = pipe(
      HashMap.get(adjacency, node),
      Option.getOrElse(() => [] as readonly RequestKey[])
    )

    for (const dep of deps) {
      const depStr = keyToString(dep)
      const newDegree = (inDegree.get(depStr) ?? 1) - 1
      inDegree.set(depStr, newDegree)
      if (newDegree === 0) queue.push(depStr)
    }
  }

  // Reverse: dependencies should come first
  return result.reverse()
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Resolve all requests and produce an execution plan.
 *
 * Steps:
 * 1. Collect all requests (pending + singletons + transitive dependencies)
 * 2. Match each request to a provider
 * 3. Build dependency DAG
 * 4. Detect cycles
 * 5. Topologically sort
 */
export const resolve = (
  registry: PluginRegistry
): Effect.Effect<ExecutionPlan, PluginNotFound | PluginCycle> =>
  collectAndResolve(registry).pipe(
    Effect.flatMap((resolved) => {
      const adjacency = buildAdjacencyList(resolved)
      return detectCycles(adjacency).pipe(
        Effect.map(() => ({
          steps: topologicalSort(resolved, adjacency),
        }))
      )
    })
  )

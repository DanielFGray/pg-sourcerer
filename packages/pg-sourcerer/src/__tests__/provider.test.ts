/**
 * Provider System Tests
 *
 * Tests for provider types, deferred resources, and basic type safety.
 */
import { describe, it, expect } from "@effect/vitest"
import {
  definePlugin,
  createDeferredResource,
  asDeferredResource,
  ResourceNotResolved,
  createPluginRegistry,
  type Plugin,
  type ResourceRequest,
  type DeferredResource,
} from "../services/plugin.js"

describe("Provider Types", () => {
  describe("definePlugin", () => {
    it("creates a provider with all required fields", () => {
      const provider = definePlugin({
        name: "test-provider",
        kind: "test-resource",
        canProvide: () => true,
        provide: () => ({ value: 42 }),
      })

      expect(provider.name).toBe("test-provider")
      expect(provider.kind).toBe("test-resource")
      expect(provider.canProvide({})).toBe(true)
      expect(provider.provide({}, [], {} as never)).toEqual({ value: 42 })
    })

    it("supports singleton providers", () => {
      const provider = definePlugin({
        name: "singleton-provider",
        kind: "singleton-resource",
        singleton: true,
        singletonParams: { config: "value" },
        canProvide: () => true,
        provide: () => "singleton-result",
      })

      expect(provider.singleton).toBe(true)
      expect(provider.singletonParams).toEqual({ config: "value" })
    })

    it("supports requires function", () => {
      const provider = definePlugin({
        name: "dependent-provider",
        kind: "dependent-resource",
        canProvide: () => true,
        requires: (params: { entity: string }) => [
          { kind: "semantic-ir", params: {} },
          { kind: "other-resource", params: { id: params.entity } },
        ],
        provide: (params, deps) => ({ deps: deps.length }),
      })

      const reqs = provider.requires?.({ entity: "User" })
      expect(reqs).toHaveLength(2)
      expect(reqs?.[0]).toEqual({ kind: "semantic-ir", params: {} })
      expect(reqs?.[1]).toEqual({ kind: "other-resource", params: { id: "User" } })
    })

    it("infers param types from canProvide", () => {
      interface MyParams {
        format: "zod" | "arktype"
        entity: string
      }

      interface MyResult {
        symbol: { name: string; path: string }
      }

      const provider = definePlugin<MyParams, MyResult>({
        name: "typed-provider",
        kind: "validation-schema",
        canProvide: (p) => p.format === "zod",
        provide: (params, _deps, _ctx) => ({
          symbol: { name: `${params.entity}Schema`, path: `schemas/${params.entity}.ts` },
        }),
      })

      // Type checking: canProvide receives MyParams
      expect(provider.canProvide({ format: "zod", entity: "User" })).toBe(true)
      expect(provider.canProvide({ format: "arktype", entity: "User" })).toBe(false)

      // Type checking: provide returns MyResult
      const result = provider.provide({ format: "zod", entity: "User" }, [], {} as never)
      expect(result.symbol.name).toBe("UserSchema")
    })
  })

  describe("DeferredResource", () => {
    it("creates a mutable deferred resource", () => {
      const mutable = createDeferredResource("test-kind", { id: 123 })

      expect(mutable.kind).toBe("test-kind")
      expect(mutable.params).toEqual({ id: 123 })
      expect(mutable.resolved).toBe(false)
      expect(mutable.value).toBeUndefined()
    })

    it("throws when accessing unresolved deferred", () => {
      const mutable = createDeferredResource("test-kind", {})
      const deferred = asDeferredResource(mutable)

      expect(() => deferred.result).toThrow(ResourceNotResolved)
    })

    it("returns value after resolution", () => {
      const mutable = createDeferredResource<string>("test-kind", {})
      const deferred = asDeferredResource(mutable)

      // Simulate resolution
      mutable.resolved = true
      mutable.value = "resolved-value"

      expect(deferred.result).toBe("resolved-value")
    })

    it("preserves kind and params on deferred view", () => {
      const mutable = createDeferredResource("my-kind", { x: 1, y: 2 })
      const deferred = asDeferredResource(mutable)

      expect(deferred.kind).toBe("my-kind")
      expect(deferred.params).toEqual({ x: 1, y: 2 })
    })
  })

  describe("ResourceRequest", () => {
    it("is a simple structure with kind and params", () => {
      const request: ResourceRequest = {
        kind: "validation-schema",
        params: { entity: "User", shape: "insert" },
      }

      expect(request.kind).toBe("validation-schema")
      expect(request.params).toEqual({ entity: "User", shape: "insert" })
    })
  })
})

describe("Provider Patterns", () => {
  it("demonstrates a schema provider pattern", () => {
    // This test shows how a schema provider would be structured
    // without any domain-specific knowledge in the type system

    interface SchemaParams {
      entity: string
      shape: "row" | "insert" | "update"
      options?: { coercion?: boolean }
    }

    interface SchemaResult {
      symbol: { name: string; path: string }
    }

    const zodProvider = definePlugin<SchemaParams, SchemaResult>({
      name: "zod-schemas",
      kind: "validation-schema",

      canProvide: (params) => {
        // Could check for format if params had it
        return true
      },

      requires: () => [{ kind: "semantic-ir", params: {} }],

      provide: (params, deps, _ctx) => {
        // deps[0] would be the SemanticIR
        const _ir = deps[0]
        return {
          symbol: {
            name: `${params.entity}${capitalize(params.shape)}`,
            path: `schemas/${params.entity}.ts`,
          },
        }
      },
    })

    // Verify the provider can be used
    expect(zodProvider.canProvide({ entity: "User", shape: "insert" })).toBe(true)

    const result = zodProvider.provide(
      { entity: "User", shape: "insert", options: { coercion: true } },
      [{ entities: new Map() }], // Mock IR
      {} as never
    )

    expect(result.symbol.name).toBe("UserInsert")
    expect(result.symbol.path).toBe("schemas/User.ts")
  })

  it("demonstrates an adapter provider pattern", () => {
    // Adapter providers transform output from one provider to another format

    interface TypeBoxResult {
      typeboxSchema: unknown
    }

    const typeboxAdapter = definePlugin<{ entity: string }, TypeBoxResult>({
      name: "typebox-from-zod",
      kind: "validation-schema-typebox",

      canProvide: () => true,

      // Adapter depends on zod output
      requires: (params) => [
        { kind: "validation-schema", params: { ...params, format: "zod" } },
      ],

      provide: (_params, deps, _ctx) => {
        const zodResult = deps[0] as { symbol: { name: string } }
        return {
          // Would transform zod to typebox
          typeboxSchema: { converted: true, from: zodResult.symbol.name },
        }
      },
    })

    expect(typeboxAdapter.requires?.({ entity: "User" })).toEqual([
      { kind: "validation-schema", params: { entity: "User", format: "zod" } },
    ])
  })

  it("demonstrates a singleton provider pattern", () => {
    // Singleton providers run once, result shared by all dependents

    interface IRResult {
      entities: Map<string, { name: string }>
    }

    const irProvider = definePlugin<Record<string, never>, IRResult>({
      name: "ir-builder",
      kind: "semantic-ir",
      singleton: true,
      singletonParams: {},

      canProvide: () => true,

      requires: () => [{ kind: "introspection", params: {} }],

      provide: (_params, deps, _ctx) => {
        const _introspection = deps[0]
        return {
          entities: new Map([["User", { name: "User" }]]),
        }
      },
    })

    expect(irProvider.singleton).toBe(true)
    expect(irProvider.singletonParams).toEqual({})
  })
})

describe("PluginRegistry", () => {
  describe("createPluginRegistry", () => {
    it("starts with empty state", () => {
      const registry = createPluginRegistry()

      expect(registry.getPlugins()).toEqual([])
      expect(registry.getPendingRequests()).toEqual([])
      expect(registry.getSingletons()).toEqual([])
    })

    it("registers providers and retrieves them", () => {
      const registry = createPluginRegistry()

      const provider1 = definePlugin({
        name: "provider-1",
        kind: "schema",
        canProvide: () => true,
        provide: () => "result-1",
      })

      const provider2 = definePlugin({
        name: "provider-2",
        kind: "query",
        canProvide: () => true,
        provide: () => "result-2",
      })

      registry.register(provider1)
      registry.register(provider2)

      const providers = registry.getPlugins()
      expect(providers).toHaveLength(2)
      expect(providers[0]!.name).toBe("provider-1")
      expect(providers[1]!.name).toBe("provider-2")
    })

    it("groups providers by kind", () => {
      const registry = createPluginRegistry()

      const zod = definePlugin({
        name: "zod-schemas",
        kind: "validation-schema",
        canProvide: () => true,
        provide: () => "zod",
      })

      const arktype = definePlugin({
        name: "arktype-schemas",
        kind: "validation-schema",
        canProvide: () => true,
        provide: () => "arktype",
      })

      const queries = definePlugin({
        name: "sql-queries",
        kind: "query-functions",
        canProvide: () => true,
        provide: () => "queries",
      })

      registry.register(zod)
      registry.register(arktype)
      registry.register(queries)

      const providers = registry.getPlugins()
      expect(providers).toHaveLength(3)
    })

    it("collects requests with deferred resources", () => {
      const registry = createPluginRegistry()

      const deferred1 = registry.request<string>("schema", { entity: "User" }, "http-routes")
      const deferred2 = registry.request<number>("query", { table: "users" }, "api-generator")

      const requests = registry.getPendingRequests()
      expect(requests).toHaveLength(2)

      expect(requests[0]!.kind).toBe("schema")
      expect(requests[0]!.params).toEqual({ entity: "User" })
      expect(requests[0]!.requestedBy).toBe("http-routes")

      expect(requests[1]!.kind).toBe("query")
      expect(requests[1]!.params).toEqual({ table: "users" })
      expect(requests[1]!.requestedBy).toBe("api-generator")

      // Deferred should throw before resolution
      expect(() => deferred1.result).toThrow(ResourceNotResolved)
      expect(() => deferred2.result).toThrow(ResourceNotResolved)
    })

    it("deferred resources work after resolution", () => {
      const registry = createPluginRegistry()

      registry.request<string>("schema", {}, "test")

      const requests = registry.getPendingRequests()
      const mutable = requests[0]!.deferred

      // Simulate resolution
      mutable.resolved = true
      mutable.value = "resolved-value"

      // Now deferred should return value
      expect(requests[0]!.deferred.value).toBe("resolved-value")
    })

    it("identifies singleton providers", () => {
      const registry = createPluginRegistry()

      const singleton: Plugin = {
        name: "ir-builder",
        kind: "semantic-ir",
        singleton: true,
        singletonParams: {},
        canProvide: () => true,
        provide: () => ({ entities: new Map() }),
      }

      const regular: Plugin = {
        name: "zod-schemas",
        kind: "validation-schema",
        canProvide: () => true,
        provide: () => "schema",
      }

      registry.register(singleton)
      registry.register(regular)

      const singletons = registry.getSingletons()
      expect(singletons).toHaveLength(1)
      expect(singletons[0]!.name).toBe("ir-builder")
    })
  })
})

// Helper
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

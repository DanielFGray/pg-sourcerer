/**
 * Execution Phase Tests
 */
import { describe, it, expect } from "@effect/vitest"
import { Effect } from "effect"
import { execute, type ExecutionServices } from "../services/execution.js"
import { resolve } from "../services/resolution.js"
import {
  createPluginRegistry,
  type Plugin,
} from "../services/plugin.js"
import { createServiceRegistry } from "../services/service-registry.js"

// Stub services for testing
const createStubServices = (): ExecutionServices => ({
  fileBuilder: () => ({} as never),
  symbols: {} as never,
  ir: {} as never,
  typeHints: {} as never,
  inflection: {} as never,
  serviceRegistry: createServiceRegistry(),
})

describe("Execution Phase", () => {
  describe("basic execution", () => {
    it.effect("executes a single provider and populates deferred", () =>
      Effect.gen(function* () {
        const registry = createPluginRegistry()

        const provider: Plugin = {
          name: "simple-provider",
          kind: "simple",
          canProvide: () => true,
          provide: (_params, _deps, _ctx) => "result-value",
        }

        registry.register(provider)
        const deferred = registry.request<string>("simple", { id: 1 }, "test")

        const plan = yield* resolve(registry)
        yield* execute(plan, registry, createStubServices())

        expect(deferred.result).toBe("result-value")
      })
    )

    it.effect("passes params to provider", () =>
      Effect.gen(function* () {
        const registry = createPluginRegistry()

        const provider: Plugin = {
          name: "param-echo",
          kind: "echo",
          canProvide: () => true,
          provide: (params) => `echo: ${(params as { value: string }).value}`,
        }

        registry.register(provider)
        const deferred = registry.request<string>("echo", { value: "hello" }, "test")

        const plan = yield* resolve(registry)
        yield* execute(plan, registry, createStubServices())

        expect(deferred.result).toBe("echo: hello")
      })
    )
  })

  describe("dependency injection", () => {
    it.effect("injects resolved dependencies into provider", () =>
      Effect.gen(function* () {
        const registry = createPluginRegistry()

        const depProvider: Plugin = {
          name: "dep-provider",
          kind: "dependency",
          canProvide: () => true,
          provide: () => ({ data: 42 }),
        }

        const mainProvider: Plugin = {
          name: "main-provider",
          kind: "main",
          canProvide: () => true,
          requires: () => [{ kind: "dependency", params: {} }],
          provide: (_params, deps) => {
            const dep = deps[0] as { data: number }
            return `received: ${dep.data}`
          },
        }

        registry.register(depProvider)
        registry.register(mainProvider)
        const deferred = registry.request<string>("main", {}, "test")

        const plan = yield* resolve(registry)
        yield* execute(plan, registry, createStubServices())

        expect(deferred.result).toBe("received: 42")
      })
    )

    it.effect("handles diamond dependencies correctly", () =>
      Effect.gen(function* () {
        const registry = createPluginRegistry()
        const calls: string[] = []

        const providerD: Plugin = {
          name: "provider-d",
          kind: "d",
          canProvide: () => true,
          provide: () => {
            calls.push("d")
            return "D"
          },
        }

        const providerB: Plugin = {
          name: "provider-b",
          kind: "b",
          canProvide: () => true,
          requires: () => [{ kind: "d", params: {} }],
          provide: (_p, deps) => {
            calls.push("b")
            return `B(${deps[0]})`
          },
        }

        const providerC: Plugin = {
          name: "provider-c",
          kind: "c",
          canProvide: () => true,
          requires: () => [{ kind: "d", params: {} }],
          provide: (_p, deps) => {
            calls.push("c")
            return `C(${deps[0]})`
          },
        }

        const providerA: Plugin = {
          name: "provider-a",
          kind: "a",
          canProvide: () => true,
          requires: () => [
            { kind: "b", params: {} },
            { kind: "c", params: {} },
          ],
          provide: (_p, deps) => {
            calls.push("a")
            return `A(${deps[0]}, ${deps[1]})`
          },
        }

        registry.register(providerA)
        registry.register(providerB)
        registry.register(providerC)
        registry.register(providerD)
        const deferred = registry.request<string>("a", {}, "test")

        const plan = yield* resolve(registry)
        yield* execute(plan, registry, createStubServices())

        // D should only be executed once
        expect(calls.filter((c) => c === "d")).toHaveLength(1)
        // A should have both B and C results
        expect(deferred.result).toBe("A(B(D), C(D))")
      })
    )
  })

  describe("context usage", () => {
    it.effect("allows sub-requests via ctx.request", () =>
      Effect.gen(function* () {
        const registry = createPluginRegistry()

        const depProvider: Plugin = {
          name: "schema-provider",
          kind: "schema",
          canProvide: () => true,
          provide: (params) => `Schema<${(params as { entity: string }).entity}>`,
        }

        const adapterProvider: Plugin = {
          name: "adapter",
          kind: "adapted-schema",
          canProvide: () => true,
          requires: (params) => [
            { kind: "schema", params: { entity: (params as { entity: string }).entity } },
          ],
          provide: (params, deps, ctx) => {
            // Can also use ctx.request for lookup
            const schema = ctx.request<string>("schema", { entity: (params as { entity: string }).entity })
            return `Adapted(${schema})`
          },
        }

        registry.register(depProvider)
        registry.register(adapterProvider)
        const deferred = registry.request<string>("adapted-schema", { entity: "User" }, "test")

        const plan = yield* resolve(registry)
        yield* execute(plan, registry, createStubServices())

        expect(deferred.result).toBe("Adapted(Schema<User>)")
      })
    )
  })

  describe("error handling", () => {
    it.effect("wraps provider exceptions in PluginExecutionFailed", () =>
      Effect.gen(function* () {
        const registry = createPluginRegistry()

        const failingProvider: Plugin = {
          name: "failing-provider",
          kind: "fail",
          canProvide: () => true,
          provide: () => {
            throw new Error("Provider error")
          },
        }

        registry.register(failingProvider)
        registry.request("fail", {}, "test")

        const plan = yield* resolve(registry)
        const result = yield* execute(plan, registry, createStubServices()).pipe(Effect.exit)

        expect(result._tag).toBe("Failure")
      })
    )
  })

  describe("singleton execution", () => {
    it.effect("executes singletons automatically", () =>
      Effect.gen(function* () {
        const registry = createPluginRegistry()
        let singletonCalls = 0

        const singleton: Plugin = {
          name: "ir-singleton",
          kind: "semantic-ir",
          singleton: true,
          singletonParams: {},
          canProvide: () => true,
          provide: () => {
            singletonCalls++
            return { entities: new Map() }
          },
        }

        const consumer: Plugin = {
          name: "schema-consumer",
          kind: "schema",
          canProvide: () => true,
          requires: () => [{ kind: "semantic-ir", params: {} }],
          provide: (_p, deps) => {
            const ir = deps[0] as { entities: Map<unknown, unknown> }
            return `entities: ${ir.entities.size}`
          },
        }

        registry.register(singleton)
        registry.register(consumer)
        const deferred = registry.request<string>("schema", {}, "test")

        const plan = yield* resolve(registry)
        yield* execute(plan, registry, createStubServices())

        expect(singletonCalls).toBe(1)
        expect(deferred.result).toBe("entities: 0")
      })
    )
  })
})

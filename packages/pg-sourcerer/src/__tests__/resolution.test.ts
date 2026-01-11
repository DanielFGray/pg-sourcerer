/**
 * Resolution Phase Tests
 */
import { describe, it, expect } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { resolve, type ExecutionPlan } from "../services/resolution.js"
import {
  createPluginRegistry,
  PluginCycle,
  PluginNotFound,
  type Plugin,
} from "../services/plugin.js"

describe("Resolution Phase", () => {
  describe("basic resolution", () => {
    it.effect("resolves a single request with no dependencies", () =>
      Effect.gen(function* () {
        const registry = createPluginRegistry()

        const provider: Plugin = {
          name: "simple-provider",
          kind: "simple",
          canProvide: () => true,
          provide: () => "result",
        }

        registry.register(provider)
        registry.request("simple", { id: 1 }, "test")

        const plan = yield* resolve(registry)

        expect(plan.steps).toHaveLength(1)
        expect(plan.steps[0]!.kind).toBe("simple")
        expect(plan.steps[0]!.provider.name).toBe("simple-provider")
      })
    )

    it.effect("resolves singleton providers automatically", () =>
      Effect.gen(function* () {
        const registry = createPluginRegistry()

        const singleton: Plugin = {
          name: "ir-builder",
          kind: "semantic-ir",
          singleton: true,
          singletonParams: {},
          canProvide: () => true,
          provide: () => ({ entities: new Map() }),
        }

        registry.register(singleton)
        // No explicit request needed for singleton

        const plan = yield* resolve(registry)

        expect(plan.steps).toHaveLength(1)
        expect(plan.steps[0]!.provider.name).toBe("ir-builder")
      })
    )

    it.effect("deduplicates identical requests", () =>
      Effect.gen(function* () {
        const registry = createPluginRegistry()

        const provider: Plugin = {
          name: "schema-provider",
          kind: "schema",
          canProvide: () => true,
          provide: () => "schema",
        }

        registry.register(provider)

        // Same kind + params = should dedupe
        registry.request("schema", { entity: "User" }, "requester-1")
        registry.request("schema", { entity: "User" }, "requester-2")

        const plan = yield* resolve(registry)

        expect(plan.steps).toHaveLength(1)
      })
    )

    it.effect("keeps different params as separate requests", () =>
      Effect.gen(function* () {
        const registry = createPluginRegistry()

        const provider: Plugin = {
          name: "schema-provider",
          kind: "schema",
          canProvide: () => true,
          provide: () => "schema",
        }

        registry.register(provider)

        registry.request("schema", { entity: "User" }, "test")
        registry.request("schema", { entity: "Post" }, "test")

        const plan = yield* resolve(registry)

        expect(plan.steps).toHaveLength(2)
      })
    )
  })

  describe("dependency resolution", () => {
    it.effect("resolves transitive dependencies", () =>
      Effect.gen(function* () {
        const registry = createPluginRegistry()

        const irProvider: Plugin = {
          name: "ir-builder",
          kind: "semantic-ir",
          canProvide: () => true,
          provide: () => ({ entities: new Map() }),
        }

        const schemaProvider: Plugin = {
          name: "zod-schemas",
          kind: "validation-schema",
          canProvide: () => true,
          requires: () => [{ kind: "semantic-ir", params: {} }],
          provide: () => "schema",
        }

        registry.register(irProvider)
        registry.register(schemaProvider)
        registry.request("validation-schema", { entity: "User" }, "test")

        const plan = yield* resolve(registry)

        expect(plan.steps).toHaveLength(2)
        // Dependencies should come first
        expect(plan.steps[0]!.kind).toBe("semantic-ir")
        expect(plan.steps[1]!.kind).toBe("validation-schema")
      })
    )

    it.effect("resolves diamond dependencies correctly", () =>
      Effect.gen(function* () {
        const registry = createPluginRegistry()

        // A depends on B and C, both B and C depend on D
        const providerD: Plugin = {
          name: "provider-d",
          kind: "d",
          canProvide: () => true,
          provide: () => "d",
        }

        const providerB: Plugin = {
          name: "provider-b",
          kind: "b",
          canProvide: () => true,
          requires: () => [{ kind: "d", params: {} }],
          provide: () => "b",
        }

        const providerC: Plugin = {
          name: "provider-c",
          kind: "c",
          canProvide: () => true,
          requires: () => [{ kind: "d", params: {} }],
          provide: () => "c",
        }

        const providerA: Plugin = {
          name: "provider-a",
          kind: "a",
          canProvide: () => true,
          requires: () => [
            { kind: "b", params: {} },
            { kind: "c", params: {} },
          ],
          provide: () => "a",
        }

        registry.register(providerA)
        registry.register(providerB)
        registry.register(providerC)
        registry.register(providerD)
        registry.request("a", {}, "test")

        const plan = yield* resolve(registry)

        // D should come first (dependency of B and C)
        expect(plan.steps).toHaveLength(4)
        expect(plan.steps[0]!.kind).toBe("d")

        // A should come last
        const lastStep = plan.steps[plan.steps.length - 1]!
        expect(lastStep.kind).toBe("a")
      })
    )
  })

  describe("provider matching", () => {
    it.effect("selects first matching provider", () =>
      Effect.gen(function* () {
        const registry = createPluginRegistry()

        const zodProvider: Plugin = {
          name: "zod-schemas",
          kind: "validation-schema",
          canProvide: (p: unknown) => (p as { format?: string }).format !== "arktype",
          provide: () => "zod",
        }

        const arktypeProvider: Plugin = {
          name: "arktype-schemas",
          kind: "validation-schema",
          canProvide: (p: unknown) => (p as { format?: string }).format === "arktype",
          provide: () => "arktype",
        }

        registry.register(zodProvider)
        registry.register(arktypeProvider)
        registry.request("validation-schema", { format: "zod" }, "test")

        const plan = yield* resolve(registry)

        expect(plan.steps[0]!.provider.name).toBe("zod-schemas")
      })
    )

    it.effect("fails when no provider matches", () =>
      Effect.gen(function* () {
        const registry = createPluginRegistry()

        const provider: Plugin = {
          name: "limited-provider",
          kind: "schema",
          canProvide: (p: unknown) => (p as { type?: string }).type === "special",
          provide: () => "result",
        }

        registry.register(provider)
        registry.request("schema", { type: "normal" }, "test")

        const result = yield* resolve(registry).pipe(Effect.exit)

        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          const error = result.cause
          expect(error._tag).toBe("Fail")
        }
      })
    )

    it.effect("fails when kind has no providers", () =>
      Effect.gen(function* () {
        const registry = createPluginRegistry()

        registry.request("nonexistent", {}, "test")

        const result = yield* resolve(registry).pipe(Effect.exit)

        expect(Exit.isFailure(result)).toBe(true)
      })
    )
  })

  describe("cycle detection", () => {
    it.effect("detects direct cycles", () =>
      Effect.gen(function* () {
        const registry = createPluginRegistry()

        // A depends on B, B depends on A
        const providerA: Plugin = {
          name: "provider-a",
          kind: "a",
          canProvide: () => true,
          requires: () => [{ kind: "b", params: {} }],
          provide: () => "a",
        }

        const providerB: Plugin = {
          name: "provider-b",
          kind: "b",
          canProvide: () => true,
          requires: () => [{ kind: "a", params: {} }],
          provide: () => "b",
        }

        registry.register(providerA)
        registry.register(providerB)
        registry.request("a", {}, "test")

        const result = yield* resolve(registry).pipe(Effect.exit)

        expect(Exit.isFailure(result)).toBe(true)
      })
    )

    it.effect("detects transitive cycles", () =>
      Effect.gen(function* () {
        const registry = createPluginRegistry()

        // A → B → C → A
        const providerA: Plugin = {
          name: "provider-a",
          kind: "a",
          canProvide: () => true,
          requires: () => [{ kind: "b", params: {} }],
          provide: () => "a",
        }

        const providerB: Plugin = {
          name: "provider-b",
          kind: "b",
          canProvide: () => true,
          requires: () => [{ kind: "c", params: {} }],
          provide: () => "b",
        }

        const providerC: Plugin = {
          name: "provider-c",
          kind: "c",
          canProvide: () => true,
          requires: () => [{ kind: "a", params: {} }],
          provide: () => "c",
        }

        registry.register(providerA)
        registry.register(providerB)
        registry.register(providerC)
        registry.request("a", {}, "test")

        const result = yield* resolve(registry).pipe(Effect.exit)

        expect(Exit.isFailure(result)).toBe(true)
      })
    )
  })
})

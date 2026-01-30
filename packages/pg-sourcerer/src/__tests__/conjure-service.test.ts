/**
 * Tests for Conjure Effect Service
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect, FiberRef } from "effect";
import {
  Conjure,
  makeConjureService,
  CurrentPluginContext,
  type ConjureRegistry,
  type PluginContext,
  type SymbolHandle,
} from "../services/conjure.js";
import { conjure } from "../conjure/index.js";

// Mock registry for testing
class MockRegistry implements ConjureRegistry {
  public rendered = new Map<string, { node: unknown; metadata?: unknown }>();
  public handles = new Map<string, SymbolHandle>();

  setRendered(capability: string, node: unknown, metadata?: unknown): void {
    this.rendered.set(capability, { node, metadata });
  }

  import(capability: string): SymbolHandle {
    const existing = this.handles.get(capability);
    if (existing) return existing;

    const handle: SymbolHandle = {
      name: capability.split(":").pop() || capability,
      capability,
    };
    this.handles.set(capability, handle);
    return handle;
  }
}

describe("Conjure Service", () => {
  it.effect("exp.const registers symbol and returns statement", () =>
    Effect.gen(function* () {
      const registry = new MockRegistry();
      const service = makeConjureService(registry);

      const ctx: PluginContext = {
        pluginName: "zod",
        provides: ["schema"],
      };

      yield* FiberRef.set(CurrentPluginContext, ctx);

      const stmt = yield* service.exp.const(
        "User",
        conjure.id("z").method("string").build(),
        {
          imports: [{ from: "zod", names: ["z"] }],
        },
      );

      // Should return a statement
      expect(stmt.type).toBe("ExportNamedDeclaration");

      // Should register with inferred capability
      const rendered = registry.rendered.get("schema:zod:User");
      expect(rendered).toBeDefined();
      expect(rendered?.node).toBe(stmt);
    }),
  );

  it.effect("exp.type infers capability from context", () =>
    Effect.gen(function* () {
      const registry = new MockRegistry();
      const service = makeConjureService(registry);

      const ctx: PluginContext = {
        pluginName: "kysely",
        provides: ["type"],
      };

      yield* FiberRef.set(CurrentPluginContext, ctx);

      yield* service.exp.type("User", conjure.ts.ref("UserRow"));

      // Should infer "type:kysely:User"
      expect(registry.rendered.has("type:kysely:User")).toBe(true);
    }),
  );

  it.effect("exp.const stores consume callback in metadata", () =>
    Effect.gen(function* () {
      const registry = new MockRegistry();
      const service = makeConjureService(registry);

      const ctx: PluginContext = {
        pluginName: "zod",
        provides: ["schema"],
      };

      yield* FiberRef.set(CurrentPluginContext, ctx);

      const consumeFn = (input: unknown) =>
        conjure.id("User").method("parse", [input as any]).build();

      yield* service.exp.const("User", conjure.id("z").method("string").build(), {
        consume: consumeFn,
      });

      const rendered = registry.rendered.get("schema:zod:User");
      expect(rendered?.metadata).toBeDefined();
      expect(typeof (rendered?.metadata as any)?.consume).toBe("function");
    }),
  );

  it.effect("use() returns handle from registry", () =>
    Effect.gen(function* () {
      const registry = new MockRegistry();
      const service = makeConjureService(registry);

      const handle = yield* service.use("schema:User");

      expect(handle.name).toBe("User");
      expect(handle.capability).toBe("schema:User");
    }),
  );

  it.effect("pure AST builders work without context", () =>
    Effect.gen(function* () {
      const registry = new MockRegistry();
      const service = makeConjureService(registry);

      // Pure builders don't need context
      const id = service.id("foo").build();
      expect(id.type).toBe("Identifier");
      expect((id as any).name).toBe("foo");

      const obj = service.obj().prop("x", service.num(1)).build();
      expect(obj.type).toBe("ObjectExpression");
    }),
  );

  it.effect("exp.const with explicit capability overrides inference", () =>
    Effect.gen(function* () {
      const registry = new MockRegistry();
      const service = makeConjureService(registry);

      const ctx: PluginContext = {
        pluginName: "zod",
        provides: ["schema"],
      };

      yield* FiberRef.set(CurrentPluginContext, ctx);

      yield* service.exp.const("UserInput", conjure.id("z").method("object").build(), {
        capability: "schema:zod:User:input",
      });

      // Should use explicit capability, not inferred
      expect(registry.rendered.has("schema:zod:User:input")).toBe(true);
      expect(registry.rendered.has("schema:zod:UserInput")).toBe(false);
    }),
  );

  it.effect("throws when no context for capability inference", () =>
    Effect.gen(function* () {
      const registry = new MockRegistry();
      const service = makeConjureService(registry);

      // No context set
      yield* FiberRef.set(CurrentPluginContext, null);

      // Should fail with error about missing context
      const result = yield* Effect.exit(
        service.exp.const("User", conjure.id("z").method("string").build()),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        const message = String(result.cause);
        expect(message).toContain("no plugin context");
      }
    }),
  );
});

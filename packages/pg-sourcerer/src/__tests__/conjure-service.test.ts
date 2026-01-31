/**
 * Tests for Conjure Effect Service
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect, FiberRef } from "effect";
import {
  Conjure,
  makeConjureService,
  CurrentPluginContext,
  type PluginContext,
} from "../services/conjure.js";
import { SymbolRegistryImpl } from "../runtime/registry.js";
import { conjure } from "../conjure/index.js";

describe("Conjure Service", () => {
  it.effect("exp.const registers symbol that can be imported", () =>
    Effect.gen(function* () {
      const registry = new SymbolRegistryImpl();
      const service = makeConjureService({
        register: (decl) => registry.register(decl),
        setRendered: (cap, node, meta) => registry.setRendered(cap, node, meta),
        import: (cap) => registry.import(cap),
      });

      const ctx: PluginContext = {
        pluginName: "zod",
        provides: ["schema"],
      };

      yield* FiberRef.set(CurrentPluginContext, ctx);

      // Act: Call exp.const which should register + setRendered
      const stmt = yield* service.exp.const(
        "User",
        conjure.id("z").method("string").build(),
        {
          imports: [{ from: "zod", names: ["z"] }],
        },
      );

      // Should return a statement
      expect(stmt.type).toBe("ExportNamedDeclaration");

      // Assert behavior: symbol should now be importable
      const handle = service.use("schema:zod:User");
      expect(handle.name).toBe("User");
      expect(handle.capability).toBe("schema:zod:User");
    }),
  );

  it.effect("exp.type infers capability from context", () =>
    Effect.gen(function* () {
      const registry = new SymbolRegistryImpl();
      const service = makeConjureService({
        register: (decl) => registry.register(decl),
        setRendered: (cap, node, meta) => registry.setRendered(cap, node, meta),
        import: (cap) => registry.import(cap),
      });

      const ctx: PluginContext = {
        pluginName: "kysely",
        provides: ["type"],
      };

      yield* FiberRef.set(CurrentPluginContext, ctx);

      yield* service.exp.type("User", conjure.ts.ref("UserRow"));

      // Verify capability was correctly inferred and symbol is importable
      const handle = service.use("type:kysely:User");
      expect(handle.name).toBe("User");
      expect(handle.capability).toBe("type:kysely:User");
    }),
  );

  it.effect("exp.const stores consume callback in metadata", () =>
    Effect.gen(function* () {
      const registry = new SymbolRegistryImpl();
      const service = makeConjureService({
        register: (decl) => registry.register(decl),
        setRendered: (cap, node, meta) => registry.setRendered(cap, node, meta),
        import: (cap) => registry.import(cap),
      });

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

      // Verify consume callback is accessible via the handle
      const handle = service.use("schema:zod:User");
      expect(handle.consume).toBeDefined();
      expect(typeof handle.consume).toBe("function");
    }),
  );

  it.effect("use() returns handle for already-registered symbol", () =>
    Effect.gen(function* () {
      const registry = new SymbolRegistryImpl();
      const service = makeConjureService({
        register: (decl) => registry.register(decl),
        setRendered: (cap, node, meta) => registry.setRendered(cap, node, meta),
        import: (cap) => registry.import(cap),
      });

      // First register a symbol via exp.const
      yield* FiberRef.set(CurrentPluginContext, { pluginName: "zod", provides: ["schema"] });
      yield* service.exp.const("User", conjure.id("z").method("string").build());

      // Then use() should return a handle to it
      const handle = service.use("schema:zod:User");
      expect(handle.name).toBe("User");
      expect(handle.capability).toBe("schema:zod:User");
    }),
  );

  it.effect("pure AST builders work without context", () =>
    Effect.gen(function* () {
      const registry = new SymbolRegistryImpl();
      const service = makeConjureService({
        register: (decl) => registry.register(decl),
        setRendered: (cap, node, meta) => registry.setRendered(cap, node, meta),
        import: (cap) => registry.import(cap),
      });

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
      const registry = new SymbolRegistryImpl();
      const service = makeConjureService({
        register: (decl) => registry.register(decl),
        setRendered: (cap, node, meta) => registry.setRendered(cap, node, meta),
        import: (cap) => registry.import(cap),
      });

      const ctx: PluginContext = {
        pluginName: "zod",
        provides: ["schema"],
      };

      yield* FiberRef.set(CurrentPluginContext, ctx);

      yield* service.exp.const("UserInput", conjure.id("z").method("object").build(), {
        capability: "schema:zod:User:input",
      });

      // Should use explicit capability, not inferred
      const handle = service.use("schema:zod:User:input");
      expect(handle.name).toBe("UserInput");
      
      // The inferred capability should NOT exist
      expect(() => service.use("schema:zod:UserInput")).toThrow();
    }),
  );

  it.effect("throws when no context for capability inference", () =>
    Effect.gen(function* () {
      const registry = new SymbolRegistryImpl();
      const service = makeConjureService({
        register: (decl) => registry.register(decl),
        setRendered: (cap, node, meta) => registry.setRendered(cap, node, meta),
        import: (cap) => registry.import(cap),
      });

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

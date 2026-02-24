/**
 * Tests for SymbolRegistry cross-reference filtering.
 *
 * Validates that name-based ref matching in storeRenderedSymbol:
 * 1. Skips self-references (refName === symbol.name)
 * 2. Skips same-entity references (matching baseEntityName)
 * 3. Keeps legitimate cross-entity references (e.g., enum imports)
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { SymbolRegistryImpl } from "../runtime/registry.js";
import type { RenderedSymbol } from "../runtime/types.js";
import { conjure } from "../conjure/index.js";

const b = conjure.b;

// Minimal node for testing (not used for ref matching, just required by the type)
const dummyNode = b.exportNamedDeclaration(
  b.tsInterfaceDeclaration(b.identifier("Dummy"), b.tsInterfaceBody([])),
);

function makeSymbol(overrides: Partial<RenderedSymbol> & { name: string; capability: string }): RenderedSymbol {
  return {
    node: dummyNode,
    exports: "named",
    refs: [],
    ...overrides,
  };
}

describe("storeRenderedSymbol ref filtering", () => {
  it.effect("skips self-references (symbol name in own AST)", () =>
    Effect.gen(function* () {
      const registry = new SymbolRegistryImpl();

      // Register an enum type symbol
      yield* registry.register({ name: "Status", capability: "type:Status", baseEntityName: "Status" });

      // Store a model symbol whose refs include its own name (from Model.Class<User>)
      // and a legitimate ref to Status
      registry.storeRenderedSymbol(
        makeSymbol({
          name: "User",
          capability: "effect:model:User",
          baseEntityName: "User",
          refs: ["User", "Status"], // "User" is self-ref, "Status" is real
        }),
      );

      const refs = registry.getReferences("effect:model:User");
      // Should have Status but NOT User
      expect(refs).toContain("type:Status");
      expect(refs).not.toContain("effect:model:User");
      // Ensure no reference to a "type:User" capability exists
      // (self-reference filtering prevents this)
      expect(refs.filter(r => r.includes("User"))).toHaveLength(0);
    }),
  );

  it.effect("skips same-entity references (shared baseEntityName)", () =>
    Effect.gen(function* () {
      const registry = new SymbolRegistryImpl();

      // Register two symbols for the same entity (different capabilities)
      yield* registry.register({ name: "UserInsert", capability: "type:UserInsert", baseEntityName: "User" });
      yield* registry.register({ name: "Status", capability: "type:Status", baseEntityName: "Status" });

      // Store a symbol for User entity whose refs include UserInsert (same entity) and Status (different)
      registry.storeRenderedSymbol(
        makeSymbol({
          name: "UserRow",
          capability: "schema:UserRow",
          baseEntityName: "User",
          refs: ["UserInsert", "Status"],
        }),
      );

      const refs = registry.getReferences("schema:UserRow");
      // Should have Status (different entity) but NOT UserInsert (same entity)
      expect(refs).toContain("type:Status");
      expect(refs).not.toContain("type:UserInsert");
    }),
  );

  it.effect("keeps cross-entity enum references", () =>
    Effect.gen(function* () {
      const registry = new SymbolRegistryImpl();

      // Register enum symbols
      yield* registry.register({ name: "Status", capability: "type:Status", baseEntityName: "Status" });
      yield* registry.register({ name: "Priority", capability: "type:Priority", baseEntityName: "Priority" });

      // A model that references both enums
      registry.storeRenderedSymbol(
        makeSymbol({
          name: "Task",
          capability: "type:Task",
          baseEntityName: "Task",
          refs: ["Task", "Status", "Priority"],
        }),
      );

      const refs = registry.getReferences("type:Task");
      expect(refs).toContain("type:Status");
      expect(refs).toContain("type:Priority");
      expect(refs).toHaveLength(2);
    }),
  );

  it.effect("does not create refs for models that do not reference enums", () =>
    Effect.gen(function* () {
      const registry = new SymbolRegistryImpl();

      // Register enum symbols
      yield* registry.register({ name: "Status", capability: "type:Status", baseEntityName: "Status" });
      yield* registry.register({ name: "Priority", capability: "type:Priority", baseEntityName: "Priority" });

      // A model with NO enum refs (just its own name in AST)
      registry.storeRenderedSymbol(
        makeSymbol({
          name: "Comment",
          capability: "type:Comment",
          baseEntityName: "Comment",
          refs: ["Comment"], // Only self-ref, no enums
        }),
      );

      const refs = registry.getReferences("type:Comment");
      expect(refs).toHaveLength(0);
    }),
  );

  it.effect("prefers same-plugin-family capabilities over other providers", () =>
    Effect.gen(function* () {
      const registry = new SymbolRegistryImpl();

      // Register both effect and kysely versions of same name
      yield* registry.register({ name: "Status", capability: "effect:schema:Status", baseEntityName: "Status" });
      yield* registry.register({ name: "Status", capability: "types:kysely:Status", baseEntityName: "Status" });

      // Effect symbol should prefer effect candidate
      registry.storeRenderedSymbol(
        makeSymbol({
          name: "User",
          capability: "effect:model:User",
          baseEntityName: "User",
          refs: ["Status"],
        }),
      );

      const refs = registry.getReferences("effect:model:User");
      expect(refs).toContain("effect:schema:Status");
      expect(refs).not.toContain("types:kysely:Status");
    }),
  );
});

/**
 * Type Hint Registry Tests
 *
 * Tests for matching fields against configured type hints with precedence rules.
 */
import { describe, it, expect } from "@effect/vitest";
import { Option } from "effect";
import {
  createTypeHintRegistry,
  emptyTypeHintRegistry,
  type TypeHintFieldMatch,
} from "../services/type-hints.js";
import type { TypeHint } from "../config.js";

describe("TypeHintRegistry", () => {
  describe("emptyTypeHintRegistry", () => {
    it("returns empty hints for any field", () => {
      const field: TypeHintFieldMatch = {
        schema: "public",
        table: "users",
        column: "id",
        pgType: "uuid",
      };

      const hints = emptyTypeHintRegistry.getHints(field);
      expect(hints).toEqual({});
    });

    it("returns undefined for any specific hint", () => {
      const field: TypeHintFieldMatch = {
        schema: "public",
        table: "users",
        column: "id",
        pgType: "uuid",
      };

      const result = emptyTypeHintRegistry.getHint<string>(field, "ts");
      expect(Option.isNone(result)).toBe(true);
    });
  });

  describe("createTypeHintRegistry", () => {
    describe("basic matching", () => {
      it("matches by pgType only", () => {
        const hints: TypeHint[] = [
          {
            match: { pgType: "uuid" },
            hints: { ts: "string", zod: "z.string().uuid()" },
          },
        ];

        const registry = createTypeHintRegistry(hints);
        const field: TypeHintFieldMatch = {
          schema: "public",
          table: "users",
          column: "id",
          pgType: "uuid",
        };

        const result = registry.getHints(field);
        expect(result).toEqual({ ts: "string", zod: "z.string().uuid()" });
      });

      it("matches by column only", () => {
        const hints: TypeHint[] = [
          {
            match: { column: "email" },
            hints: { ts: "Email" },
          },
        ];

        const registry = createTypeHintRegistry(hints);
        const field: TypeHintFieldMatch = {
          schema: "public",
          table: "users",
          column: "email",
          pgType: "text",
        };

        const result = registry.getHints(field);
        expect(result).toEqual({ ts: "Email" });
      });

      it("matches by table only", () => {
        const hints: TypeHint[] = [
          {
            match: { table: "audit_log" },
            hints: { readonly: true },
          },
        ];

        const registry = createTypeHintRegistry(hints);
        const field: TypeHintFieldMatch = {
          schema: "public",
          table: "audit_log",
          column: "event",
          pgType: "text",
        };

        const result = registry.getHints(field);
        expect(result).toEqual({ readonly: true });
      });

      it("matches by schema only", () => {
        const hints: TypeHint[] = [
          {
            match: { schema: "internal" },
            hints: { internal: true },
          },
        ];

        const registry = createTypeHintRegistry(hints);
        const field: TypeHintFieldMatch = {
          schema: "internal",
          table: "metrics",
          column: "value",
          pgType: "numeric",
        };

        const result = registry.getHints(field);
        expect(result).toEqual({ internal: true });
      });

      it("matches by table + column", () => {
        const hints: TypeHint[] = [
          {
            match: { table: "users", column: "id" },
            hints: { ts: "UserId" },
          },
        ];

        const registry = createTypeHintRegistry(hints);
        const field: TypeHintFieldMatch = {
          schema: "public",
          table: "users",
          column: "id",
          pgType: "uuid",
        };

        const result = registry.getHints(field);
        expect(result).toEqual({ ts: "UserId" });
      });

      it("matches by schema + table + column", () => {
        const hints: TypeHint[] = [
          {
            match: { schema: "auth", table: "users", column: "id" },
            hints: { ts: "AuthUserId" },
          },
        ];

        const registry = createTypeHintRegistry(hints);
        const field: TypeHintFieldMatch = {
          schema: "auth",
          table: "users",
          column: "id",
          pgType: "uuid",
        };

        const result = registry.getHints(field);
        expect(result).toEqual({ ts: "AuthUserId" });
      });
    });

    describe("non-matching", () => {
      it("returns empty when pgType does not match", () => {
        const hints: TypeHint[] = [
          {
            match: { pgType: "uuid" },
            hints: { ts: "string" },
          },
        ];

        const registry = createTypeHintRegistry(hints);
        const field: TypeHintFieldMatch = {
          schema: "public",
          table: "users",
          column: "name",
          pgType: "text",
        };

        const result = registry.getHints(field);
        expect(result).toEqual({});
      });

      it("returns empty when all criteria must match but one fails", () => {
        const hints: TypeHint[] = [
          {
            match: { table: "users", column: "id" },
            hints: { ts: "UserId" },
          },
        ];

        const registry = createTypeHintRegistry(hints);
        const field: TypeHintFieldMatch = {
          schema: "public",
          table: "users",
          column: "name", // Different column
          pgType: "text",
        };

        const result = registry.getHints(field);
        expect(result).toEqual({});
      });

      it("returns empty when no hints are configured", () => {
        const registry = createTypeHintRegistry([]);
        const field: TypeHintFieldMatch = {
          schema: "public",
          table: "users",
          column: "id",
          pgType: "uuid",
        };

        const result = registry.getHints(field);
        expect(result).toEqual({});
      });
    });

    describe("precedence", () => {
      it("table+column overrides pgType", () => {
        const hints: TypeHint[] = [
          {
            match: { pgType: "uuid" },
            hints: { ts: "string" },
          },
          {
            match: { table: "users", column: "id" },
            hints: { ts: "UserId" },
          },
        ];

        const registry = createTypeHintRegistry(hints);
        const field: TypeHintFieldMatch = {
          schema: "public",
          table: "users",
          column: "id",
          pgType: "uuid",
        };

        const result = registry.getHints(field);
        expect(result["ts"]).toBe("UserId");
      });

      it("column overrides pgType", () => {
        const hints: TypeHint[] = [
          {
            match: { pgType: "text" },
            hints: { ts: "string" },
          },
          {
            match: { column: "email" },
            hints: { ts: "Email" },
          },
        ];

        const registry = createTypeHintRegistry(hints);
        const field: TypeHintFieldMatch = {
          schema: "public",
          table: "users",
          column: "email",
          pgType: "text",
        };

        const result = registry.getHints(field);
        expect(result["ts"]).toBe("Email");
      });

      it("table overrides pgType", () => {
        const hints: TypeHint[] = [
          {
            match: { pgType: "text" },
            hints: { style: "basic" },
          },
          {
            match: { table: "special" },
            hints: { style: "special" },
          },
        ];

        const registry = createTypeHintRegistry(hints);
        const field: TypeHintFieldMatch = {
          schema: "public",
          table: "special",
          column: "value",
          pgType: "text",
        };

        const result = registry.getHints(field);
        expect(result["style"]).toBe("special");
      });

      it("schema+table+column overrides table+column", () => {
        const hints: TypeHint[] = [
          {
            match: { table: "users", column: "id" },
            hints: { ts: "UserId" },
          },
          {
            match: { schema: "auth", table: "users", column: "id" },
            hints: { ts: "AuthUserId" },
          },
        ];

        const registry = createTypeHintRegistry(hints);
        const field: TypeHintFieldMatch = {
          schema: "auth",
          table: "users",
          column: "id",
          pgType: "uuid",
        };

        const result = registry.getHints(field);
        expect(result["ts"]).toBe("AuthUserId");
      });

      it("later rules override earlier for same specificity", () => {
        const hints: TypeHint[] = [
          {
            match: { pgType: "uuid" },
            hints: { ts: "FirstUuid" },
          },
          {
            match: { pgType: "uuid" },
            hints: { ts: "SecondUuid" },
          },
        ];

        const registry = createTypeHintRegistry(hints);
        const field: TypeHintFieldMatch = {
          schema: "public",
          table: "users",
          column: "id",
          pgType: "uuid",
        };

        const result = registry.getHints(field);
        expect(result["ts"]).toBe("SecondUuid");
      });
    });

    describe("merging", () => {
      it("merges hints from multiple matching rules", () => {
        const hints: TypeHint[] = [
          {
            match: { pgType: "uuid" },
            hints: { ts: "string", zod: "z.string().uuid()" },
          },
          {
            match: { column: "id" },
            hints: { branded: true },
          },
          {
            match: { table: "users", column: "id" },
            hints: { ts: "UserId" }, // Overrides ts from pgType
          },
        ];

        const registry = createTypeHintRegistry(hints);
        const field: TypeHintFieldMatch = {
          schema: "public",
          table: "users",
          column: "id",
          pgType: "uuid",
        };

        const result = registry.getHints(field);
        expect(result).toEqual({
          ts: "UserId", // Overridden by most specific
          zod: "z.string().uuid()", // From pgType match
          branded: true, // From column match
        });
      });

      it("preserves non-overlapping hints from lower precedence", () => {
        const hints: TypeHint[] = [
          {
            match: { pgType: "uuid" },
            hints: { zod: "z.string().uuid()", import: "@/schemas" },
          },
          {
            match: { table: "users", column: "id" },
            hints: { ts: "UserId" },
          },
        ];

        const registry = createTypeHintRegistry(hints);
        const field: TypeHintFieldMatch = {
          schema: "public",
          table: "users",
          column: "id",
          pgType: "uuid",
        };

        const result = registry.getHints(field);
        expect(result).toEqual({
          ts: "UserId",
          zod: "z.string().uuid()",
          import: "@/schemas",
        });
      });
    });

    describe("getHint", () => {
      it("returns specific hint value", () => {
        const hints: TypeHint[] = [
          {
            match: { pgType: "uuid" },
            hints: { ts: "string", zod: "z.string().uuid()" },
          },
        ];

        const registry = createTypeHintRegistry(hints);
        const field: TypeHintFieldMatch = {
          schema: "public",
          table: "users",
          column: "id",
          pgType: "uuid",
        };

        expect(Option.getOrNull(registry.getHint<string>(field, "ts"))).toBe("string");
        expect(Option.getOrNull(registry.getHint<string>(field, "zod"))).toBe("z.string().uuid()");
      });

      it("returns None for missing key", () => {
        const hints: TypeHint[] = [
          {
            match: { pgType: "uuid" },
            hints: { ts: "string" },
          },
        ];

        const registry = createTypeHintRegistry(hints);
        const field: TypeHintFieldMatch = {
          schema: "public",
          table: "users",
          column: "id",
          pgType: "uuid",
        };

        expect(Option.isNone(registry.getHint<string>(field, "zod"))).toBe(true);
      });

      it("returns None for non-matching field", () => {
        const hints: TypeHint[] = [
          {
            match: { pgType: "uuid" },
            hints: { ts: "string" },
          },
        ];

        const registry = createTypeHintRegistry(hints);
        const field: TypeHintFieldMatch = {
          schema: "public",
          table: "users",
          column: "name",
          pgType: "text",
        };

        expect(Option.isNone(registry.getHint<string>(field, "ts"))).toBe(true);
      });
    });

    describe("complex scenarios", () => {
      it("handles typical configuration with multiple override levels", () => {
        // Simulates a real-world config:
        // - All UUIDs get base uuid type
        // - All email columns get Email branding
        // - users.id gets special UserId branding
        const hints: TypeHint[] = [
          {
            match: { pgType: "uuid" },
            hints: { ts: "string", zod: "z.string().uuid()" },
          },
          {
            match: { pgType: "text" },
            hints: { ts: "string", zod: "z.string()" },
          },
          {
            match: { column: "email" },
            hints: { ts: "Email", zod: "emailSchema" },
          },
          {
            match: { table: "users", column: "id" },
            hints: { ts: "UserId", branded: "UserId" },
          },
        ];

        const registry = createTypeHintRegistry(hints);

        // users.id (uuid) -> UserId with uuid zod
        const userId: TypeHintFieldMatch = {
          schema: "public",
          table: "users",
          column: "id",
          pgType: "uuid",
        };
        const userIdHints = registry.getHints(userId);
        expect(userIdHints["ts"]).toBe("UserId");
        expect(userIdHints["zod"]).toBe("z.string().uuid()");
        expect(userIdHints["branded"]).toBe("UserId");

        // users.email (text) -> Email
        const userEmail: TypeHintFieldMatch = {
          schema: "public",
          table: "users",
          column: "email",
          pgType: "text",
        };
        const emailHints = registry.getHints(userEmail);
        expect(emailHints["ts"]).toBe("Email");
        expect(emailHints["zod"]).toBe("emailSchema");

        // posts.id (uuid) -> just uuid hints
        const postId: TypeHintFieldMatch = {
          schema: "public",
          table: "posts",
          column: "id",
          pgType: "uuid",
        };
        const postIdHints = registry.getHints(postId);
        expect(postIdHints["ts"]).toBe("string");
        expect(postIdHints["zod"]).toBe("z.string().uuid()");
        expect(postIdHints["branded"]).toBeUndefined();

        // posts.title (text) -> just text hints
        const postTitle: TypeHintFieldMatch = {
          schema: "public",
          table: "posts",
          column: "title",
          pgType: "text",
        };
        const titleHints = registry.getHints(postTitle);
        expect(titleHints["ts"]).toBe("string");
        expect(titleHints["zod"]).toBe("z.string()");
      });

      it("handles empty match (requires at least one criterion)", () => {
        const hints: TypeHint[] = [
          {
            match: {}, // Empty match - should never match
            hints: { shouldNotMatch: true },
          },
        ];

        const registry = createTypeHintRegistry(hints);
        const field: TypeHintFieldMatch = {
          schema: "public",
          table: "users",
          column: "id",
          pgType: "uuid",
        };

        const result = registry.getHints(field);
        expect(result).toEqual({});
      });
    });
  });
});

/**
 * Query Object Tests
 *
 * Tests the Query wrapper that provides AST rendering methods for QueryDescriptor.
 */
import { describe, it, expect } from "vitest";
import recast from "recast";

import { hex, Query, createQuery, type SelectSpec } from "../hex/index.js";
import { testIRWithEntities } from "../testing.js";
import type { TableEntity, Shape, Field } from "../ir/semantic-ir.js";
import { conjure } from "../conjure/index.js";

// =============================================================================
// Test Helpers
// =============================================================================

function mockField(name: string, pgTypeName: string, opts?: { nullable?: boolean }): Field {
  const nullable = opts?.nullable ?? false;

  const mockPgType = {
    typname: pgTypeName,
    typcategory: pgTypeName.startsWith("_") ? "A" : "S",
    typtype: "b",
  };

  const mockPgAttribute = {
    attname: name,
    attnotnull: !nullable,
    atthasdef: false,
    attgenerated: "",
    attidentity: "",
    getType: () => mockPgType,
  };

  return {
    name,
    columnName: name,
    pgAttribute: mockPgAttribute as any,
    nullable,
    optional: false,
    hasDefault: false,
    isGenerated: false,
    isIdentity: false,
    isArray: pgTypeName.startsWith("_"),
    elementTypeName: pgTypeName.startsWith("_") ? pgTypeName.slice(1) : undefined,
    tags: {},
    extensions: new Map(),
    permissions: { canSelect: true, canInsert: true, canUpdate: true },
  };
}

function mockShape(name: string, fields: Field[]): Shape {
  return { name, kind: "row", fields };
}

function mockTableEntity(name: string, fields: Field[]): TableEntity {
  return {
    kind: "table",
    name,
    pgName: name.toLowerCase(),
    schemaName: "public",
    pgClass: {} as any,
    primaryKey: { columns: ["id"], isVirtual: false },
    indexes: [],
    shapes: { row: mockShape(`${name}Row`, fields) },
    relations: [],
    tags: {},
    permissions: { canSelect: true, canInsert: true, canUpdate: true, canDelete: true },
  };
}

function testIR() {
  const userFields = [
    mockField("id", "uuid"),
    mockField("email", "text"),
    mockField("name", "text", { nullable: true }),
  ];
  return testIRWithEntities([mockTableEntity("User", userFields)]);
}

// =============================================================================
// Query Creation Tests
// =============================================================================

describe("Query Object", () => {
  describe("creation", () => {
    it("wraps a SelectSpec into a Query", () => {
      const ir = testIR();
      const query = hex.select(ir, {
        selects: [{ kind: "star", from: "User" }],
        from: { kind: "table", table: "User" },
      });

      expect(query).toBeInstanceOf(Query);
      expect(query.sql).toContain("SELECT");
      expect(query.sql).toContain("FROM");
    });

    it("creates Query from descriptor directly", () => {
      const descriptor = {
        name: "findUserById",
        entityName: "User",
        operation: "select" as const,
        sql: "SELECT * FROM users WHERE id = $1",
        params: [{ name: "id", tsType: "string", pgType: "uuid", nullable: false }],
        returns: { mode: "oneOrNone" as const, fields: [] },
      };

      const query = createQuery(descriptor);
      expect(query).toBeInstanceOf(Query);
      expect(query.sql).toBe("SELECT * FROM users WHERE id = $1");
    });
  });

  describe("accessors", () => {
    it("exposes sql string", () => {
      const ir = testIR();
      const query = hex.select(ir, {
        selects: [{ kind: "star", from: "User" }],
        from: { kind: "table", table: "User" },
        where: [{ kind: "equals", column: "User.id", value: { name: "id", pgType: "uuid" } }],
      });

      expect(query.sql).toContain("$1");
      expect(query.sql).toContain("WHERE");
    });

    it("exposes descriptor", () => {
      const ir = testIR();
      const query = hex.select(ir, {
        selects: [{ kind: "star", from: "User" }],
        from: { kind: "table", table: "User" },
      });

      expect(query.descriptor.operation).toBe("select");
      expect(query.descriptor.returns.mode).toBe("many");
    });

    it("exposes params", () => {
      const ir = testIR();
      const query = hex.select(ir, {
        selects: [{ kind: "star", from: "User" }],
        from: { kind: "table", table: "User" },
        where: [{ kind: "equals", column: "User.id", value: { name: "id", pgType: "uuid" } }],
      });

      expect(query.params).toHaveLength(1);
      expect(query.params[0]?.name).toBe("id");
      expect(query.params[0]?.pgType).toBe("uuid");
    });

    it("exposes returns", () => {
      const ir = testIR();
      const query = hex.select(ir, {
        selects: [{ kind: "star", from: "User" }],
        from: { kind: "table", table: "User" },
      });

      expect(query.returns.mode).toBe("many");
    });
  });

  describe("templateParts", () => {
    it("extracts template parts from parameterized SQL", () => {
      const descriptor = {
        name: "test",
        entityName: "User",
        operation: "select" as const,
        sql: "SELECT * FROM users WHERE id = $1 AND name = $2",
        params: [
          { name: "id", tsType: "string", pgType: "uuid", nullable: false },
          { name: "name", tsType: "string", pgType: "text", nullable: false },
        ],
        returns: { mode: "many" as const, fields: [] },
      };

      const query = createQuery(descriptor);
      const { parts, paramNames } = query.templateParts;

      expect(parts).toEqual([
        "SELECT * FROM users WHERE id = ",
        " AND name = ",
        "",
      ]);
      expect(paramNames).toEqual(["id", "name"]);
    });

    it("handles queries with no parameters", () => {
      const descriptor = {
        name: "test",
        entityName: "User",
        operation: "select" as const,
        sql: "SELECT * FROM users",
        params: [],
        returns: { mode: "many" as const, fields: [] },
      };

      const query = createQuery(descriptor);
      const { parts, paramNames } = query.templateParts;

      expect(parts).toEqual(["SELECT * FROM users"]);
      expect(paramNames).toEqual([]);
    });
  });

  describe("toTaggedTemplate", () => {
    it("generates tagged template literal AST", () => {
      const descriptor = {
        name: "test",
        entityName: "User",
        operation: "select" as const,
        sql: "SELECT * FROM users WHERE id = $1",
        params: [{ name: "id", tsType: "string", pgType: "uuid", nullable: false }],
        returns: { mode: "many" as const, fields: [] },
      };

      const query = createQuery(descriptor);
      const ast = query.toTaggedTemplate("sql");
      const code = recast.print(ast).code;

      expect(code).toBe("sql`SELECT * FROM users WHERE id = ${id}`");
    });

    it("adds type parameter when provided", () => {
      const descriptor = {
        name: "test",
        entityName: "User",
        operation: "select" as const,
        sql: "SELECT * FROM users WHERE id = $1",
        params: [{ name: "id", tsType: "string", pgType: "uuid", nullable: false }],
        returns: { mode: "many" as const, fields: [] },
      };

      const query = createQuery(descriptor);
      const ast = query.toTaggedTemplate("sql", {
        typeParam: conjure.ts.ref("User"),
      });
      const code = recast.print(ast).code;

      expect(code).toBe("sql<User>`SELECT * FROM users WHERE id = ${id}`");
    });

    it("uses custom paramExpr when provided", () => {
      const descriptor = {
        name: "test",
        entityName: "User",
        operation: "select" as const,
        sql: "SELECT * FROM users WHERE id = $1",
        params: [{ name: "id", tsType: "string", pgType: "uuid", nullable: false }],
        returns: { mode: "many" as const, fields: [] },
      };

      const query = createQuery(descriptor);
      const ast = query.toTaggedTemplate("sql", {
        paramExpr: name => conjure.id("params").prop(name).build(),
      });
      const code = recast.print(ast).code;

      expect(code).toBe("sql`SELECT * FROM users WHERE id = ${params.id}`");
    });

    it("handles multiple parameters", () => {
      const descriptor = {
        name: "test",
        entityName: "User",
        operation: "select" as const,
        sql: "SELECT * FROM users WHERE id = $1 AND email = $2",
        params: [
          { name: "id", tsType: "string", pgType: "uuid", nullable: false },
          { name: "email", tsType: "string", pgType: "text", nullable: false },
        ],
        returns: { mode: "many" as const, fields: [] },
      };

      const query = createQuery(descriptor);
      const ast = query.toTaggedTemplate("sql");
      const code = recast.print(ast).code;

      expect(code).toBe("sql`SELECT * FROM users WHERE id = ${id} AND email = ${email}`");
    });
  });

  describe("toParameterizedCall", () => {
    it("generates pool.query call AST", () => {
      const descriptor = {
        name: "test",
        entityName: "User",
        operation: "select" as const,
        sql: "SELECT * FROM users WHERE id = $1",
        params: [{ name: "id", tsType: "string", pgType: "uuid", nullable: false }],
        returns: { mode: "many" as const, fields: [] },
      };

      const query = createQuery(descriptor);
      const ast = query.toParameterizedCall("pool", "query");
      const code = recast.print(ast).code;

      expect(code).toBe('pool.query("SELECT * FROM users WHERE id = $1", [id])');
    });

    it("adds type parameter when provided", () => {
      const descriptor = {
        name: "test",
        entityName: "User",
        operation: "select" as const,
        sql: "SELECT * FROM users WHERE id = $1",
        params: [{ name: "id", tsType: "string", pgType: "uuid", nullable: false }],
        returns: { mode: "many" as const, fields: [] },
      };

      const query = createQuery(descriptor);
      const ast = query.toParameterizedCall("db", "execute", {
        typeParam: conjure.ts.ref("User"),
      });
      const code = recast.print(ast).code;

      expect(code).toBe('db.execute<User>("SELECT * FROM users WHERE id = $1", [id])');
    });

    it("uses custom paramExpr when provided", () => {
      const descriptor = {
        name: "test",
        entityName: "User",
        operation: "select" as const,
        sql: "SELECT * FROM users WHERE id = $1",
        params: [{ name: "id", tsType: "string", pgType: "uuid", nullable: false }],
        returns: { mode: "many" as const, fields: [] },
      };

      const query = createQuery(descriptor);
      const ast = query.toParameterizedCall("pool", "query", {
        paramExpr: name => conjure.id("params").prop(name).build(),
      });
      const code = recast.print(ast).code;

      expect(code).toBe('pool.query("SELECT * FROM users WHERE id = $1", [params.id])');
    });
  });

  describe("toSignature", () => {
    it("generates function signature for single param", () => {
      const descriptor = {
        name: "findUserById",
        entityName: "User",
        operation: "select" as const,
        sql: "SELECT * FROM users WHERE id = $1",
        params: [{ name: "id", tsType: "string", pgType: "uuid", nullable: false }],
        returns: { mode: "oneOrNone" as const, fields: [] },
      };

      const query = createQuery(descriptor);
      const sig = query.toSignature();
      const code = recast.print(sig).code;

      // Should be: (id: string) => Promise<unknown | null>
      expect(code).toContain("id: string");
      expect(code).toContain("Promise");
    });

    it("generates function signature with return type from fields", () => {
      const descriptor = {
        name: "findUserById",
        entityName: "User",
        operation: "select" as const,
        sql: "SELECT id, email FROM users WHERE id = $1",
        params: [{ name: "id", tsType: "string", pgType: "uuid", nullable: false }],
        returns: {
          mode: "oneOrNone" as const,
          fields: [
            { name: "id", tsType: "string", pgType: "uuid", nullable: false },
            { name: "email", tsType: "string", pgType: "text", nullable: false },
          ],
        },
      };

      const query = createQuery(descriptor);
      const sig = query.toSignature();
      const code = recast.print(sig).code;

      expect(code).toContain("id: string");
      expect(code).toContain("email: string");
    });

    it("handles void return mode", () => {
      const descriptor = {
        name: "deleteUser",
        entityName: "User",
        operation: "delete" as const,
        sql: "DELETE FROM users WHERE id = $1",
        params: [{ name: "id", tsType: "string", pgType: "uuid", nullable: false }],
        returns: { mode: "void" as const, fields: [] },
      };

      const query = createQuery(descriptor);
      const sig = query.toSignature();
      const code = recast.print(sig).code;

      expect(code).toContain("Promise<void>");
    });

    it("handles affected return mode", () => {
      const descriptor = {
        name: "updateUser",
        entityName: "User",
        operation: "update" as const,
        sql: "UPDATE users SET name = $1 WHERE id = $2",
        params: [
          { name: "name", tsType: "string", pgType: "text", nullable: false },
          { name: "id", tsType: "string", pgType: "uuid", nullable: false },
        ],
        returns: { mode: "affected" as const, fields: [] },
      };

      const query = createQuery(descriptor);
      const sig = query.toSignature();
      const code = recast.print(sig).code;

      expect(code).toContain("Promise<number>");
    });

    it("handles many return mode with array", () => {
      const descriptor = {
        name: "findAllUsers",
        entityName: "User",
        operation: "select" as const,
        sql: "SELECT id FROM users",
        params: [],
        returns: {
          mode: "many" as const,
          fields: [{ name: "id", tsType: "string", pgType: "uuid", nullable: false }],
        },
      };

      const query = createQuery(descriptor);
      const sig = query.toSignature();
      const code = recast.print(sig).code;

      expect(code).toContain("[]");
      expect(code).toContain("Promise");
    });

    it("handles nullable params", () => {
      const descriptor = {
        name: "findUsers",
        entityName: "User",
        operation: "select" as const,
        sql: "SELECT * FROM users WHERE name = $1",
        params: [{ name: "name", tsType: "string", pgType: "text", nullable: true }],
        returns: { mode: "many" as const, fields: [] },
      };

      const query = createQuery(descriptor);
      const sig = query.toSignature();
      const code = recast.print(sig).code;

      expect(code).toContain("name: string | null");
    });
  });
});

describe("hex.select integration", () => {
  it("returns Query object that works with IR", () => {
    const ir = testIR();
    const query = hex.select(ir, {
      selects: [{ kind: "column", from: "User", column: "id" }],
      from: { kind: "table", table: "User" },
      where: [{ kind: "equals", column: "User.id", value: { name: "id", pgType: "uuid" } }],
    });

    // Query object works
    expect(query.sql).toContain("SELECT");
    expect(query.params).toHaveLength(1);

    // Can render to tagged template
    const ast = query.toTaggedTemplate("sql");
    const code = recast.print(ast).code;
    expect(code).toContain("sql`");
    expect(code).toContain("${id}");
  });
});

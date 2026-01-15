/**
 * POC Plugin API Tests
 *
 * These tests explore and validate the plugin authoring API before
 * committing to full plugin implementations. They serve as design
 * documentation for how plugins should use hex and conjure.
 */
import { describe, it, expect } from "vitest";
import recast from "recast";

import {
  hex,
  testIRWithEntities,
  conjure,
  isTableEntity,
  type TableEntity,
  type Field,
} from "../index.js";

// =============================================================================
// Test Helpers
// =============================================================================

function mockField(name: string, pgType: string, nullable = false): Field {
  return {
    name,
    columnName: name,
    pgAttribute: {
      attname: name,
      attnotnull: !nullable,
      getType: () => ({ typname: pgType, typcategory: "S", typtype: "b" }),
    } as any,
    nullable,
    optional: false,
    hasDefault: false,
    isGenerated: false,
    isIdentity: false,
    isArray: false,
    tags: {},
    extensions: new Map(),
    permissions: { canSelect: true, canInsert: true, canUpdate: true },
  };
}

function mockTable(name: string, fields: Field[]): TableEntity {
  return {
    kind: "table",
    name,
    pgName: name.toLowerCase(),
    schemaName: "public",
    pgClass: {} as any,
    primaryKey: { columns: [fields[0]?.columnName ?? "id"], isVirtual: false },
    indexes: [],
    shapes: { row: { name: `${name}Row`, kind: "row", fields } },
    relations: [],
    tags: {},
    permissions: { canSelect: true, canInsert: true, canUpdate: true, canDelete: true },
  };
}

// =============================================================================
// Query Building POC
// =============================================================================

describe("POC: Query Building", () => {
  it("builds findById query with hex", () => {
    const ir = testIRWithEntities([
      mockTable("User", [
        mockField("id", "uuid"),
        mockField("email", "text"),
        mockField("name", "text", true),
      ]),
    ]);

    const query = hex.select(ir, {
      selects: [{ kind: "star", from: "User" }],
      from: { kind: "table", table: "User" },
      where: [{ kind: "equals", column: "User.id", value: { name: "id", pgType: "uuid" } }],
    });

    expect(query.sql).toBe("SELECT User.* FROM User WHERE User.id = $1");
    expect(query.params).toHaveLength(1);
    expect(query.params[0]?.name).toBe("id");
  });

  it("renders to tagged template with type param", () => {
    const ir = testIRWithEntities([
      mockTable("User", [mockField("id", "uuid"), mockField("email", "text")]),
    ]);

    const query = hex.select(ir, {
      selects: [{ kind: "star", from: "User" }],
      from: { kind: "table", table: "User" },
      where: [{ kind: "equals", column: "User.id", value: { name: "id", pgType: "uuid" } }],
    });

    const ast = query.toTaggedTemplate("sql", {
      typeParam: conjure.ts.ref("User"),
    });

    expect(recast.print(ast).code).toBe(
      "sql<User>`SELECT User.* FROM User WHERE User.id = ${id}`",
    );
  });
});

// =============================================================================
// SQL Queries Plugin Pattern
// =============================================================================

describe("POC: sql-queries plugin pattern", () => {
  it("generates findById function for each entity", () => {
    const ir = testIRWithEntities([
      mockTable("User", [
        mockField("id", "uuid"),
        mockField("email", "text"),
        mockField("created_at", "timestamptz"),
      ]),
    ]);

    const entities = Array.from(ir.entities.values()).filter(isTableEntity);
    const generated: string[] = [];

    for (const entity of entities) {
      const pk = entity.primaryKey?.columns[0];
      if (!pk) continue;

      const pkField = entity.shapes.row.fields.find(f => f.columnName === pk);
      if (!pkField) continue;

      // Build the query
      const query = hex.select(ir, {
        selects: [{ kind: "star", from: entity.name }],
        from: { kind: "table", table: entity.name },
        where: [
          {
            kind: "equals",
            column: `${entity.name}.${pk}`,
            value: { name: pk, pgType: pkField.pgAttribute.getType()!.typname },
          },
        ],
      });

      // Pattern 1: Just return the tagged template (for @effect/sql style)
      // sql`SELECT ...` returns Effect that needs to be run
      const taggedTemplate = query.toTaggedTemplate("sql", {
        typeParam: conjure.ts.ref(entity.name),
      });

      const fn = conjure.fn()
        .async()
        .arrow()
        .param(pk, conjure.ts.string())
        .body(conjure.stmt.return(taggedTemplate))
        .build();

      const exported = conjure.export.const(`find${entity.name}ById`, fn);
      generated.push(recast.print(exported).code);
    }

    expect(generated).toHaveLength(1);
    expect(generated[0]).toContain("findUserById");
    expect(generated[0]).toContain("sql<User>`SELECT User.* FROM User WHERE User.id = ${id}`");
  });

  it("generates findAll with pagination", () => {
    const ir = testIRWithEntities([
      mockTable("User", [mockField("id", "uuid"), mockField("email", "text")]),
    ]);

    const entity = ir.entities.get("User") as TableEntity;

    const query = hex.select(ir, {
      selects: [{ kind: "star", from: "User" }],
      from: { kind: "table", table: "User" },
      orderBy: [{ kind: "column", from: "User", column: "id", direction: "asc" }],
      limit: { name: "limit", pgType: "int4" },
      offset: { name: "offset", pgType: "int4" },
    });

    const taggedTemplate = query.toTaggedTemplate("sql", {
      typeParam: conjure.ts.array(conjure.ts.ref("User")),
    });

    // Destructured params pattern
    const fn = conjure.fn()
      .async()
      .arrow()
      .param("opts", conjure.ts.objectType([
        { name: "limit", type: conjure.ts.number(), optional: true },
        { name: "offset", type: conjure.ts.number(), optional: true },
      ]))
      .body(conjure.stmt.return(taggedTemplate))
      .build();

    const code = recast.print(fn).code;

    expect(code).toContain("limit");
    expect(code).toContain("offset");
    expect(query.sql).toContain("LIMIT");
    expect(query.sql).toContain("OFFSET");
  });
});

// =============================================================================
// Zod Plugin Pattern
// =============================================================================

describe("POC: zod plugin pattern", () => {
  /**
   * Map PG type to Zod method chain
   */
  function pgToZodChain(pgType: string, nullable: boolean) {
    let chain = conjure.id("z");

    switch (pgType) {
      case "uuid":
        chain = chain.method("string").method("uuid");
        break;
      case "text":
      case "varchar":
        chain = chain.method("string");
        break;
      case "int2":
      case "int4":
        chain = chain.method("number").method("int");
        break;
      case "int8":
        chain = chain.method("bigint");
        break;
      case "float4":
      case "float8":
      case "numeric":
        chain = chain.method("number");
        break;
      case "bool":
        chain = chain.method("boolean");
        break;
      case "timestamptz":
      case "timestamp":
      case "date":
        chain = chain.method("date");
        break;
      default:
        chain = chain.method("unknown");
    }

    if (nullable) chain = chain.method("nullable");
    return chain.build();
  }

  it("generates zod schema from entity shape", () => {
    const ir = testIRWithEntities([
      mockTable("User", [
        mockField("id", "uuid"),
        mockField("email", "text"),
        mockField("age", "int4"),
        mockField("bio", "text", true),
      ]),
    ]);

    const entity = ir.entities.get("User") as TableEntity;

    // Build z.object({ ... }) - ObjBuilder is immutable, must reassign
    let objBuilder = conjure.obj();
    for (const field of entity.shapes.row.fields) {
      const pgType = field.pgAttribute.getType()!.typname;
      objBuilder = objBuilder.prop(field.name, pgToZodChain(pgType, field.nullable));
    }

    const schema = conjure.id("z").method("object", [objBuilder.build()]).build();
    const exported = conjure.export.const("UserSchema", schema);
    const code = recast.print(exported).code;

    expect(code).toContain("z.object");
    expect(code).toContain("z.string().uuid()");
    expect(code).toContain("z.string()");
    expect(code).toContain("z.number().int()");
    expect(code).toContain("z.string().nullable()");
  });

  it("generates inferred type export", () => {
    // export type User = z.infer<typeof UserSchema>
    const inferType = conjure.ts.qualifiedRef("z", "infer", [
      conjure.ts.typeof("UserSchema"),
    ]);

    const typeExport = conjure.export.type("User", inferType);
    const code = recast.print(typeExport).code;

    expect(code).toBe("export type User = z.infer<typeof UserSchema>;");
  });
});

// =============================================================================
// Cross-Plugin Reference Pattern
// =============================================================================

describe("POC: cross-plugin references", () => {
  it("HTTP route consuming query function", () => {
    // Simulating what http-hono plugin would generate
    // Assumes: findUserById exists from sql-queries plugin
    // Assumes: UserSchema exists from zod plugin

    // Route handler that:
    // 1. Validates input with schema
    // 2. Calls query function
    // 3. Returns JSON response

    const handler = conjure.fn()
      .async()
      .arrow()
      .param("c", conjure.ts.ref("Context"))
      .body(
        // const id = c.req.param("id")
        conjure.stmt.const(
          "id",
          conjure.id("c").prop("req").method("param", [conjure.str("id")]).build(),
        ),
        // const user = await findUserById(id)
        conjure.stmt.const(
          "user",
          conjure.await(
            conjure.id("findUserById").call([conjure.id("id").build()]).build(),
          ),
        ),
        // return c.json(user)
        conjure.stmt.return(
          conjure.id("c").method("json", [conjure.id("user").build()]).build(),
        ),
      )
      .build();

    const code = recast.print(handler).code;

    expect(code).toContain('c.req.param("id")');
    expect(code).toContain("await findUserById(id)");
    expect(code).toContain("c.json(user)");
  });
});

/**
 * Zod Plugin Tests
 *
 * Validates the zod plugin:
 * 1. Correctly declares schema:zod:EntityName capabilities for each table
 * 2. Renders valid Zod schema AST nodes
 * 3. Handles type inference for non-row shapes
 * 4. Handles enum types correctly
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import recast from "recast";

import { zod } from "../plugins/zod.js";
import { runPlugins, type OrchestratorConfig } from "../runtime/orchestrator.js";
import { emitFiles } from "../runtime/emit.js";
import { defaultInflection } from "../services/inflection.js";
import { emptyTypeHintRegistry } from "../services/type-hints.js";
import { testIRWithEntities } from "../testing.js";
import type { TableEntity, Shape, Field, EnumEntity, SemanticIR } from "../ir/semantic-ir.js";

// =============================================================================
// Test Helpers
// =============================================================================

function testConfig(ir: SemanticIR): Omit<OrchestratorConfig, "plugins"> {
  return {
    ir,
    inflection: defaultInflection,
    typeHints: emptyTypeHintRegistry,
    defaultFile: "index.ts",
    outputDir: "src/generated",
  };
}

/**
 * Create a minimal mock Field for testing.
 */
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

/**
 * Create a minimal mock Shape for testing.
 */
function mockShape(name: string, kind: "row" | "insert" | "update", fields: Field[]): Shape {
  return {
    name,
    kind,
    fields,
  };
}

/**
 * Create a minimal mock TableEntity for testing.
 */
function mockTableEntity(name: string, rowFields: Field[]): TableEntity {
  const rowShape = mockShape(`${name}`, "row", rowFields);

  return {
    kind: "table",
    name,
    pgName: name.toLowerCase(),
    schemaName: "public",
    pgClass: {} as any,
    primaryKey: { columns: ["id"], isVirtual: false },
    indexes: [],
    shapes: { row: rowShape },
    relations: [],
    tags: {},
    permissions: { canSelect: true, canInsert: true, canUpdate: true, canDelete: true },
  };
}

// =============================================================================
// Declare Phase Tests
// =============================================================================

describe("Zod Plugin - Declare", () => {
  it.effect("declares schema:zod:EntityName for each table entity", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid"),
        mockField("email", "text"),
        mockField("name", "text", { nullable: true }),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [zod()] });

      // Filter out the schema builder declaration
      const schemaDecls = result.declarations.filter(d => !d.capability.endsWith(":builder"));
      expect(schemaDecls).toHaveLength(1);
      expect(schemaDecls[0]?.name).toBe("User");
      expect(schemaDecls[0]?.capability).toBe("schema:zod:User");
    }),
  );

  it.effect("declares capabilities for insert and update shapes", () =>
    Effect.gen(function* () {
      const rowFields = [mockField("id", "uuid"), mockField("email", "text")];
      const insertFields = [mockField("email", "text")];
      const updateFields = [mockField("email", "text")];

      const ir = testIRWithEntities([
        {
          kind: "table",
          name: "User",
          pgName: "users",
          schemaName: "public",
          pgClass: {} as any,
          primaryKey: { columns: ["id"], isVirtual: false },
          indexes: [],
          shapes: {
            row: mockShape("User", "row", rowFields),
            insert: mockShape("UserInsert", "insert", insertFields),
            update: mockShape("UserUpdate", "update", updateFields),
          },
          relations: [],
          tags: {},
          permissions: { canSelect: true, canInsert: true, canUpdate: true, canDelete: true },
        },
      ]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [zod()] });

      // Filter out the schema builder declaration
      const schemaDecls = result.declarations.filter(d => !d.capability.endsWith(":builder"));
      expect(schemaDecls).toHaveLength(5);

      const capabilities = result.declarations.map(d => d.capability);
      expect(capabilities).toContain("schema:zod:User");
      expect(capabilities).toContain("schema:zod:UserInsert");
      expect(capabilities).toContain("schema:zod:UserInsert:type");
      expect(capabilities).toContain("schema:zod:UserUpdate");
      expect(capabilities).toContain("schema:zod:UserUpdate:type");

      const insertDecl = result.declarations.find(d => d.capability === "schema:zod:UserInsert");
      expect(insertDecl?.dependsOn).toContain("type:User");

      const insertTypeDecl = result.declarations.find(d => d.capability === "schema:zod:UserInsert:type");
      expect(insertTypeDecl?.dependsOn).toContain("type:User");
    }),
  );

  it.effect("declares capabilities for enum entities", () =>
    Effect.gen(function* () {
      const ir = testIRWithEntities([]);

      (ir.entities as Map<string, EnumEntity>).set("Status", {
        kind: "enum",
        name: "Status",
        pgName: "status",
        schemaName: "public",
        pgType: { typname: "status", typtype: "e" } as any,
        values: ["active", "inactive"],
        tags: {},
      });

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [zod()] });

      // Filter out the schema builder declaration
      const schemaDecls = result.declarations.filter(d => !d.capability.endsWith(":builder"));
      expect(schemaDecls).toHaveLength(2);

      const schemaDecl = result.declarations.find(d => d.capability === "schema:zod:Status");
      expect(schemaDecl?.name).toBe("Status");

      const typeDecl = result.declarations.find(d => d.capability === "schema:zod:Status:type");
      expect(typeDecl?.name).toBe("Status");
    }),
  );
});

// =============================================================================
// Render Phase Tests
// =============================================================================

describe("Zod Plugin - Render", () => {
  it.effect("renders Zod schema with z.object()", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid"),
        mockField("email", "text"),
        mockField("name", "text", { nullable: true }),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [zod()] });

      // Filter out the schema builder (virtual symbol with no node)
      const schemaSymbols = result.rendered.filter(r => r.node !== null);
      expect(schemaSymbols).toHaveLength(1);

      const rendered = schemaSymbols[0]!;
      expect(rendered.name).toBe("User");
      expect(rendered.capability).toBe("schema:zod:User");
      expect(rendered.exports).toBe("named");

      const code = recast.print(rendered.node as recast.types.ASTNode).code;
      expect(code).toContain("z.object");
      expect(code).toContain("id: z.uuid()");
      expect(code).toContain("email: z.string()");
      expect(code).toContain("name: z.string().nullable()");
    }),
  );

  it.effect("handles UUID type with z.uuid() validator", () =>
    Effect.gen(function* () {
      const fields = [mockField("id", "uuid")];

      const ir = testIRWithEntities([mockTableEntity("User", fields)]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [zod()] });

      const code = recast.print(result.rendered[0]!.node as recast.types.ASTNode).code;
      expect(code).toContain("z.uuid()");
    }),
  );

  it.effect("handles date types with z.coerce().date()", () =>
    Effect.gen(function* () {
      const fields = [mockField("createdAt", "timestamp")];

      const ir = testIRWithEntities([mockTableEntity("User", fields)]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [zod()] });

      const code = recast.print(result.rendered[0]!.node as recast.types.ASTNode).code;
      expect(code).toContain("z.coerce().date()");
    }),
  );

  it.effect("handles number types", () =>
    Effect.gen(function* () {
      const fields = [mockField("count", "int4"), mockField("price", "numeric")];

      const ir = testIRWithEntities([mockTableEntity("Item", fields)]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [zod()] });

      const code = recast.print(result.rendered[0]!.node as recast.types.ASTNode).code;
      expect(code).toContain("count: z.number()");
      expect(code).toContain("price: z.number()");
    }),
  );

  it.effect("handles boolean types", () =>
    Effect.gen(function* () {
      const fields = [mockField("active", "bool")];

      const ir = testIRWithEntities([mockTableEntity("User", fields)]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [zod()] });

      const code = recast.print(result.rendered[0]!.node as recast.types.ASTNode).code;
      expect(code).toContain("active: z.boolean()");
    }),
  );

  it.effect("generates inferred type export for non-row shapes", () =>
    Effect.gen(function* () {
      const ir = testIRWithEntities([
        {
          kind: "table",
          name: "User",
          pgName: "users",
          schemaName: "public",
          pgClass: {} as any,
          primaryKey: { columns: ["id"], isVirtual: false },
          indexes: [],
          shapes: {
            row: mockShape("User", "row", [mockField("id", "uuid"), mockField("email", "text")]),
            insert: mockShape("UserInsert", "insert", [mockField("email", "text")]),
          },
          relations: [],
          tags: {},
          permissions: { canSelect: true, canInsert: true, canUpdate: true, canDelete: true },
        },
      ]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [zod()] });

      const insertType = result.rendered.find(r => r.name === "UserInsert" && r.capability === "schema:zod:UserInsert:type");
      expect(insertType).toBeDefined();

      const code = recast.print(insertType!.node as recast.types.ASTNode).code;
      expect(code).toContain("export type UserInsert = z.infer<typeof UserInsert>");
    }),
  );

  it.effect("generates enum schema for enum entities", () =>
    Effect.gen(function* () {
      const ir = testIRWithEntities([]);

      (ir.entities as Map<string, EnumEntity>).set("Status", {
        kind: "enum",
        name: "Status",
        pgName: "status",
        schemaName: "public",
        pgType: { typname: "status", typtype: "e" } as any,
        values: ["active", "inactive", "pending"],
        tags: {},
      });

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [zod()] });

      const schemaDecl = result.rendered.find(r => r.name === "Status" && r.capability === "schema:zod:Status");
      expect(schemaDecl).toBeDefined();

      const code = recast.print(schemaDecl!.node as recast.types.ASTNode).code;
      expect(code).toContain("z.enum([\"active\", \"inactive\", \"pending\"])");

      const typeDecl = result.rendered.find(r => r.name === "Status" && r.capability === "schema:zod:Status:type");
      expect(typeDecl).toBeDefined();

      const typeCode = recast.print(typeDecl!.node as recast.types.ASTNode).code;
      expect(typeCode).toContain("export type Status = z.infer<typeof Status>");
    }),
  );
});

// =============================================================================
// Emit Tests
// =============================================================================

describe("Zod Plugin - Emit", () => {
  it.effect("emits valid TypeScript file with Zod schemas", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid"),
        mockField("email", "text"),
        mockField("createdAt", "timestamptz"),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [zod()] });

      const files = emitFiles(result);

      expect(files).toHaveLength(1);
      // Path is relative to outputDir
      expect(files[0]?.path).toBe("schemas.ts");

      const content = files[0]!.content;
      expect(content).toContain("z.object");
      expect(content).toContain("z.uuid()");
      expect(content).toContain("z.string()");
      expect(content).toContain("z.coerce().date()");
    }),
  );
});

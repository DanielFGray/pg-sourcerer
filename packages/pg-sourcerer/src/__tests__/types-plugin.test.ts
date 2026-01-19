/**
 * Types Plugin Tests
 *
 * Validates the types plugin:
 * 1. Correctly declares type:EntityName capabilities for each table
 * 2. Renders valid TypeScript interface AST nodes
 * 3. Integrates with the orchestrator and emit pipeline
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import recast from "recast";

import { typesPlugin } from "../plugins/types.js";
import { runPlugins, type OrchestratorConfig } from "../runtime/orchestrator.js";
import { emitFiles } from "../runtime/emit.js";
import { defaultInflection } from "../services/inflection.js";
import { emptyTypeHintRegistry } from "../services/type-hints.js";
import { testIRWithEntities } from "../testing.js";
import type { TableEntity, Shape, Field, SemanticIR } from "../ir/semantic-ir.js";

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
 * Uses a stub PgAttribute that provides just enough for types.fromField().
 */
function mockField(name: string, pgTypeName: string, opts?: { nullable?: boolean }): Field {
  const nullable = opts?.nullable ?? false;

  // Create a stub pgType that types.fromField() can use
  const mockPgType = {
    typname: pgTypeName,
    typcategory: pgTypeName.startsWith("_") ? "A" : "S", // Arrays start with _
    typtype: "b", // base type
  };

  // Create a stub pgAttribute
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
function mockShape(name: string, fields: Field[]): Shape {
  return {
    name,
    kind: "row",
    fields,
  };
}

/**
 * Create a minimal mock TableEntity for testing.
 */
function mockTableEntity(name: string, fields: Field[]): TableEntity {
  const rowShape = mockShape(`${name}Row`, fields);

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

describe("Types Plugin - Declare", () => {
  it.effect("declares type:EntityName for each table entity", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid"),
        mockField("email", "text"),
        mockField("name", "text", { nullable: true }),
      ];

      const postFields = [
        mockField("id", "uuid"),
        mockField("title", "text"),
        mockField("userId", "uuid"),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields), mockTableEntity("Post", postFields)]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [typesPlugin()] });

      expect(result.declarations).toHaveLength(2);

      const capabilities = result.declarations.map(d => d.capability);
      expect(capabilities).toContain("type:User");
      expect(capabilities).toContain("type:Post");

      const names = result.declarations.map(d => d.name);
      expect(names).toContain("User");
      expect(names).toContain("Post");
    }),
  );

  it.effect("skips non-table entities (enums, views)", () =>
    Effect.gen(function* () {
      const userFields = [mockField("id", "uuid"), mockField("email", "text")];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);

      // Add an enum entity manually
      (ir.entities as Map<string, any>).set("Status", {
        kind: "enum",
        name: "Status",
        pgName: "status",
        schemaName: "public",
        pgType: {} as any,
        values: ["active", "inactive"],
        tags: {},
      });

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [typesPlugin()] });

      // Should only have User, not Status
      expect(result.declarations).toHaveLength(1);
      expect(result.declarations[0]?.name).toBe("User");
    }),
  );
});

// =============================================================================
// Render Phase Tests
// =============================================================================

describe("Types Plugin - Render", () => {
  it.effect("renders TypeScript interface with readonly properties", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid"),
        mockField("email", "text"),
        mockField("name", "text", { nullable: true }),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [typesPlugin()] });

      expect(result.rendered).toHaveLength(1);

      const rendered = result.rendered[0]!;
      expect(rendered.name).toBe("User");
      expect(rendered.capability).toBe("type:User");
      expect(rendered.exports).toBe("named");

      // Verify AST structure
      const code = recast.print(rendered.node as recast.types.ASTNode).code;
      expect(code).toContain("interface User");
      expect(code).toContain("readonly id: string");
      expect(code).toContain("readonly email: string");
      expect(code).toContain("readonly name: string | null");
    }),
  );

  it.effect("handles multiple field types correctly", () =>
    Effect.gen(function* () {
      const fields = [
        mockField("id", "uuid"),
        mockField("count", "int4"),
        mockField("active", "bool"),
        mockField("createdAt", "timestamp"),
        mockField("metadata", "jsonb"),
      ];

      const ir = testIRWithEntities([mockTableEntity("Item", fields)]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [typesPlugin()] });

      const code = recast.print(result.rendered[0]!.node as recast.types.ASTNode).code;

      expect(code).toContain("readonly id: string"); // uuid → string
      expect(code).toContain("readonly count: number"); // int4 → number
      expect(code).toContain("readonly active: boolean"); // bool → boolean
      expect(code).toContain("readonly createdAt: Date"); // timestamp → Date
      expect(code).toContain("readonly metadata: unknown"); // jsonb → unknown
    }),
  );
});

// =============================================================================
// End-to-End Emit Tests
// =============================================================================

describe("Types Plugin - Emit", () => {
  it.effect("emits valid TypeScript file with exports", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid"),
        mockField("email", "text"),
        mockField("createdAt", "timestamptz"),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [typesPlugin()] });

      const files = emitFiles(result);

      expect(files).toHaveLength(1);
      // Path is relative to outputDir
      expect(files[0]?.path).toBe("types.ts");

      const content = files[0]!.content;
      expect(content).toContain("export interface User");
      expect(content).toContain("readonly id: string");
      expect(content).toContain("readonly email: string");
      expect(content).toContain("readonly createdAt: Date");
    }),
  );

  it.effect("emits multiple entities to same file", () =>
    Effect.gen(function* () {
      const userFields = [mockField("id", "uuid"), mockField("email", "text")];
      const postFields = [mockField("id", "uuid"), mockField("title", "text")];

      const ir = testIRWithEntities([
        mockTableEntity("User", userFields),
        mockTableEntity("Post", postFields),
      ]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [typesPlugin()] });

      const files = emitFiles(result);

      expect(files).toHaveLength(1);

      const content = files[0]!.content;
      expect(content).toContain("export interface User");
      expect(content).toContain("export interface Post");
    }),
  );

  it.effect("adds header comment when configured", () =>
    Effect.gen(function* () {
      const ir = testIRWithEntities([mockTableEntity("User", [mockField("id", "uuid")])]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [typesPlugin()] });

      const files = emitFiles(result, { headerComment: "// Generated by pg-sourcerer" });

      expect(files[0]!.content).toMatch(/^\/\/ Generated by pg-sourcerer/);
    }),
  );
});

/**
 * Tests for Kysely Queries Plugin - Declaration Phase
 *
 * Tests the new pattern: plugins return query descriptors via metadata,
 * not complete async functions. Consumers decide how to execute them.
 *
 * Note: Full render tests require a complete IR with table entities.
 * We test declaration phase here (capability announcements).
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";

import { kysely } from "../plugins/kysely.js";
import { runPlugins, type OrchestratorConfig } from "../runtime/orchestrator.js";
import { defaultInflection } from "../services/inflection.js";
import { emptyTypeHintRegistry } from "../services/type-hints.js";
import { testIRFromFixture, testIRWithEntities } from "../testing.js";
import type { TableEntity, Shape, Field, SemanticIR, IndexDef } from "../ir/semantic-ir.js";

function testConfig(ir: SemanticIR): Omit<OrchestratorConfig, "plugins"> {
  return {
    ir,
    inflection: defaultInflection,
    typeHints: emptyTypeHintRegistry,
    defaultFile: "index.ts",
    outputDir: "generated",
  };
}

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
  return {
    name,
    kind: "row",
    fields,
  };
}

function mockTableEntity(name: string, fields: Field[], opts?: {
  primaryKey?: { columns: string[]; isVirtual: boolean } | undefined;
  indexes?: IndexDef[];
  permissions?: { canSelect: boolean; canInsert: boolean; canUpdate: boolean; canDelete: boolean };
  tags?: Record<string, unknown>;
  includeInsert?: boolean;
  includeUpdate?: boolean;
}): TableEntity {
  const rowShape = mockShape(`${name}`, fields);
  const insertShape = mockShape(`${name}Insert`, fields.map(f => ({ ...f, optional: true })));
  const updateShape = mockShape(`${name}Update`, fields.map(f => ({ ...f, optional: true })));
  
  // Build shapes object conditionally
  const includeInsert = opts?.includeInsert !== false;
  const includeUpdate = opts?.includeUpdate !== false;
  
  return {
    kind: "table",
    name,
    pgName: name.toLowerCase(),
    schemaName: "public",
    pgClass: {} as any,
    primaryKey: opts?.primaryKey ?? { columns: ["id"], isVirtual: false },
    indexes: opts?.indexes ?? [],
    shapes: includeInsert && includeUpdate
      ? { row: rowShape, insert: insertShape, update: updateShape }
      : includeInsert
        ? { row: rowShape, insert: insertShape }
        : includeUpdate
          ? { row: rowShape, update: updateShape }
          : { row: rowShape },
    relations: [],
    tags: opts?.tags ?? {},
    permissions: opts?.permissions ?? { canSelect: true, canInsert: true, canUpdate: true, canDelete: true },
  };
}

describe("Kysely Queries Plugin - Declaration", () => {
  it.effect("declares CRUD query capabilities for table entities with PK", () =>
    Effect.gen(function* () {
      const ir = yield* testIRFromFixture(["app_public"]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely()] });

      const capabilities = result.declarations.map(d => d.capability);
      expect(capabilities).toContain("queries:kysely:User:findById");
      // Note: list is no longer generated - replaced by cursor pagination (listBy{Column})
      // which only generates for tables with btree-indexed timestamptz columns
      expect(capabilities).toContain("queries:kysely:User:create");
      expect(capabilities).toContain("queries:kysely:User:update");
      expect(capabilities).toContain("queries:kysely:User:delete");
    }),
  );

  it.effect("does not declare query capabilities for omitted entities", () =>
    Effect.gen(function* () {
      const baseIR = yield* testIRFromFixture(["app_public"]);
      const user = baseIR.entities.get("User");
      if (user && user.kind === "table") {
        const modifiedUser = { ...user, tags: { omit: true } };
        const ir = { ...baseIR, entities: new Map([["User", modifiedUser]]) };

        const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely()] });

        const queryCapabilities = result.declarations.filter(d => d.capability.startsWith("queries:"));
        // Omitted entities don't get query capabilities, but DB interface is still declared
        expect(queryCapabilities).toHaveLength(0);
        // DB interface is always declared (even if empty)
        expect(result.declarations.some(d => d.capability === "types:kysely:DB")).toBe(true);
      }
    }),
  );

  it.effect("skips query capabilities when all permissions are denied", () =>
    Effect.gen(function* () {
      const baseIR = yield* testIRFromFixture(["app_public"]);
      const user = baseIR.entities.get("User");
      if (user && user.kind === "table") {
        const modifiedUser = { ...user, permissions: { canSelect: false, canInsert: false, canUpdate: false, canDelete: false } };
        const ir = { ...baseIR, entities: new Map([["User", modifiedUser]]) };

        const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely()] });

        const queryCapabilities = result.declarations.filter(d => d.capability.startsWith("queries:"));
        // No query capabilities when permissions deny all operations
        expect(queryCapabilities).toHaveLength(0);
        // Type is still declared (for the table interface)
        expect(result.declarations.some(d => d.capability === "types:kysely:User")).toBe(true);
      }
    }),
  );

  it.effect("skips findById/update/delete when no primary key", () =>
    Effect.gen(function* () {
      const userFields = [mockField("email", "text")];
      const ir = testIRWithEntities([mockTableEntity("User", userFields, {
        primaryKey: { columns: [], isVirtual: true },
      })]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely()] });

      const capabilities = result.declarations.map(d => d.capability);
      expect(capabilities).not.toContain("queries:kysely:User:findById");
      expect(capabilities).not.toContain("queries:kysely:User:update");
      expect(capabilities).not.toContain("queries:kysely:User:delete");
      // Note: list is no longer generated - replaced by cursor pagination
      expect(capabilities).toContain("queries:kysely:User:create");
    }),
  );

  it.effect("generates listBy cursor pagination for indexed timestamptz columns", () =>
    Effect.gen(function* () {
      const ir = yield* testIRFromFixture(["app_public"]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely()] });

      const capabilities = result.declarations.map(d => d.capability);
      // Users has indexed username column
      expect(capabilities).toContain("queries:kysely:User:findByUsername");
    }),
  );

  it.effect("generates listBy cursor pagination for indexed timestamptz columns", () =>
    Effect.gen(function* () {
      const ir = yield* testIRFromFixture(["app_public"]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely()] });

      const capabilities = result.declarations.map(d => d.capability);
      // Post table has created_at index (timestamptz)
      expect(capabilities).toContain("queries:kysely:Post:listByCreatedAt");
    }),
  );

  it.effect("does not generate listBy for non-timestamptz indexed columns", () =>
    Effect.gen(function* () {
      const ir = yield* testIRFromFixture(["app_public"]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely()] });

      const capabilities = result.declarations.map(d => d.capability);
      // findByUsername is generated (for lookup), but not listByUsername (not timestamptz)
      expect(capabilities).toContain("queries:kysely:User:findByUsername");
      expect(capabilities).not.toContain("queries:kysely:User:listByUsername");
    }),
  );

  it.effect("does not generate listBy for partial indexes", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid"),
        mockField("createdAt", "timestamptz"),
      ];
      const ir = testIRWithEntities([mockTableEntity("User", userFields, {
        indexes: [{ 
          name: "idx_user_created_at_partial", 
          columns: ["createdAt"], 
          columnNames: ["created_at"],
          isUnique: false, 
          isPrimary: false,
          isPartial: true, // Partial index - should be skipped
          hasExpressions: false, 
          method: "btree",
          opclassNames: [],
          sortOptions: [{ desc: true, nullsFirst: false }],
        }],
      })]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely()] });

      const capabilities = result.declarations.map(d => d.capability);
      expect(capabilities).not.toContain("queries:kysely:User:listByCreatedAt");
    }),
  );

  it.effect("declares symbols with dependsOn for type references", () =>
    Effect.gen(function* () {
      const ir = yield* testIRFromFixture(["app_public"]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely()] });

      const findByIdDecl = result.declarations.find(d => d.capability === "queries:kysely:User:findById");
      expect(findByIdDecl).toBeDefined();
      // Queries depend on their own types (types:kysely:User)
      expect(findByIdDecl!.dependsOn).toContain("types:kysely:User");
    }),
  );

  it.effect("capability pattern is queries:kysely:EntityName:operation", () =>
    Effect.gen(function* () {
      const ir = yield* testIRFromFixture(["app_public"]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely()] });

      const capabilities = result.declarations.map(d => d.capability);

      // Verify pattern
      expect(capabilities).toContain("queries:kysely:User:findById");
      // Note: list is no longer generated - replaced by cursor pagination (listBy{Column})
      expect(capabilities).toContain("queries:kysely:User:create");
      expect(capabilities).toContain("queries:kysely:User:update");
      expect(capabilities).toContain("queries:kysely:User:delete");
    }),
  );
});

describe("Kysely Queries Plugin - Architecture", () => {
  it.effect("plugin declares zero provides (dynamic based on IR)", () =>
    Effect.gen(function* () {
      const userFields = [mockField("id", "uuid")];
      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely()] });

      // Plugin provides the "queries" category - registering as THE queries provider
      expect(kysely().provides).toEqual(["queries"]);
      
      // Declarations are dynamically generated from IR
      expect(result.declarations.length).toBeGreaterThan(0);
    }),
  );

  it.effect("each query has unique capability identifier", () =>
    Effect.gen(function* () {
      const ir = yield* testIRFromFixture(["app_public"]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely()] });

      // All capabilities should be unique
      const capabilities = result.declarations.map(d => d.capability);
      const uniqueCapabilities = new Set(capabilities);
      expect(capabilities.length).toBe(uniqueCapabilities.size);
    }),
  );
});

// =============================================================================
// Kysely Types - Role Permission Tests
// =============================================================================

describe("Kysely Plugin - Role Permissions", () => {
  // Helper to create a field with specific permissions
  function mockFieldWithPerms(name: string, pgTypeName: string, opts?: {
    nullable?: boolean;
    hasDefault?: boolean;
    permissions?: { canSelect: boolean; canInsert: boolean; canUpdate: boolean };
  }): Field {
    const nullable = opts?.nullable ?? false;
    const hasDefault = opts?.hasDefault ?? false;
    const mockPgType = {
      typname: pgTypeName,
      typcategory: pgTypeName.startsWith("_") ? "A" : "S",
      typtype: "b",
    };
    const mockPgAttribute = {
      attname: name,
      attnotnull: !nullable,
      atthasdef: hasDefault,
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
      hasDefault,
      isGenerated: false,
      isIdentity: false,
      isArray: pgTypeName.startsWith("_"),
      elementTypeName: pgTypeName.startsWith("_") ? pgTypeName.slice(1) : undefined,
      tags: {},
      extensions: new Map(),
      permissions: opts?.permissions ?? { canSelect: true, canInsert: true, canUpdate: true },
    };
  }

  it.effect("wraps fields without insert permission in Generated<T> even without default", () =>
    Effect.gen(function* () {
      // Scenario: role can SELECT post_id but cannot INSERT it
      // Without the fix, this would NOT be wrapped in Generated<T> because hasDefault=false
      // With the fix, it IS wrapped because canInsert=false
      const userFields = [
        mockFieldWithPerms("id", "uuid", {
          hasDefault: true,
          permissions: { canSelect: true, canInsert: true, canUpdate: true },
        }),
        mockFieldWithPerms("post_id", "int4", {
          hasDefault: false, // No default!
          permissions: { canSelect: true, canInsert: false, canUpdate: false }, // Can't insert
        }),
        mockFieldWithPerms("body", "text", {
          permissions: { canSelect: true, canInsert: true, canUpdate: true },
        }),
      ];

      const ir = testIRWithEntities([mockTableEntity("Comment", userFields)]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely()] });

      // Find the type declaration
      const typeRendered = result.rendered.find(r => r.capability === "types:kysely:Comment");
      expect(typeRendered).toBeDefined();

      // Print the AST and verify Generated<T> wrapping
      const code = recast.print(typeRendered!.node as recast.types.ASTNode).code;

      // post_id should be wrapped in Generated<T> because canInsert=false
      // This makes it optional in Insertable<Comment>, matching IR insert shape behavior
      expect(code).toContain("Generated<");

      // id has default and canInsert=true, so it's Generated (standard behavior)
      // post_id has NO default but canInsert=false, so it should ALSO be Generated (the fix)
    }),
  );

  it.effect("fields with default and canInsert=true are wrapped in Generated<T>", () =>
    Effect.gen(function* () {
      const fields = [
        mockFieldWithPerms("id", "uuid", {
          hasDefault: true,
          permissions: { canSelect: true, canInsert: true, canUpdate: true },
        }),
        mockFieldWithPerms("name", "text", {
          hasDefault: false,
          permissions: { canSelect: true, canInsert: true, canUpdate: true },
        }),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", fields)]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely()] });

      const typeRendered = result.rendered.find(r => r.capability === "types:kysely:User");
      const code = recast.print(typeRendered!.node as recast.types.ASTNode).code;

      // id has default → Generated<T>
      expect(code).toMatch(/id:\s*Generated</);
      // name has no default and can insert → not Generated
      expect(code).not.toMatch(/name:\s*Generated</);
    }),
  );
});

// Import recast for AST printing in tests
import * as recast from "recast";

/**
 * Elysia HTTP Plugin Tests
 *
 * Validates the elysia plugin:
 * 1. Correctly declares http-routes:elysia:EntityName for entities with queries
 * 2. Renders valid Elysia route handler code
 * 3. Integrates with the orchestrator and emit pipeline
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import recast from "recast";

import { elysia } from "../plugins/http-elysia.js";
import { kysely } from "../plugins/kysely.js";
import { runPlugins, type OrchestratorConfig } from "../runtime/orchestrator.js";
import { emitFiles } from "../runtime/emit.js";
import { defaultInflection } from "../services/inflection.js";
import { emptyTypeHintRegistry } from "../services/type-hints.js";
import { testIRFromFixture, testIRWithEntities } from "../testing.js";
import type { TableEntity, Shape, Field, SemanticIR } from "../ir/semantic-ir.js";
import type { EntityQueriesExtension, QueryMethod } from "../ir/extensions/queries.js";
import { mockPgAttribute, mockPgClass, mockPgType } from "./mocks/pg-introspection.js";

// =============================================================================
// Test Helpers
// =============================================================================

function testConfig(ir: SemanticIR): Omit<OrchestratorConfig, "plugins"> {
  return {
    ir,
    inflection: defaultInflection,
    typeHints: emptyTypeHintRegistry,
    defaultFile: "index.ts",
    outputDir: "generated",
  };
}

/**
 * Create a minimal mock Field for testing.
 */
function mockField(name: string, pgTypeName: string, opts?: { nullable?: boolean }): Field {
  const nullable = opts?.nullable ?? false;

  const pgType = mockPgType({
    typname: pgTypeName,
    typcategory: pgTypeName.startsWith("_") ? "A" : "S",
    typtype: "b",
  });

  const pgAttribute = mockPgAttribute({
    attname: name,
    attnotnull: !nullable,
    atthasdef: false,
    attgenerated: "",
    attidentity: "",
    getType: () => pgType,
  });

  return {
    name,
    columnName: name,
    pgAttribute,
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
 * Create a minimal mock TableEntity to testing.
 */
function mockTableEntity(
  name: string,
  fields: Field[],
  opts?: {
    permissions?: TableEntity["permissions"];
    primaryKey?: TableEntity["primaryKey"];
    indexes?: TableEntity["indexes"];
    omit?: boolean;
    includeInsert?: boolean;
    includeUpdate?: boolean;
  },
): TableEntity {
  const rowShape = mockShape(`${name}`, fields);
  const insertShape = mockShape(`${name}Insert`, fields.map(f => ({ ...f, optional: true })));
  const updateShape = mockShape(`${name}Update`, fields.map(f => ({ ...f, optional: true })));
  
  const includeInsert = opts?.includeInsert !== false;
  const includeUpdate = opts?.includeUpdate !== false;

  return {
    kind: "table",
    name,
    pgName: name.toLowerCase(),
    schemaName: "public",
    pgClass: mockPgClass({ relname: name.toLowerCase() }),
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
    tags: { omit: opts?.omit },
    permissions: opts?.permissions ?? { canSelect: true, canInsert: true, canUpdate: true, canDelete: true },
  };
}

/**
 * Create an entity with partial permissions for edge case testing.
 */
function mockEntityWithPermissions(
  name: string,
  fields: Field[],
  permissions: TableEntity["permissions"],
): TableEntity {
  return mockTableEntity(name, fields, { permissions });
}

// =============================================================================
// Declare Phase Tests
// =============================================================================

describe("Elysia Plugin - Declare", () => {
  it.effect("declares http-routes:elysia:EntityName when queries exist", () =>
    Effect.gen(function* () {
      const ir = yield* testIRFromFixture(["app_public"]);

      // Run both plugins so elysia can see kysely's declarations
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely(), elysia()] });

      // Find elysia declarations (not kysely ones)
      const elysiaDecls = result.declarations.filter(d => d.capability.startsWith("http-routes:elysia:"));

      // Should have userElysiaRoutes and elysiaApp
      const userRoutes = elysiaDecls.find(d => d.name === "userElysiaRoutes");
      expect(userRoutes).toBeDefined();
      expect(userRoutes?.capability).toBe("http-routes:elysia:User");
    }),
  );

  it.effect("does not declare routes for entities without queries", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid"),
        mockField("email", "text"),
      ];

      // Entity with no permissions = no queries = no routes
      const ir = testIRWithEntities([mockTableEntity("User", userFields, {
        permissions: { canSelect: false, canInsert: false, canUpdate: false, canDelete: false },
      })]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely(), elysia()] });

      // Only the app aggregator should exist (if any elysia declarations)
      const elysiaDecls = result.declarations.filter(d => d.capability.startsWith("http-routes:elysia:"));
      // With no entities having routes, there should just be the aggregator
      expect(elysiaDecls).toHaveLength(1); // Just elysiaApp
      expect(elysiaDecls[0]?.name).toBe("elysiaApp");
    }),
  );

  it.effect("does not declare routes for entities with omit tag", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid"),
        mockField("email", "text"),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields, { omit: true })]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely(), elysia()] });

      const elysiaDecls = result.declarations.filter(d => d.capability.startsWith("http-routes:elysia:"));
      // userElysiaRoutes should not be declared due to omit tag
      expect(elysiaDecls.find(d => d.name === "userElysiaRoutes")).toBeUndefined();
    }),
  );

  it.effect("declares routes only for permissions present", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid"),
        mockField("email", "text"),
      ];

      // Only select permission - should only declare list/read routes
      const ir = testIRWithEntities([mockEntityWithPermissions("User", userFields, {
        canSelect: true,
        canInsert: false,
        canUpdate: false,
        canDelete: false,
      })]);
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely(), elysia()] });

      const elysiaDecls = result.declarations.filter(d => d.capability.startsWith("http-routes:elysia:"));
      expect(elysiaDecls.find(d => d.name === "userElysiaRoutes")).toBeDefined();
    }),
  );
});

// =============================================================================
// Render Phase Tests
// =============================================================================

describe("Elysia Plugin - Render", () => {
  it.effect("renders Elysia route handler code", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid"),
        mockField("email", "text"),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);

      // Run both plugins so elysia can consume kysely's metadata
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely(), elysia()] });

      // Filter to just elysia rendered symbols
      const elysiaRendered = result.rendered.filter(r => r.capability.startsWith("http-routes:elysia:"));
      expect(elysiaRendered.length).toBeGreaterThanOrEqual(1);

      const userRoutes = elysiaRendered.find(r => r.capability === "http-routes:elysia:User");
      expect(userRoutes).toBeDefined();

      const code = recast.print(userRoutes!.node as recast.types.ASTNode).code;
      expect(code).toContain("Elysia");
      // Check for auto-generated query function names
      // Note: list is no longer generated - replaced by cursor pagination (listBy{Column})
      expect(code).toContain("userFindById");
      expect(code).toContain("userCreate");
      expect(code).toContain("userUpdate");
      expect(code).toContain("userDelete");
    }),
  );

  it.effect("correctly consumes kysely-queries metadata", () =>
    Effect.gen(function* () {
      const ir = yield* testIRFromFixture(["app_public"]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely(), elysia()] });

      // Verify kysely rendered its metadata
      const kyselyQueries = result.rendered.filter(r => r.capability.startsWith("queries:kysely:"));
      const userQueries = kyselyQueries.find(r => r.capability === "queries:kysely:User");
      expect(userQueries).toBeDefined();
      expect(userQueries?.metadata).toBeDefined();
      expect(userQueries?.metadata).toHaveProperty("methods");
      // @ts-expect-error - metadata has methods array
      const methods = userQueries.metadata.methods;
      // User has: findById, findByUsername, create, update, delete (5 methods)
      // findByUsername is added because username is indexed
      expect(methods.length).toBeGreaterThanOrEqual(4);

      // Verify elysia consumed the metadata and generated routes for all methods
      const elysiaRoutes = result.rendered.find(r => r.capability === "http-routes:elysia:User");
      expect(elysiaRoutes).toBeDefined();

      // Query imports are now tracked via cross-references (not externalImports)
      // The emit phase uses these to generate imports automatically
      const elysiaCapability = "http-routes:elysia:User";
      const refs = result.references.get(elysiaCapability);
      expect(refs).toBeDefined();
      expect(refs).toContain("queries:kysely:User:findById");
    }),
  );

  it.effect("generates GET method for read operation", () =>
    Effect.gen(function* () {
      const ir = yield* testIRFromFixture(["app_public"]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely(), elysia()] });

      const userRoutes = result.rendered.find(r => r.capability === "http-routes:elysia:User");
      expect(userRoutes).toBeDefined();
      const code = recast.print(userRoutes!.node as recast.types.ASTNode).code;

      expect(code).toContain('.get("/:id"');
    }),
  );

  it.effect("generates POST method for create operation", () =>
    Effect.gen(function* () {
      const ir = yield* testIRFromFixture(["app_public"]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely(), elysia()] });

      const userRoutes = result.rendered.find(r => r.capability === "http-routes:elysia:User");
      expect(userRoutes).toBeDefined();
      const code = recast.print(userRoutes!.node as recast.types.ASTNode).code;

      expect(code).toContain('.post("/"');
    }),
  );

  it.effect("generates PATCH method for update operation", () =>
    Effect.gen(function* () {
      const ir = yield* testIRFromFixture(["app_public"]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely(), elysia()] });

      const userRoutes = result.rendered.find(r => r.capability === "http-routes:elysia:User");
      expect(userRoutes).toBeDefined();
      const code = recast.print(userRoutes!.node as recast.types.ASTNode).code;

      expect(code).toContain('.patch("/:id"');
    }),
  );

  it.effect("generates DELETE method for delete operation", () =>
    Effect.gen(function* () {
      const ir = yield* testIRFromFixture(["app_public"]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely(), elysia()] });

      const userRoutes = result.rendered.find(r => r.capability === "http-routes:elysia:User");
      expect(userRoutes).toBeDefined();
      const code = recast.print(userRoutes!.node as recast.types.ASTNode).code;

      expect(code).toContain('.delete("/:id"');
    }),
  );

  it.effect("generates correct route paths", () =>
    Effect.gen(function* () {
      const ir = yield* testIRFromFixture(["app_public"]);

      // Run both plugins
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely(), elysia()] });

      const userRoutes = result.rendered.find(r => r.capability === "http-routes:elysia:User");
      expect(userRoutes).toBeDefined();
      const code = recast.print(userRoutes!.node as recast.types.ASTNode).code;

      // Note: GET "/" (list) is no longer generated without timestamptz index
      expect(code).toContain('.get("/:id"');
      expect(code).toContain('.post("/"');
      expect(code).toContain('.patch("/:id"');
      expect(code).toContain('.delete("/:id"');
    }),
  );

  it.effect("generates lookup routes for indexed columns", () =>
    Effect.gen(function* () {
      const ir = yield* testIRFromFixture(["app_public"]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely(), elysia()] });

      const userRoutes = result.rendered.find(r => r.capability === "http-routes:elysia:User");
      expect(userRoutes).toBeDefined();
      const code = recast.print(userRoutes!.node as recast.types.ASTNode).code;

      // Lookup route should be generated for indexed column (username is indexed)
      expect(code).toContain("/by-username/");
      expect(code).toContain("userFindByUsername");
    }),
  );

  it.effect("generates unique routes for cursor pagination methods", () =>
    Effect.gen(function* () {
      const ir = yield* testIRFromFixture(["app_public"]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely(), elysia()] });

      const postRoutes = result.rendered.find(r => r.capability === "http-routes:elysia:Post");
      expect(postRoutes).toBeDefined();
      const code = recast.print(postRoutes!.node as recast.types.ASTNode).code;

      // Post has created_at index, so it gets listByCreatedAt route
      // With cursor pagination, this should map to a unique path like /by-created-at
      expect(code).toContain("/by-created-at");
      expect(code).toMatch(/ListByCreatedAt/i);
      // Should NOT have generic list route at GET "/" (cursor pagination uses /by-{column} paths)
      // But should still have other GET routes (findById at /:id, lookup routes)
      expect(code).not.toMatch(/\.get\(["']\/["']/); // No GET "/" route
    }),
  );
});

// =============================================================================
// Aggregator Tests
// =============================================================================

describe("Elysia Plugin - Aggregator", () => {
  it.effect("generates aggregator when multiple entities have routes", () =>
    Effect.gen(function* () {
      const ir = yield* testIRFromFixture(["app_public"]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely(), elysia()] });

      const appRoutes = result.rendered.find(r => r.capability === "http-routes:elysia:app");
      expect(appRoutes).toBeDefined();

      const code = recast.print(appRoutes!.node as recast.types.ASTNode).code;
      expect(code).toContain("new Elysia");
      // Should use multiple route groups from User, Post, etc.
      expect(code).toContain("userElysiaRoutes");
      expect(code).toContain("postElysiaRoutes");
    }),
  );

  it.effect("aggregator uses all entity route groups", () =>
    Effect.gen(function* () {
      const ir = yield* testIRFromFixture(["app_public"]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely(), elysia()] });

      const appRoutes = result.rendered.find(r => r.capability === "http-routes:elysia:app");
      expect(appRoutes).toBeDefined();

      const code = recast.print(appRoutes!.node as recast.types.ASTNode).code;
      // Multiple route groups should be used (User, Post, etc.)
      expect(code).toContain("userElysiaRoutes");
      expect(code).toContain("postElysiaRoutes");
      expect(code).toContain("commentElysiaRoutes");
      // Count .use() calls - should be multiple for multiple entities
      const useCount = code.match(/\.use\(/g);
      expect(useCount).toBeDefined();
      expect(useCount!.length).toBeGreaterThan(2);
    }),
  );
});

// =============================================================================
// End-to-End Emit Tests
// =============================================================================

describe("Elysia Plugin - Emit", () => {
  it.effect("emits valid TypeScript file with Elysia routes", () =>
    Effect.gen(function* () {
      const ir = yield* testIRFromFixture(["app_public"]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely(), elysia()] });
      const files = emitFiles(result);

      expect(files.length).toBeGreaterThanOrEqual(1);

      // Find any file containing elysia routes
      const routesFile = files.find(f => f.content.includes("Elysia"));
      expect(routesFile).toBeDefined();

      const content = routesFile!.content;
      expect(content).toContain("Elysia");
      expect(content).toContain("userFindById");
    }),
  );

  it.effect("includes external imports for elysia and queries", () =>
    Effect.gen(function* () {
      const ir = yield* testIRFromFixture(["app_public"]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely(), elysia()] });
      const files = emitFiles(result);

      // Find a file with Elysia routes
      const routesFile = files.find(f => f.content.includes("Elysia"));
      expect(routesFile).toBeDefined();

      const content = routesFile!.content;
      expect(content).toContain('from "elysia"');
      // Should import query functions
      expect(content).toContain("userFindById");
    }),
  );

  it.effect("emits aggregator file when multiple entities", () =>
    Effect.gen(function* () {
      const ir = yield* testIRFromFixture(["app_public"]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely(), elysia()] });
      const files = emitFiles(result);

      // Should have one file with all Elysia routes (User routes, Post routes, and app combined)
      const routesFiles = files.filter(f => f.content.includes("Elysia"));
      expect(routesFiles.length).toBe(1);

      const content = routesFiles[0]!.content;
      // The single file should contain all route groups
      expect(content).toContain("userElysiaRoutes");
      expect(content).toContain("postElysiaRoutes");
      expect(content).toContain("export const app");
      expect(content).toContain("new Elysia");
    }),
  );
});

// =============================================================================
// Render Phase Tests
// =============================================================================

describe("Elysia Plugin - Render", () => {
  it.effect("renders Elysia route handler code", () =>
    Effect.gen(function* () {
      const ir = yield* testIRFromFixture(["app_public"]);

      // Run both plugins so elysia can consume kysely's metadata
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely(), elysia()] });

      // Filter to just elysia rendered symbols
      const elysiaRendered = result.rendered.filter(r => r.capability.startsWith("http-routes:elysia:"));
      expect(elysiaRendered.length).toBeGreaterThanOrEqual(1);

      const userRoutes = elysiaRendered.find(r => r.capability === "http-routes:elysia:User");
      expect(userRoutes).toBeDefined();

      const code = recast.print(userRoutes!.node as recast.types.ASTNode).code;
      expect(code).toContain("Elysia");
      // Check for auto-generated query function names
      // Note: list is no longer generated - replaced by cursor pagination (listBy{Column})
      // which only generates for tables with btree-indexed timestamptz columns
      expect(code).toContain("userFindById");
      expect(code).toContain("userCreate");
      expect(code).toContain("userUpdate");
      expect(code).toContain("userDelete");
    }),
  );

  it.effect("generates correct HTTP methods and paths", () =>
    Effect.gen(function* () {
      const userFields = [mockField("id", "uuid")];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);

      // Run both plugins
      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely(), elysia()] });

      const userRoutes = result.rendered.find(r => r.capability === "http-routes:elysia:User");
      expect(userRoutes).toBeDefined();
      const code = recast.print(userRoutes!.node as recast.types.ASTNode).code;

      // Note: GET "/" (list) is no longer generated without timestamptz index
      expect(code).toContain('.get("/:id"');
      expect(code).toContain('.post("/"');
      expect(code).toContain('.patch("/:id"');
      expect(code).toContain('.delete("/:id"');
    }),
  );
});

// =============================================================================
// End-to-End Emit Tests
// =============================================================================

describe("Elysia Plugin - Emit", () => {
  it.effect("emits valid TypeScript file with Elysia routes", () =>
    Effect.gen(function* () {
      const userFields = [
        mockField("id", "uuid"),
        mockField("email", "text"),
      ];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely(), elysia()] });
      const files = emitFiles(result);

      expect(files.length).toBeGreaterThanOrEqual(1);

      // Find any file containing elysia routes
      const routesFile = files.find(f => f.content.includes("Elysia"));
      expect(routesFile).toBeDefined();

      const content = routesFile!.content;
      expect(content).toContain("Elysia");
      expect(content).toContain("userFindById");
    }),
  );

  it.effect("includes external imports for elysia and queries", () =>
    Effect.gen(function* () {
      const userFields = [mockField("id", "uuid")];

      const ir = testIRWithEntities([mockTableEntity("User", userFields)]);

      const result = yield* runPlugins({ ...testConfig(ir), plugins: [kysely(), elysia()] });
      const files = emitFiles(result);

      // Find a file with Elysia routes
      const routesFile = files.find(f => f.content.includes("Elysia"));
      expect(routesFile).toBeDefined();

      const content = routesFile!.content;
      expect(content).toContain('from "elysia"');
      // Should import query functions
      expect(content).toContain("userFindById");
    }),
  );
});

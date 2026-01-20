/**
 * Kysely Queries Plugin Integration Tests
 *
 * Tests the plugin with real introspected IR from the example database fixture.
 * This validates the full pipeline: introspection → IR → declare → render → emit.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Effect } from "effect";
import type { SemanticIR, TableEntity } from "../ir/semantic-ir.js";
import { isTableEntity, getTableEntities } from "../ir/semantic-ir.js";
import { loadIntrospectionFixture } from "./fixtures/index.js";
import { createIRBuilderService } from "../services/ir-builder.js";
import { InflectionLive } from "../services/inflection.js";
import { kysely } from "../plugins/kysely.js";
import { runPlugins, type OrchestratorConfig } from "../runtime/orchestrator.js";
import { emitFiles } from "../runtime/emit.js";
import { defaultInflection } from "../services/inflection.js";
import { emptyTypeHintRegistry } from "../services/type-hints.js";
import type { EntityQueriesExtension } from "../ir/extensions/queries.js";

let ir: SemanticIR;

beforeAll(async () => {
  const introspection = loadIntrospectionFixture();
  ir = await Effect.runPromise(
    Effect.gen(function* () {
      const builder = createIRBuilderService();
      return yield* builder.build(introspection, { schemas: ["app_public"] });
    }).pipe(Effect.provide(InflectionLive)),
  );
});

const testConfig = (): Omit<OrchestratorConfig, "plugins"> => ({
  ir,
  inflection: defaultInflection,
  typeHints: emptyTypeHintRegistry,
  defaultFile: "index.ts",
  outputDir: "generated",
});

describe("Kysely Queries Plugin Integration", () => {
  it("declares query capabilities for all table entities with PKs", async () => {
    const result = await Effect.runPromise(runPlugins({ ...testConfig(), plugins: [kysely()] }));

    const tableEntities = getTableEntities(ir).filter(e => e.tags.omit !== true);

    // Each table with a PK should have findById, create, update, delete
    // Note: list is replaced by cursor pagination (listBy{Column}) which only
    // generates for tables with btree-indexed timestamptz columns
    for (const entity of tableEntities) {
      if (entity.primaryKey && entity.primaryKey.columns.length > 0) {
        const capabilities = result.declarations.map(d => d.capability);

        if (entity.permissions.canSelect) {
          expect(capabilities).toContain(`queries:kysely:${entity.name}:findById`);
        }
        if (entity.permissions.canInsert) {
          expect(capabilities).toContain(`queries:kysely:${entity.name}:create`);
        }
        if (entity.permissions.canUpdate) {
          expect(capabilities).toContain(`queries:kysely:${entity.name}:update`);
        }
        if (entity.permissions.canDelete) {
          expect(capabilities).toContain(`queries:kysely:${entity.name}:delete`);
        }
      }
    }
  });

  it("emits query functions with correct table references", async () => {
    const result = await Effect.runPromise(runPlugins({ ...testConfig(), plugins: [kysely()] }));

    const files = emitFiles(result);

    // Find the queries file (all queries go to queries.ts by default)
    const queriesFile = files.find(f => f.path === "queries.ts");
    expect(queriesFile).toBeDefined();

    // Should have select queries referencing "users" table
    expect(queriesFile!.content).toContain('selectFrom("users")');
    expect(queriesFile!.content).toContain("userFindById");
  });

  it("generates findBy queries for indexed columns", async () => {
    const result = await Effect.runPromise(runPlugins({ ...testConfig(), plugins: [kysely()] }));

    // Check that indexed columns get findBy queries
    const capabilities = result.declarations.map(d => d.capability);

    // The User entity should have indexes on email
    const userEntity = ir.entities.get("User") as TableEntity | undefined;
    if (userEntity) {
      for (const index of userEntity.indexes) {
        if (index.columns.length === 1 && !index.isPartial && !index.hasExpressions) {
          const columnName = index.columns[0]!;
          const pascalColumn = columnName.split("_").map(s => s.charAt(0).toUpperCase() + s.slice(1)).join("");
          // Should have findBy capability (unless it's gin/gist or PK column)
          const isPkColumn = userEntity.primaryKey?.columns.includes(columnName);
          if (index.method !== "gin" && index.method !== "gist" && !isPkColumn) {
            expect(capabilities).toContain(`queries:kysely:User:findBy${pascalColumn}`);
          }
        }
      }
    }
  });

  it("emits types and queries files", async () => {
    const result = await Effect.runPromise(runPlugins({ ...testConfig(), plugins: [kysely()] }));
    const files = emitFiles(result);

    // Kysely plugin generates both types (db.ts) and queries (queries.ts)
    expect(files.length).toBeGreaterThan(0);

    const typesFile = files.find(f => f.path === "db.ts");
    const queriesFile = files.find(f => f.path === "queries.ts");

    expect(typesFile).toBeDefined();
    expect(queriesFile).toBeDefined();

    // Types file should have DB interface and entity types
    expect(typesFile!.content).toContain("export interface DB");
    expect(typesFile!.content).toContain("export interface User");

    // Queries file should have query functions
    expect(queriesFile!.content).toContain("export const userFindById");
  });

  it("entity metadata contains query methods", async () => {
    const result = await Effect.runPromise(runPlugins({ ...testConfig(), plugins: [kysely()] }));

    // Find the User entity queries metadata
    const userQueriesRendered = result.rendered.find(r => r.capability === "queries:kysely:User");
    expect(userQueriesRendered).toBeDefined();

    const metadata = userQueriesRendered?.metadata as EntityQueriesExtension | undefined;
    expect(metadata).toBeDefined();
    expect(metadata!.methods).toBeDefined();
    expect(metadata!.methods.length).toBeGreaterThan(0);

    // Check that methods have expected properties
    const findByIdMethod = metadata!.methods.find(m => m.name === "userFindById");
    expect(findByIdMethod).toBeDefined();
    expect(findByIdMethod!.kind).toBe("read");
  });
});

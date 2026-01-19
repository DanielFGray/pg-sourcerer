/**
 * Kysely Queries Plugin Integration Tests
 *
 * Tests the plugin with real introspected IR from the example database fixture.
 * This validates the full pipeline: introspection → IR → declare → render.
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

    // Each table with a PK should have findById, list, create, update, delete
    for (const entity of tableEntities) {
      if (entity.primaryKey && entity.primaryKey.columns.length > 0) {
        const capabilities = result.declarations.map(d => d.capability);

        if (entity.permissions.canSelect) {
          expect(capabilities).toContain(`queries:kysely:${entity.name}:findById`);
          expect(capabilities).toContain(`queries:kysely:${entity.name}:list`);
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

  it("renders SQL queries with correct table names", async () => {
    const result = await Effect.runPromise(runPlugins({ ...testConfig(), plugins: [kysely()] }));

    // Find User entity queries
    const userFindById = result.rendered.find(r => r.capability === "queries:kysely:User:findById");
    expect(userFindById).toBeDefined();

    // The query metadata should have the correct table name
    const metadata = userFindById?.metadata as { tableName: string; query?: { sql: string } };
    expect(metadata.tableName).toBe("users");

    // If query was built with hex, it should have SQL
    if (metadata.query) {
      expect(metadata.query.sql).toContain("users");
      expect(metadata.query.sql.toUpperCase()).toContain("SELECT");
    }
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
          // Should have findBy capability (unless it's gin/gist)
          if (index.method !== "gin" && index.method !== "gist") {
            expect(capabilities).toContain(`queries:kysely:User:findBy${pascalColumn}`);
          }
        }
      }
    }
  });

  it("does not emit files directly (provider-only pattern)", async () => {
    // Kysely queries plugin is a provider - it exposes query metadata for consumers
    // (like HTTP plugins) rather than emitting code directly
    const result = await Effect.runPromise(runPlugins({ ...testConfig(), plugins: [kysely()] }));
    const files = emitFiles(result);

    // No files emitted - queries are consumed by other plugins
    expect(files).toHaveLength(0);

    // But rendered symbols exist with metadata
    expect(result.rendered.length).toBeGreaterThan(0);
    for (const r of result.rendered) {
      expect(r.metadata).toBeDefined();
    }
  });

  it("query metadata contains operation type", async () => {
    const result = await Effect.runPromise(runPlugins({ ...testConfig(), plugins: [kysely()] }));

    for (const rendered of result.rendered) {
      const metadata = rendered.metadata as { kind: string; operation: string };
      expect(metadata.kind).toBeDefined();
      expect(["select", "insert", "update", "delete"]).toContain(metadata.kind);
      expect(metadata.operation).toBeDefined();
    }
  });
});

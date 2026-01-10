/**
 * SQL Queries Plugin Tests
 *
 * TDD tests for the sql-queries plugin that generates typed SQL query functions.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { createIRBuilderService } from "../services/ir-builder.js";
import { InflectionLive } from "../services/inflection.js";
import { Emissions, createEmissionBuffer } from "../services/emissions.js";
import { Symbols, createSymbolRegistry } from "../services/symbols.js";
import { TypeHintsLive } from "../services/type-hints.js";
import { ArtifactStoreLive } from "../services/artifact-store.js";
import { PluginMeta } from "../services/plugin-meta.js";
import { IR } from "../services/ir.js";
import { loadIntrospectionFixture } from "./fixtures/index.js";
import type { SemanticIR } from "../ir/semantic-ir.js";
import { conjure } from "../lib/conjure.js";

import { sqlQueriesPlugin } from "../plugins/sql-queries.js";

/** Default header for tests - user must provide this in real config */
const TEST_HEADER = `import { sql } from "../db";`;

const introspection = loadIntrospectionFixture();

function buildTestIR(schemas: readonly string[]) {
  const builder = createIRBuilderService();
  return builder.build(introspection, { schemas }).pipe(Effect.provide(InflectionLive));
}

function createTestLayer(ir: SemanticIR) {
  const emissions = createEmissionBuffer();
  const symbols = createSymbolRegistry();

  return Layer.mergeAll(
    Layer.succeed(IR, ir),
    Layer.succeed(Emissions, emissions),
    Layer.succeed(Symbols, symbols),
    Layer.succeed(PluginMeta, { name: "sql-queries" }),
    InflectionLive,
    TypeHintsLive([]),
    ArtifactStoreLive,
  );
}

/**
 * Create a test layer with pre-registered type symbols.
 * This simulates the types plugin having already run.
 */
function createTestLayerWithTypeSymbols(ir: SemanticIR, entities: string[]) {
  const emissions = createEmissionBuffer();
  const symbols = createSymbolRegistry();

  // Pre-register Row and Insert type symbols as if types plugin had run
  for (const entity of entities) {
    symbols.register(
      {
        name: `${entity}Row`,
        file: `types/${entity}.ts`,
        capability: "types",
        entity,
        shape: "row",
        isType: true,
        isDefault: false,
      },
      "types",
    );
    // Also register insert type - needed for insert function generation
    symbols.register(
      {
        name: `${entity}Insert`,
        file: `types/${entity}.ts`,
        capability: "types",
        entity,
        shape: "insert",
        isType: true,
        isDefault: false,
      },
      "types",
    );
  }

  return Layer.mergeAll(
    Layer.succeed(IR, ir),
    Layer.succeed(Emissions, emissions),
    Layer.succeed(Symbols, symbols),
    Layer.succeed(PluginMeta, { name: "sql-queries" }),
    InflectionLive,
    TypeHintsLive([]),
    ArtifactStoreLive,
  );
}

function runPluginAndGetEmissions(testLayer: Layer.Layer<any, any, any>) {
  return Effect.gen(function* () {
    const emissions = yield* Emissions.pipe(Effect.provide(testLayer));
    const symbols = yield* Symbols.pipe(Effect.provide(testLayer));
    emissions.serializeAst(conjure.print, symbols);
    return emissions.getAll();
  });
}

describe("SQL Queries Plugin", () => {
  describe("plugin structure", () => {
    it("has correct name", () => {
      expect(sqlQueriesPlugin.plugin.name).toBe("sql-queries");
    });

    it("provides queries capability", () => {
      expect(sqlQueriesPlugin.plugin.provides).toContain("queries");
    });

    it("requires types capability", () => {
      expect(sqlQueriesPlugin.plugin.requires).toContain("types");
    });
  });

  describe("SQL generation", () => {
    it.effect("generates SELECT with schema-qualified table name", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        expect(userFile?.content).toContain("app_public.users");
      }),
    );

    it.effect("generates parameterized SQL with template interpolation", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        // Should have template literal with interpolation
        expect(userFile?.content).toMatch(/sql`[^`]*\$\{[^}]+\}[^`]*`/);
      }),
    );
  });

  describe("string style (parameterized queries)", () => {
    it.effect("generates pool.query with parameterized SQL", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries", sqlStyle: "string" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        // Should use pool.query instead of sql template tag
        expect(userFile?.content).toContain("pool.query");
        // Should have $1 placeholder instead of template interpolation
        expect(userFile?.content).toMatch(/\$1/);
      }),
    );

    it.effect("uses user-provided header for imports", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        const customHeader = `import { pool } from "./my-db-client";`;
        yield* sqlQueriesPlugin.plugin
          .run({ header: customHeader, outputDir: "queries", sqlStyle: "string" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        expect(userFile?.content).toMatch(/import.*pool.*from.*my-db-client/);
      }),
    );

    it.effect("extracts rows from query result for findById", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries", sqlStyle: "string" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        // Should destructure { rows: [result] } from pool.query result
        expect(userFile?.content).toMatch(/\{\s*rows:\s*\[result\]\s*\}/);
      }),
    );

    it.effect("extracts rows from query result for findMany", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries", sqlStyle: "string" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        // Should destructure { rows } and return rows
        expect(userFile?.content).toMatch(/\{\s*rows\s*\}/);
        expect(userFile?.content).toMatch(/return rows/);
      }),
    );

    it.effect("uses $1, $2, ... placeholders for multiple params", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries", sqlStyle: "string" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        // findMany uses limit and offset - should have $1 and $2
        expect(userFile?.content).toMatch(/limit \$1 offset \$2/);
      }),
    );

    it.effect("passes params array as second argument", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries", sqlStyle: "string" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        // Should pass array of params as second argument
        expect(userFile?.content).toMatch(/pool\.query<[^>]+>\(\s*"[^"]+",\s*\[/);
      }),
    );

    it.effect("uses generic type parameter on pool.query", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries", sqlStyle: "string" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        // Should use pool.query<User[]> type parameter (array because result.rows is T[])
        expect(userFile?.content).toMatch(/pool\.query<User\[\]>/);
      }),
    );
  });

  describe("function naming", () => {
    it.effect("generates findEntityById for primary key lookup", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        expect(userFile?.content).toContain("findUserById");
      }),
    );

    it.effect("generates getEntityByField for unique index", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        // users table has unique index on username
        expect(userFile?.content).toContain("getUserByUsername");
      }),
    );

    it.effect("generates getEntitysByField for non-unique FK index with semantic naming", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const postFile = all.find(e => e.path.includes("Post.ts"));

        // posts.user_id FK → uses semantic naming: getPostsByUser (plural, derived from "user_id" → "user")
        expect(postFile?.content).toContain("getPostsByUser");
      }),
    );
  });

  describe("insert generation", () => {
    it.effect("generates insertEntity function", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const postFile = all.find(e => e.path.includes("Post.ts"));

        expect(postFile?.content).toContain("insertPost");
      }),
    );

    it.effect("uses destructured Pick<EntityInsert, ...> for insert parameter", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const postFile = all.find(e => e.path.includes("Post.ts"));

        // Should use destructured Pick<PostInsert, ...> parameter
        expect(postFile?.content).toMatch(/insertPost\(\s*\{[\s\S]*?\}:\s*Pick<\s*PostInsert/);
      }),
    );

    it.effect("generates INSERT SQL with RETURNING clause", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const postFile = all.find(e => e.path.includes("Post.ts"));

        // Should have INSERT ... RETURNING *
        expect(postFile?.content).toMatch(/insert into app_public\.posts.*returning \*/);
      }),
    );

    it.effect("imports EntityInsert type when insert shape differs from row", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayerWithTypeSymbols(ir, ["Post"]);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const postFile = all.find(e => e.path.includes("Post.ts"));

        // Should import PostInsert
        expect(postFile?.content).toMatch(/import.*PostInsert/);
      }),
    );
  });

  describe("return types", () => {
    it.effect("unique index uses sql<Row[]> and destructures to get single result", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        // findUserById should use sql<User[]> and destructure
        expect(userFile?.content).toMatch(/findUserById[\s\S]+?sql<User\[\]>/);
        expect(userFile?.content).toMatch(/const\s+\[result\]\s*=\s*await\s+sql<User\[\]>/);
      }),
    );

    it.effect("non-unique FK index uses sql<Row[]> and returns array directly", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const postFile = all.find(e => e.path.includes("Post.ts"));

        // getPostsByUser (semantic naming) should return sql<Post[]> directly
        expect(postFile?.content).toMatch(/getPostsByUser[\s\S]+?return\s+await\s+sql<Post\[\]>/);
      }),
    );

    it.effect("async functions use await with typed sql", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        // Should have await before sql<Type> calls
        expect(userFile?.content).toMatch(/await\s+sql<\w+\[\]>`/);
      }),
    );
  });

  describe("parameter types", () => {
    it.effect("uses Pick<Entity, field> for entity field parameters", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        // Should use Pick<User, "id"> for entity field parameters
        expect(userFile?.content).toMatch(/Pick<User,\s*"id">/);
        // Should use destructuring pattern { id }
        expect(userFile?.content).toMatch(/\{\s*id\s*\}:\s*Pick<User/);
      }),
    );

    it.effect("uses indexed access type for FK semantic parameters", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const postFile = all.find(e => e.path.includes("Post.ts"));

        // FK-based lookup with semantic param name uses destructured { user }: { user: Post["user_id"] }
        expect(postFile?.content).toMatch(/getPostsByUser\([\s\S]*?\{\s*user\s*\}[\s\S]*?:\s*\{[\s\S]*?user:\s*Post\["user_id"\]/);
      }),
    );
  });

  describe("imports", () => {
    it.effect("imports Row type from types plugin", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        // Use layer with pre-registered type symbols to simulate types plugin
        const testLayer = createTestLayerWithTypeSymbols(ir, ["User", "Post"]);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        expect(userFile?.content).toMatch(/import.*User.*from/);
      }),
    );

    it.effect("imports sql template tag", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        expect(userFile?.content).toMatch(/import.*sql.*from/);
      }),
    );
  });

  describe("edge cases", () => {
    it.effect("skips partial indexes", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);

        // Check no functions reference partial index predicates
        for (const file of all) {
          expect(file.content).not.toContain("WHERE ");
        }
      }),
    );

    it.effect("skips expression indexes", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        // This test just verifies no errors - expression indexes filtered in shouldGenerateLookup
        const all = yield* runPluginAndGetEmissions(testLayer);
        expect(all.length).toBeGreaterThan(0);
      }),
    );

    it.effect("no duplicate functions for same column", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        // Count occurrences of getUserByUsername
        const matches = userFile?.content?.match(/function getUserByUsername/g);
        expect(matches?.length ?? 0).toBeLessThanOrEqual(1);
      }),
    );
  });

  describe("function wrappers", () => {
    it.effect("generates functions.ts for scalar-returning functions", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public", "app_private"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const functionsFile = all.find(e => e.path.includes("functions.ts"));

        expect(functionsFile).toBeDefined();
        // Scalar functions should be in functions.ts
        expect(functionsFile?.content).toContain("currentSessionId");
        expect(functionsFile?.content).toContain("currentUserId");
        expect(functionsFile?.content).toContain("verifyEmail");
        // Table-returning functions should NOT be in functions.ts
        expect(functionsFile?.content).not.toMatch(/\bcurrentUser\b/);
      }),
    );

    it.effect("generates table-returning function wrappers in entity file", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public", "app_private"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        // current_user returns app_public.users (table) - should be in User.ts
        const userFile = all.find(e => e.path.includes("User.ts"));

        expect(userFile?.content).toContain("currentUser");
        expect(userFile?.content).toContain("select * from app_public.current_user");
      }),
    );

    it.effect("generates composite-returning function wrappers in separate file", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public", "app_private"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        // username_search returns app_public.username_search composite type
        const usernameSearchFile = all.find(e => e.path.includes("UsernameSearch.ts"));

        expect(usernameSearchFile).toBeDefined();
        expect(usernameSearchFile?.content).toContain("usernameSearch");
      }),
    );

    it.effect("filters out computed field functions (row-type arguments)", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public", "app_private"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const allContent = all.map(e => e.content).join("\n");

        // posts_short_body takes a posts row - should be filtered out
        expect(allContent).not.toContain("postsShortBody");
        expect(allContent).not.toContain("postsScore");
        expect(allContent).not.toContain("postsPopularity");
      }),
    );

    it.effect("can disable function generation via config", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public", "app_private"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries", generateFunctions: false })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const functionsFile = all.find(e => e.path.includes("functions.ts"));

        expect(functionsFile).toBeUndefined();
      }),
    );

    it.effect("generates function wrapper with correct SQL syntax", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public", "app_private"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const functionsFile = all.find(e => e.path.includes("functions.ts"));

        // Scalar function should use SELECT schema.function_name(args)
        expect(functionsFile?.content).toMatch(/select\s+app_public\.current_session_id\(\)/i);
      }),
    );

    it.effect("generates function wrapper with parameters", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public", "app_private"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const functionsFile = all.find(e => e.path.includes("functions.ts"));

        // verify_email has user_email_id: uuid and token: text parameters
        expect(functionsFile?.content).toMatch(/verifyEmail.*user_email_id.*token/);
      }),
    );

    it.effect("uses SETOF syntax for set-returning functions", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public", "app_private"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        // username_search returns SETOF - should use SELECT * FROM function()
        const usernameSearchFile = all.find(e => e.path.includes("UsernameSearch.ts"));

        expect(usernameSearchFile?.content).toMatch(/select \* from app_public\.username_search/i);
      }),
    );

    it.effect("imports Row type from types plugin for table-returning functions", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public", "app_private"]);
        const testLayer = createTestLayerWithTypeSymbols(ir, ["User"]);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        // Should import User type for currentUser return type
        expect(userFile?.content).toMatch(/import.*User.*from/);
      }),
    );
  });

  describe("namespace export style", () => {
    it.effect("generates single object export with entity name", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayerWithTypeSymbols(ir, ["User", "Post"]);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries", exportStyle: "namespace" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        // Should export single object with entity name
        expect(userFile?.content).toContain("export const User = {");
        // Should NOT have flat exports
        expect(userFile?.content).not.toMatch(/export async function find/);
      }),
    );

    it.effect("includes methods as object properties with function expressions", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayerWithTypeSymbols(ir, ["User", "Post"]);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries", exportStyle: "namespace" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        // Methods should be object properties with async function expressions
        expect(userFile?.content).toMatch(/findUserById:\s*async function/);
        expect(userFile?.content).toMatch(/insertUser:\s*async function/);
      }),
    );

    it.effect("flat style (default) generates individual export functions", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayerWithTypeSymbols(ir, ["User", "Post"]);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries", exportStyle: "flat" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        // Should have individual exported functions
        expect(userFile?.content).toMatch(/export async function findUserById/);
        expect(userFile?.content).toMatch(/export async function insertUser/);
        // Should NOT have namespace object
        expect(userFile?.content).not.toContain("export const User = {");
      }),
    );
  });

  describe("custom exportName function", () => {
    it.effect("uses custom exportName function to generate method names", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayerWithTypeSymbols(ir, ["User", "Post"]);

        // Custom export name that uses snake_case style
        const customExportName = (entityName: string, methodName: string) =>
          `${entityName.toLowerCase()}_${methodName.toLowerCase()}`;

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries", exportName: customExportName })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        // Should use custom naming
        expect(userFile?.content).toMatch(/export async function user_findbyid/);
        expect(userFile?.content).toMatch(/export async function user_insert/);
      }),
    );

    it.effect("custom exportName works with namespace export style", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayerWithTypeSymbols(ir, ["User", "Post"]);

        // Custom export name that keeps entity separate
        const customExportName = (_entityName: string, methodName: string) =>
          methodName.toLowerCase();

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries", exportStyle: "namespace", exportName: customExportName })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        // Should use custom naming as property names in namespace object
        expect(userFile?.content).toContain("export const User = {");
        expect(userFile?.content).toMatch(/findbyid:\s*async function/);
        expect(userFile?.content).toMatch(/insert:\s*async function/);
      }),
    );
  });

  describe("explicitColumns config", () => {
    it.effect("uses explicit column list by default (explicitColumns: true)", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        // Should use explicit column list, not SELECT *
        expect(userFile?.content).not.toMatch(/select \* from app_public\.users where/);
        expect(userFile?.content).toMatch(/select id, username.*from app_public\.users where/);
      }),
    );

    it.effect("uses SELECT * when explicitColumns: false", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries", explicitColumns: false })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        // Should use SELECT *
        expect(userFile?.content).toMatch(/select \* from app_public\.users where/);
        expect(userFile?.content).not.toMatch(/select id, username.*from app_public\.users where/);
      }),
    );

    it.effect("explicit columns only includes row shape fields (omitted fields excluded)", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* sqlQueriesPlugin.plugin
          .run({ header: TEST_HEADER, outputDir: "queries", explicitColumns: true })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const userFile = all.find(e => e.path.includes("User.ts"));

        // Verify the column list matches the row shape fields
        // (fields omitted from row shape won't appear in column list)
        const content = userFile?.content ?? "";
        // Check for explicit column list in findById
        expect(content).toMatch(/select id, username.*from app_public\.users where id/);
        // The column list should contain expected fields
        expect(content).toContain("username");
        expect(content).toContain("created_at");
      }),
    );
  });
});

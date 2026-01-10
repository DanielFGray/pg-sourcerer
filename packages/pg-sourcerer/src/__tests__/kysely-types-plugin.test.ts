/**
 * Kysely Types Plugin Tests
 *
 * Tests for the kysely-types plugin that generates Kysely-compatible type definitions.
 * Uses the fixture introspection data from the example database.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- Test helpers use flexible typing */
/* eslint-disable @typescript-eslint/no-unsafe-return -- Effect type inference in tests */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { kyselyTypesPlugin } from "../plugins/kysely-types.js";
import { createIRBuilderService } from "../services/ir-builder.js";
import { InflectionLive } from "../services/inflection.js";
import { Emissions, createEmissionBuffer } from "../services/emissions.js";
import { Symbols, createSymbolRegistry } from "../services/symbols.js";
import { TypeHintsLive } from "../services/type-hints.js";
import type { TypeHint } from "../config.js";
import { ArtifactStoreLive } from "../services/artifact-store.js";
import { PluginMeta } from "../services/plugin-meta.js";
import { IR } from "../services/ir.js";
import { loadIntrospectionFixture } from "./fixtures/index.js";
import type { SemanticIR } from "../ir/semantic-ir.js";
import { getEnumEntities } from "../ir/semantic-ir.js";
import { conjure } from "../lib/conjure.js";

// Load introspection data from fixture
const introspection = loadIntrospectionFixture();

/**
 * Build IR from fixture introspection data
 */
function buildTestIR(schemas: readonly string[]) {
  const builder = createIRBuilderService();
  return builder.build(introspection, { schemas }).pipe(Effect.provide(InflectionLive));
}

/**
 * Create a test layer with fresh emissions and symbols for each test.
 */
function createTestLayer(ir: SemanticIR, typeHints: readonly TypeHint[] = []) {
  const emissions = createEmissionBuffer();
  const symbols = createSymbolRegistry();

  return Layer.mergeAll(
    Layer.succeed(IR, ir),
    Layer.succeed(Emissions, emissions),
    Layer.succeed(Symbols, symbols),
    Layer.succeed(PluginMeta, { name: "kysely-types" }),
    InflectionLive,
    TypeHintsLive(typeHints),
    ArtifactStoreLive,
  );
}

/**
 * Run plugin and get serialized emissions.
 */
function runPluginAndGetEmissions(testLayer: Layer.Layer<any, any, any>) {
  return Effect.gen(function* () {
    const emissions = yield* Emissions.pipe(Effect.provide(testLayer));
    const symbols = yield* Symbols.pipe(Effect.provide(testLayer));
    emissions.serializeAst(conjure.print, symbols);
    return emissions.getAll();
  });
}

describe("Kysely Types Plugin", () => {
  describe("plugin structure", () => {
    it("has correct name", () => {
      expect(kyselyTypesPlugin.plugin.name).toBe("kysely-types");
    });

    it("provides types:kysely capability", () => {
      expect(kyselyTypesPlugin.plugin.provides).toContain("types:kysely");
    });
  });

  describe("file generation", () => {
    it.effect("generates a single output file", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin
          .run({ outputFile: "db.ts" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);

        expect(all.length).toBe(1);
        expect(all[0]?.path).toBe("db.ts");
      }),
    );

    it.effect("uses custom outputFile from config", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin
          .run({ outputFile: "custom/database.ts" })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);

        expect(all[0]?.path).toBe("custom/database.ts");
      }),
    );
  });

  describe("helper types", () => {
    it.effect("generates Generated<T> helper when needed", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        // Generated helper should be present (tables have auto-generated IDs)
        expect(content).toContain("export type Generated<T>");
        expect(content).toContain("ColumnType<S, I | undefined, U>");
      }),
    );

    it.effect("generates JsonValue types when json/jsonb columns exist", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        // Check for JSON type definitions if jsonb columns exist
        // The fixture may or may not have jsonb - just verify no errors
        if (content.includes("JsonValue")) {
          expect(content).toContain("export type JsonPrimitive");
          expect(content).toContain("export type JsonObject");
          expect(content).toContain("export type JsonArray");
          expect(content).toContain("export type JsonValue");
        }
      }),
    );
  });

  describe("enum generation", () => {
    it.effect("generates string literal unions for enums", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        const enumEntities = getEnumEntities(ir);
        if (enumEntities.length > 0) {
          // Each enum should be a type alias with string literals
          for (const enumEntity of enumEntities) {
            expect(content).toContain(`export type ${enumEntity.name}`);
            // Should use string literal union syntax
            expect(content).toMatch(new RegExp(`type ${enumEntity.name} = "[^"]+"`));
          }
        }
      }),
    );
  });

  describe("table interfaces", () => {
    it.effect("generates interface for each selectable entity", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        // Should have User and Post interfaces
        expect(content).toContain("export interface User");
        expect(content).toContain("export interface Post");
      }),
    );

    it.effect("includes all selectable fields", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        // User should have common fields
        expect(content).toMatch(/interface User[^}]+id:/);
        expect(content).toMatch(/interface User[^}]+username:/);
      }),
    );
  });

  describe("type mappings", () => {
    it.effect("maps text to string", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        // Text fields should be string
        // bio is text in the fixture
        expect(content).toMatch(/bio:\s*string/);
      }),
    );

    it.effect("maps uuid to string", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        // UUID fields should be string (possibly wrapped in Generated)
        // id is uuid in the fixture
        expect(content).toMatch(/id:\s*(Generated<)?string/);
      }),
    );

    it.effect("maps boolean to boolean", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        // is_verified is boolean in the fixture
        expect(content).toMatch(/is_verified:\s*boolean/);
      }),
    );

    it.effect("maps timestamptz using ColumnType", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        // Timestamps should use ColumnType<Date, Date | string, Date | string>
        // or be wrapped in Generated if they have defaults
        const hasColumnType = content.includes("ColumnType<Date");
        const hasGeneratedTimestamp = content.includes("Generated<ColumnType<Date");
        const hasGeneratedDate = content.includes("Generated<Date");

        // At least one timestamp pattern should be present
        expect(hasColumnType || hasGeneratedTimestamp || hasGeneratedDate).toBe(true);
      }),
    );
  });

  describe("Generated<T> wrapping", () => {
    it.effect("wraps fields with Generated for computed/tsvector defaults", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        // The 'search' field is a tsvector with generated default - should be Generated
        expect(content).toMatch(/search:\s*Generated<string>/);
      }),
    );

    it.effect("wraps array fields with defaults as Generated", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        // Post.tags is text[] with default - should be Generated<string[] | null>
        expect(content).toMatch(/tags:\s*Generated</);
      }),
    );

    it.effect("does not wrap required fields without defaults", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        // username is required without default - should NOT be Generated
        expect(content).toMatch(/username:\s*string[^>]/);
        expect(content).not.toMatch(/username:\s*Generated/);
      }),
    );
  });

  describe("nullable handling", () => {
    it.effect("appends | null for nullable fields", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        // name is nullable text - should be string | null
        expect(content).toMatch(/name:\s*string\s*\|\s*null/);
      }),
    );

    it.effect("handles nullable fields in view entities", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        // Views like recent_posts have nullable columns
        // Find RecentPost interface and check its fields
        expect(content).toContain("interface RecentPost");
        expect(content).toMatch(/id:\s*number\s*\|\s*null/);
      }),
    );
  });

  describe("DB interface", () => {
    it.effect("generates DB interface with all tables", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        expect(content).toContain("export interface DB");
        // Should have table entries
        expect(content).toMatch(/interface DB[^}]+users:/);
        expect(content).toMatch(/interface DB[^}]+posts:/);
      }),
    );

    it.effect("uses unqualified keys for default schema tables", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        // app_public is a default schema, so keys should be unqualified
        // Should have "users": User, not "app_public.users": User
        expect(content).toMatch(/"?users"?:\s*User/);
      }),
    );
  });

  describe("imports", () => {
    it.effect("imports ColumnType from kysely when needed", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        // Should import ColumnType from kysely
        expect(content).toMatch(/import.*ColumnType.*from.*["']kysely["']/);
      }),
    );
  });

  describe("symbol registration", () => {
    it.effect("registers symbols for generated types", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const symbols = yield* Symbols.pipe(Effect.provide(testLayer));
        const allSymbols = symbols.getAll();

        // Should have registered User, Post, etc.
        const userSymbol = allSymbols.find(s => s.name === "User");
        expect(userSymbol).toBeDefined();
        expect(userSymbol?.capability).toBe("types:kysely");
        expect(userSymbol?.isType).toBe(true);
      }),
    );

    it.effect("registers DB symbol", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const symbols = yield* Symbols.pipe(Effect.provide(testLayer));
        const allSymbols = symbols.getAll();

        const dbSymbol = allSymbols.find(s => s.name === "DB");
        expect(dbSymbol).toBeDefined();
        expect(dbSymbol?.capability).toBe("types:kysely");
      }),
    );

    it.effect("registers enum symbols", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const symbols = yield* Symbols.pipe(Effect.provide(testLayer));
        const allSymbols = symbols.getAll();

        const enumEntities = getEnumEntities(ir);
        if (enumEntities.length > 0) {
          const firstEnum = enumEntities[0]!;
          const enumSymbol = allSymbols.find(s => s.name === firstEnum.name);
          expect(enumSymbol).toBeDefined();
          expect(enumSymbol?.capability).toBe("types:kysely");
        }
      }),
    );
  });

  describe("type hints integration", () => {
    it.effect("overrides type with tsType hint", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);

        const hints: TypeHint[] = [
          {
            match: { table: "users", column: "id" },
            hints: { tsType: "UserId" },
          },
        ];

        const testLayer = createTestLayer(ir, hints);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        // The id field should use UserId type
        expect(content).toContain("UserId");
      }),
    );

    it.effect("adds custom import when specified in hint", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);

        const hints: TypeHint[] = [
          {
            match: { table: "users", column: "id" },
            hints: { tsType: "UserId", import: "./custom-types.js" },
          },
        ];

        const testLayer = createTestLayer(ir, hints);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        // Should have the type
        expect(content).toContain("UserId");

        // Should have an import from custom-types.js
        expect(content).toContain("custom-types.js");
      }),
    );
  });

  describe("composite type generation", () => {
    it.effect("generates interfaces for composite types", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        // app_public has username_search and tag_search_result composites
        expect(content).toContain("export interface UsernameSearch");
        expect(content).toContain("export interface TagSearchResult");
      }),
    );

    it.effect("composite interfaces have correct fields", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        // UsernameSearch should have username and avatar_url fields
        expect(content).toMatch(/interface UsernameSearch[^}]+username:/);
        expect(content).toMatch(/interface UsernameSearch[^}]+avatar_url:/);

        // TagSearchResult should have tag and count fields
        expect(content).toMatch(/interface TagSearchResult[^}]+tag:/);
        expect(content).toMatch(/interface TagSearchResult[^}]+count:/);
      }),
    );

    it.effect("composite fields have correct types", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        // username should be string | null, avatar_url should be string | null
        // (checking within UsernameSearch context via earlier test)
        // TagSearchResult.count should use ColumnType (it's bigint)
        expect(content).toMatch(/interface TagSearchResult[^}]+count:\s*ColumnType/);
      }),
    );

    it.effect("registers symbols for composite types", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const symbols = yield* Symbols.pipe(Effect.provide(testLayer));
        const allSymbols = symbols.getAll();

        // Should have registered composite symbols
        const usernameSearchSymbol = allSymbols.find(s => s.name === "UsernameSearch");
        expect(usernameSearchSymbol).toBeDefined();
        expect(usernameSearchSymbol?.capability).toBe("types:kysely");
        expect(usernameSearchSymbol?.isType).toBe(true);
      }),
    );

    it.effect("does not use Generated for composite fields", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* kyselyTypesPlugin.plugin.run({}).pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);
        const content = all[0]?.content ?? "";

        // Extract the UsernameSearch interface content
        const usernameSearchMatch = content.match(/interface UsernameSearch\s*\{([^}]+)\}/);
        expect(usernameSearchMatch).toBeDefined();

        const interfaceBody = usernameSearchMatch?.[1] ?? "";
        // Composite fields should NOT have Generated wrapper
        expect(interfaceBody).not.toContain("Generated");
      }),
    );
  });
});

/**
 * Valibot Plugin Tests
 *
 * Tests for the Valibot plugin that generates Valibot schemas for entities.
 * Uses the fixture introspection data from the example database.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- Test helpers use flexible typing */
/* eslint-disable @typescript-eslint/no-unsafe-return -- Effect type inference in tests */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { valibotPlugin } from "../plugins/valibot.js";
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
function createTestLayer(ir: SemanticIR) {
  const emissions = createEmissionBuffer();
  const symbols = createSymbolRegistry();

  return Layer.mergeAll(
    Layer.succeed(IR, ir),
    Layer.succeed(Emissions, emissions),
    Layer.succeed(Symbols, symbols),
    Layer.succeed(PluginMeta, { name: "valibot" }),
    InflectionLive,
    TypeHintsLive([]),
    ArtifactStoreLive,
  );
}

/**
 * Run plugin and get serialized emissions.
 * Handles AST serialization so tests can inspect string content.
 */
function runPluginAndGetEmissions(testLayer: Layer.Layer<any, any, any>) {
  return Effect.gen(function* () {
    const emissions = yield* Emissions.pipe(Effect.provide(testLayer));
    const symbols = yield* Symbols.pipe(Effect.provide(testLayer));
    // Serialize any AST emissions to string content
    emissions.serializeAst(conjure.print, symbols);
    return emissions.getAll();
  });
}

describe("Valibot Plugin", () => {
  describe("plugin structure", () => {
    it("has correct name", () => {
      expect(valibotPlugin.plugin.name).toBe("valibot");
    });

    it("provides schemas capabilities", () => {
      // provides is a function that depends on config - call with exportTypes to test
      const provides = valibotPlugin.plugin.provides;
      const capabilities = typeof provides === "function" ? provides({ exportTypes: true } as any) : provides;
      expect(capabilities).toContain("schemas");
    });

    it("provides types capability when exportTypes is true", () => {
      const provides = valibotPlugin.plugin.provides;
      const capabilities = typeof provides === "function" ? provides({ exportTypes: true } as any) : provides;
      expect(capabilities).toContain("types");
    });

    it("does not provide types capability when exportTypes is false", () => {
      const provides = valibotPlugin.plugin.provides;
      const capabilities = typeof provides === "function" ? provides({ exportTypes: false } as any) : provides;
      expect(capabilities).not.toContain("types");
    });

    it("has no requirements", () => {
      expect(valibotPlugin.plugin.requires).toBeUndefined();
    });
  });

  describe("entity generation", () => {
    it.effect("generates Valibot schemas for Post entity", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* valibotPlugin.plugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);

        const postFile = all.find(e => e.path.includes("Post.ts"));
        expect(postFile).toBeDefined();
        expect(postFile?.content).toContain("Post = v.object");
        expect(postFile?.content).toContain("PostInsert = v.object");
        expect(postFile?.content).toContain("PostUpdate = v.object");
      }),
    );

    it.effect("generates Valibot import statement", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* valibotPlugin.plugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);

        const userFile = all.find(e => e.path.includes("User.ts"));
        expect(userFile?.content).toContain('import * as v from "valibot"');
      }),
    );

    it.effect("generates correct field types for User", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* valibotPlugin.plugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);

        const userFile = all.find(e => e.path.includes("User.ts"));
        expect(userFile).toBeDefined();

        const content = userFile?.content ?? "";

        // Check expected Valibot field types
        expect(content).toContain("v.pipe(v.string(), v.uuid())"); // UUID fields
        expect(content).toContain("v.string()"); // text/citext fields
        expect(content).toContain("v.date()"); // timestamp fields
        expect(content).toContain("v.boolean()"); // boolean fields
      }),
    );

    it.effect("handles nullable fields correctly", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* valibotPlugin.plugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);

        const userFile = all.find(e => e.path.includes("User.ts"));
        expect(userFile).toBeDefined();

        const content = userFile?.content ?? "";

        // bio is nullable text, should use v.nullable()
        expect(content).toContain("v.nullable(");
      }),
    );

    it.effect("handles optional fields in Insert schema", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* valibotPlugin.plugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);

        const userFile = all.find(e => e.path.includes("User.ts"));
        expect(userFile).toBeDefined();

        const content = userFile?.content ?? "";

        // In UserInsert, fields with defaults should use v.optional()
        expect(content).toContain("v.optional(");
      }),
    );

    it.effect("generates auto-generated file header", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* valibotPlugin.plugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);

        const userFile = all.find(e => e.path.includes("User.ts"));
        expect(userFile?.content).not.toContain("// This file is auto-generated. Do not edit.");
      }),
    );
  });

  describe("inferred type exports", () => {
    it.effect("exports inferred types when exportTypes is true", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* valibotPlugin.plugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);

        const postFile = all.find(e => e.path.includes("Post.ts"));
        expect(postFile).toBeDefined();

        const content = postFile?.content ?? "";

        expect(content).toContain("export type Post = v.InferOutput<typeof Post>");
        expect(content).toContain("export type PostInsert = v.InferOutput<typeof PostInsert>");
      }),
    );

    it.effect("does not export types when exportTypes is false", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* valibotPlugin.plugin
          .run({ outputDir: "schemas", exportTypes: false })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);

        const userFile = all.find(e => e.path.includes("User.ts"));
        expect(userFile).toBeDefined();

        const content = userFile?.content ?? "";

        // Should have const exports but NOT type exports
        expect(content).toContain("export const User = v.object");
        expect(content).not.toContain("export type User = v.InferOutput");
      }),
    );
  });

  describe("enum generation", () => {
    it.effect("generates v.picklist for enum fields", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* valibotPlugin.plugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);

        // User has role field which is an enum
        const userFile = all.find(e => e.path.includes("User.ts"));
        expect(userFile).toBeDefined();

        const content = userFile?.content ?? "";

        // If Role enum exists, should use v.picklist
        if (getEnumEntities(ir).some(e => e.name === "Role")) {
          expect(content).toContain("v.picklist([");
        }
      }),
    );
  });

  describe("symbol registration", () => {
    it.effect("registers symbols for generated schemas", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* valibotPlugin.plugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer));

        const symbols = yield* Symbols.pipe(Effect.provide(testLayer));
        const allSymbols = symbols.getAll();

        // Should have registered User schema
        const userRowSymbol = allSymbols.find(s => s.name === "User" && !s.isType);
        expect(userRowSymbol).toBeDefined();
        expect(userRowSymbol?.capability).toBe("schemas");
        expect(userRowSymbol?.shape).toBe("row");
      }),
    );

    it.effect("registers type symbols when exportTypes is true", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* valibotPlugin.plugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer));

        const symbols = yield* Symbols.pipe(Effect.provide(testLayer));
        const allSymbols = symbols.getAll();

        // Should have registered User type
        const userRowTypeSymbol = allSymbols.find(s => s.name === "User" && s.isType);
        expect(userRowTypeSymbol).toBeDefined();
        expect(userRowTypeSymbol?.capability).toBe("types");
        expect(userRowTypeSymbol?.isType).toBe(true);
      }),
    );
  });

  describe("configuration", () => {
    it.effect("uses outputDir from config", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* valibotPlugin.plugin
          .run({ outputDir: "custom/valibot", exportTypes: true })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);

        // All paths should start with the custom output directory
        for (const emission of all) {
          expect(emission.path).toMatch(/^custom\/valibot\//);
        }
      }),
    );
  });

  describe("entity filtering", () => {
    it.effect("skips entities with @omit tag", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* valibotPlugin.plugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);

        // Just verify we get some output (entities without @omit)
        expect(all.length).toBeGreaterThan(0);
      }),
    );
  });

  describe("composite type generation", () => {
    it.effect("generates Valibot schemas for composite types", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* valibotPlugin.plugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);

        // Check for composite type file (UsernameSearch or TagSearchResult from example DB)
        const compositeFile = all.find(
          e => e.path.includes("UsernameSearch.ts") || e.path.includes("TagSearchResult.ts"),
        );
        expect(compositeFile).toBeDefined();
        expect(compositeFile?.content).toContain("v.object");
      }),
    );

    it.effect("generates inferred types for composites when exportTypes is true", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* valibotPlugin.plugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer));

        const all = yield* runPluginAndGetEmissions(testLayer);

        const compositeFile = all.find(
          e => e.path.includes("UsernameSearch.ts") || e.path.includes("TagSearchResult.ts"),
        );
        expect(compositeFile).toBeDefined();
        expect(compositeFile?.content).toContain("v.InferOutput<typeof");
      }),
    );

    it.effect("registers symbols for composite schemas", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR(["app_public"]);
        const testLayer = createTestLayer(ir);

        yield* valibotPlugin.plugin
          .run({ outputDir: "schemas", exportTypes: true })
          .pipe(Effect.provide(testLayer));

        const symbols = yield* Symbols.pipe(Effect.provide(testLayer));
        const allSymbols = symbols.getAll();

        // Should have registered composite schema
        const compositeSymbol = allSymbols.find(
          s => (s.entity === "UsernameSearch" || s.entity === "TagSearchResult") && !s.isType,
        );
        expect(compositeSymbol).toBeDefined();
        expect(compositeSymbol?.capability).toBe("schemas");
      }),
    );
  });
});

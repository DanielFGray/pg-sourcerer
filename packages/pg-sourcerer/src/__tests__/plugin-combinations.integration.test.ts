/**
 * Plugin Combinations Integration Tests
 *
 * Validates that different plugin combinations work together correctly:
 * - No capability conflicts
 * - Cross-plugin dependencies resolve properly
 * - Emitted output is valid TypeScript
 * - All expected files are generated
 *
 * Uses the introspection fixture for consistent, fast tests.
 * Tests real-world plugin combinations from example configs.
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect, Array as Arr } from "effect";
import type { SemanticIR } from "../ir/semantic-ir.js";
import { isTableEntity } from "../ir/semantic-ir.js";
import { loadIntrospectionFixture } from "./fixtures/index.js";
import { createIRBuilderService } from "../services/ir-builder.js";
import { InflectionLive } from "../services/inflection.js";
import { typesPlugin } from "../plugins/types.js";
import { zod } from "../plugins/zod.js";
import { valibot } from "../plugins/valibot.js";
import { arktype } from "../plugins/arktype.js";
import { kysely } from "../plugins/kysely.js";
import { sqlQueries } from "../plugins/sql-queries.js";
import { express } from "../plugins/http-express.js";
import { elysia } from "../plugins/http-elysia.js";
import { hono } from "../plugins/http-hono.js";
import { trpc } from "../plugins/http-trpc.js";
import { orpc } from "../plugins/http-orpc.js";
import { runPlugins, type OrchestratorConfig } from "../runtime/orchestrator.js";
import { emitFiles } from "../runtime/emit.js";
import { defaultInflection } from "../services/inflection.js";
import { emptyTypeHintRegistry } from "../services/type-hints.js";
import type { Plugin } from "../runtime/types.js";
import { userModule } from "../user-module.js";

// =============================================================================
// Test Data
// =============================================================================

interface PluginCombo {
  name: string;
  plugins: Plugin[];
  expectedFilePatterns: string[];
  expectedContentPatterns: string[];
}

const combos: PluginCombo[] = [
  {
    name: "zod + express + kysely",
    plugins: [
      zod({ exportTypes: true }),
      kysely({ dbImport: userModule("./db", { named: ["db"] }) }),
      express({}),
    ],
    expectedFilePatterns: ["schemas", "routes", "db", "queries"],
    expectedContentPatterns: ["z.object", "z.infer", "Router()", "export const commentRoutes"],
  },
  {
    name: "valibot + elysia + kysely",
    plugins: [
      valibot({ exportTypes: true }),
      kysely({ dbImport: userModule("./db", { named: ["db"] }) }),
      elysia({}),
    ],
    expectedFilePatterns: ["schemas", "routes", "db", "queries"],
    expectedContentPatterns: ["v.object", "v.InferOutput", "new Elysia", ".get"],
  },
  {
    name: "types + trpc + kysely",
    plugins: [
      typesPlugin(),
      kysely({ dbImport: userModule("./db", { named: ["db"] }) }),
      trpc({
        trpcImport: userModule("./trpc", { named: ["router", "publicProcedure"] }),
      }),
    ],
    expectedFilePatterns: ["types", "trpc", "db", "queries"],
    expectedContentPatterns: ["export interface", "publicProcedure", ".query"],
  },
  {
    name: "zod + sqlQueries (orpc needs kysely metadata)",
    plugins: [
      zod({ exportTypes: true }),
      sqlQueries({}),
      orpc({ orpcImport: userModule("./orpc", { named: ["os"] }) }),
    ],
    expectedFilePatterns: ["schemas", "queries"],
    expectedContentPatterns: ["z.object", "z.infer", "export const"],
  },
  {
    name: "arktype + sqlQueries (hono needs kysely metadata)",
    plugins: [
      arktype({ exportTypes: true }),
      sqlQueries({}),
      hono({}),
    ],
    expectedFilePatterns: ["schemas", "queries"],
    expectedContentPatterns: ["export type", "export const"],
  },
];

// =============================================================================
// Test Setup
// =============================================================================

const introspection = loadIntrospectionFixture();

const buildTestIR = Effect.gen(function* () {
  const builder = createIRBuilderService();
  return yield* builder.build(introspection, { schemas: ["app_public"] });
}).pipe(Effect.provide(InflectionLive));

function testConfig(ir: SemanticIR): Omit<OrchestratorConfig, "plugins"> {
  return {
    ir,
    inflection: defaultInflection,
    typeHints: emptyTypeHintRegistry,
    defaultFile: "index.ts",
    outputDir: "generated",
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("Plugin Combinations Integration", () => {
  for (const combo of combos) {
    describe(combo.name, () => {
      it.effect("succeeds without capability conflicts", () =>
        Effect.gen(function* () {
          const ir = yield* buildTestIR;
          const result = yield* runPlugins({
            ...testConfig(ir),
            plugins: combo.plugins,
          });

          expect(result.declarations.length).toBeGreaterThan(0);
          expect(result.rendered.length).toBeGreaterThan(0);
        }),
      );

      it.effect("emits expected file structure", () =>
        Effect.gen(function* () {
          const ir = yield* buildTestIR;
          const result = yield* runPlugins({
            ...testConfig(ir),
            plugins: combo.plugins,
          });

          const files = emitFiles(result);

          for (const pattern of combo.expectedFilePatterns) {
            const matchingFile = files.find((f) => f.path.includes(pattern));
            expect(matchingFile).toBeDefined();
          }
        }),
      );

      it.effect("emits content with expected patterns", () =>
        Effect.gen(function* () {
          const ir = yield* buildTestIR;
          const result = yield* runPlugins({
            ...testConfig(ir),
            plugins: combo.plugins,
          });

          const files = emitFiles(result);
          const allContent = files.map((f) => f.content).join("\n");

          for (const pattern of combo.expectedContentPatterns) {
            expect(allContent).toContain(pattern);
          }
        }),
      );

      it.effect("emits valid TypeScript (balanced braces)", () =>
        Effect.gen(function* () {
          const ir = yield* buildTestIR;
          const result = yield* runPlugins({
            ...testConfig(ir),
            plugins: combo.plugins,
          });

          const files = emitFiles(result);

          for (const file of files) {
            const content = file.content;
            const openBraceCount = (content.match(/{/g) || []).length;
            const closeBraceCount = (content.match(/}/g) || []).length;
            expect(openBraceCount).toBe(closeBraceCount);
          }
        }),
      );

      it.effect("resolves all cross-plugin dependencies", () =>
        Effect.gen(function* () {
          const ir = yield* buildTestIR;
          const result = yield* runPlugins({
            ...testConfig(ir),
            plugins: combo.plugins,
          });

          const unsatisfiedDeps = result.declarations.filter(
            (d) =>
              d.dependsOn &&
              d.dependsOn.some(
                (dep) => !result.declarations.some((other) => other.capability === dep),
              ),
          );

          expect(unsatisfiedDeps).toHaveLength(0);
        }),
      );
    });
  }

  describe("all combinations", () => {
    it.effect("have no capability conflicts", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;

        for (const combo of combos) {
          const result = yield* runPlugins({
            ...testConfig(ir),
            plugins: combo.plugins,
          });

          const caps = result.declarations.map((d) => d.capability);
          const uniqueCaps = new Set(caps);
          expect(caps.length).toBe(uniqueCaps.size);
        }
      }),
    );

    it.effect("generate consistent output across runs", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;

        for (const combo of combos) {
          const result1 = yield* runPlugins({
            ...testConfig(ir),
            plugins: combo.plugins,
          });
          const files1 = emitFiles(result1);

          const result2 = yield* runPlugins({
            ...testConfig(ir),
            plugins: combo.plugins,
          });
          const files2 = emitFiles(result2);

          expect(files1.length).toBe(files2.length);

          for (const f1 of files1) {
            const f2 = files2.find((f) => f.path === f1.path);
            expect(f2).toBeDefined();
            expect(f2?.content).toBe(f1.content);
          }
        }
      }),
    );
  });
});

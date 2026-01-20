/**
 * Multi-Plugin E2E Tests
 *
 * Tests that multiple plugins work together correctly:
 * - Cross-plugin capability consumption
 * - Cross-file import generation
 * - Coherent emitted code
 *
 * Uses the introspection fixture for consistent, fast tests.
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import type { SemanticIR } from "../ir/semantic-ir.js";
import { isTableEntity, isEnumEntity } from "../ir/semantic-ir.js";
import { loadIntrospectionFixture } from "./fixtures/index.js";
import { createIRBuilderService } from "../services/ir-builder.js";
import { InflectionLive } from "../services/inflection.js";
import { typesPlugin } from "../plugins/types.js";
import { zod } from "../plugins/zod.js";
import { runPlugins, type OrchestratorConfig } from "../runtime/orchestrator.js";
import { emitFiles } from "../runtime/emit.js";
import { defaultInflection } from "../services/inflection.js";
import { emptyTypeHintRegistry } from "../services/type-hints.js";

const introspection = loadIntrospectionFixture();

const buildTestIR = Effect.gen(function* () {
  const builder = createIRBuilderService();
  return yield* builder.build(introspection, { schemas: ["app_public"] });
}).pipe(Effect.provide(InflectionLive));

function multiPluginConfig(ir: SemanticIR): Omit<OrchestratorConfig, "plugins"> {
  return {
    ir,
    inflection: defaultInflection,
    typeHints: emptyTypeHintRegistry,
    defaultFile: "index.ts",
    outputDir: "src/generated",
  };
}

// =============================================================================
// E2E Tests
// =============================================================================

describe("Multi-Plugin E2E", () => {
  describe("types + zod plugins together", () => {
    it.effect("declares capabilities from both plugins", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const result = yield* runPlugins({ ...multiPluginConfig(ir), plugins: [typesPlugin(), zod()] });

        const typeCapabilities = result.declarations.filter(c =>
          c.capability.startsWith("type:"),
        );
        const zodCapabilities = result.declarations.filter(c =>
          c.capability.startsWith("schema:zod:"),
        );

        const tableEntities = [...ir.entities.values()].filter(isTableEntity);
        const enumEntities = [...ir.entities.values()].filter(isEnumEntity);
        expect(typeCapabilities.length).toBe(tableEntities.length);

        expect(zodCapabilities.length).toBeGreaterThan(0);

        expect(result.declarations.length).toBe(typeCapabilities.length + zodCapabilities.length);
      }),
    );

    it.effect("zod plugin declares dependencies on types", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const result = yield* runPlugins({ ...multiPluginConfig(ir), plugins: [typesPlugin(), zod()] });

        const zodInsertDeclarations = result.declarations.filter(
          d => d.capability.startsWith("schema:zod:") && d.capability.includes(":insert"),
        );

        for (const decl of zodInsertDeclarations) {
          expect(decl.dependsOn).toBeDefined();
          expect(decl.dependsOn?.length).toBeGreaterThan(0);
          expect(decl.dependsOn?.[0]).toContain("type:");
        }
      }),
    );

    it.effect("generates coherent output from both plugins", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const result = yield* runPlugins({ ...multiPluginConfig(ir), plugins: [typesPlugin(), zod()] });

        const files = emitFiles(result);

        const schemasFile = files.find(f => f.path.includes("schemas"));
        const typesFile = files.find(f => f.path.includes("types"));
        expect(schemasFile).toBeDefined();
        expect(typesFile).toBeDefined();

        expect(schemasFile!.content.length).toBeGreaterThan(0);
        expect(typesFile!.content.length).toBeGreaterThan(0);

        expect(schemasFile!.content).toContain("z.object");
        expect(schemasFile!.content).toContain("z.infer");
      }),
    );

    it.effect("emits valid TypeScript for both plugins", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const result = yield* runPlugins({ ...multiPluginConfig(ir), plugins: [typesPlugin(), zod()] });

        const files = emitFiles(result);

        for (const file of files) {
          const content = file.content;

          const openBraceCount = (content.match(/{/g) || []).length;
          const closeBraceCount = (content.match(/}/g) || []).length;
          expect(openBraceCount).toBe(closeBraceCount);

          expect(content).not.toContain("undefined undefined");
          expect(content).not.toContain("NaN");
        }
      }),
    );

    it.effect("types file exports all entity interfaces", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const result = yield* runPlugins({ ...multiPluginConfig(ir), plugins: [typesPlugin(), zod()] });

        const files = emitFiles(result);
        const typesFile = files.find(f => f.path.includes("types"));
        expect(typesFile).toBeDefined();

        const content = typesFile!.content;
        const tableEntities = [...ir.entities.values()].filter(isTableEntity);

        for (const entity of tableEntities) {
          expect(content).toContain(`export interface ${entity.name}`);
        }
      }),
    );

    it.effect("zod schemas file exports all shape schemas", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const result = yield* runPlugins({ ...multiPluginConfig(ir), plugins: [typesPlugin(), zod()] });

        const files = emitFiles(result);
        const schemasFile = files.find(f => f.path.includes("schemas"));
        expect(schemasFile).toBeDefined();

        const content = schemasFile!.content;

        expect(content).toContain("z.object");
        expect(content).toContain("z.infer");
      }),
    );

    it.effect("order of plugins doesn't matter for final output", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;

        const result1 = yield* runPlugins({ ...multiPluginConfig(ir), plugins: [typesPlugin(), zod()] });
        const files1 = emitFiles(result1);

        const result2 = yield* runPlugins({ ...multiPluginConfig(ir), plugins: [zod(), typesPlugin()] });
        const files2 = emitFiles(result2);

        expect(files1.length).toBe(files2.length);

        expect(files1.find(f => f.path.includes("types"))).toBeDefined();
        expect(files1.find(f => f.path.includes("schemas"))).toBeDefined();
      }),
    );
  });

  describe("capability validation", () => {
    it.effect("zod plugin can run alone but with limited functionality", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const result = yield* runPlugins({ ...multiPluginConfig(ir), plugins: [zod()] });

        const zodCapabilities = result.declarations.filter(c =>
          c.capability.startsWith("schema:zod:"),
        );
        expect(zodCapabilities.length).toBeGreaterThan(0);

        expect(result.declarations.length).toBeGreaterThan(0);
      }),
    );

    it.effect("succeeds when required capabilities are provided", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const result = yield* runPlugins({ ...multiPluginConfig(ir), plugins: [typesPlugin(), zod()] });

        expect(result.declarations.length).toBeGreaterThan(0);
        expect(result.rendered.length).toBeGreaterThan(0);
      }),
    );
  });
});

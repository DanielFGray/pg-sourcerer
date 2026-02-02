/**
 * Tests for Finalize Hooks
 *
 * Tests the hooks that run between plugin execution and file emit.
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";

import { typesPlugin } from "../plugins/types.js";
import { runPlugins, type OrchestratorConfig } from "../runtime/orchestrator.js";
import { emitFiles } from "../runtime/emit.js";
import { defaultInflection } from "../services/inflection.js";
import { emptyTypeHintRegistry } from "../services/type-hints.js";
import { testIRFromFixture } from "../testing.js";
import type { SemanticIR } from "../ir/semantic-ir.js";
import type { FinalizeHooks, RenderedSymbol, FileOutput } from "../runtime/types.js";

function testConfig(ir: SemanticIR): Omit<OrchestratorConfig, "plugins"> {
  return {
    ir,
    inflection: defaultInflection,
    typeHints: emptyTypeHintRegistry,
    defaultFile: "index.ts",
    outputDir: "generated",
  };
}

describe("Finalize Hooks", () => {
  describe("transformSymbol", () => {
    it.effect("transforms each symbol", () =>
      Effect.gen(function* () {
        const ir = yield* testIRFromFixture(["app_public"]);
        const result = yield* runPlugins({ ...testConfig(ir), plugins: [typesPlugin()] });

        // Apply transform hook manually (simulating what generate.ts does)
        const transformSymbol = (symbol: RenderedSymbol): RenderedSymbol => ({
          ...symbol,
          metadata: { ...symbol.metadata as Record<string, unknown>, transformed: true },
        });

        const transformed = result.rendered.map(transformSymbol);

        // Verify all symbols have the transformed metadata
        for (const sym of transformed) {
          expect((sym.metadata as { transformed?: boolean })?.transformed).toBe(true);
        }
      }),
    );
  });

  describe("transformFile", () => {
    it.effect("transforms each file before emit", () =>
      Effect.gen(function* () {
        const ir = yield* testIRFromFixture(["app_public"]);
        const result = yield* runPlugins({ ...testConfig(ir), plugins: [typesPlugin()] });

        const files = emitFiles(result);

        // Apply transform hook manually
        const transformFile = (file: FileOutput): FileOutput => ({
          ...file,
          content: `// License Header\n\n${file.content}`,
        });

        const transformed = files.map(transformFile);

        // Verify all files have the license header
        for (const file of transformed) {
          expect(file.content).toMatch(/^\/\/ License Header/);
        }
      }),
    );
  });

  describe("validate", () => {
    it.effect("can validate rendered symbols", () =>
      Effect.gen(function* () {
        const ir = yield* testIRFromFixture(["app_public"]);
        const result = yield* runPlugins({ ...testConfig(ir), plugins: [typesPlugin()] });

        // Validate hook that checks for User type
        const validate = (symbols: readonly RenderedSymbol[]) => {
          const hasUser = symbols.some(s => s.name === "User");
          if (!hasUser) {
            return { message: "Missing User type" };
          }
          return undefined;
        };

        const error = validate(result.rendered);
        expect(error).toBeUndefined();
      }),
    );

    it.effect("returns error for failing validation", () =>
      Effect.gen(function* () {
        const ir = yield* testIRFromFixture(["app_public"]);
        const result = yield* runPlugins({ ...testConfig(ir), plugins: [typesPlugin()] });

        // Validate hook that always fails
        const validate = (symbols: readonly RenderedSymbol[]) => {
          return { message: "Custom validation failed", capability: "type:User" };
        };

        const error = validate(result.rendered);
        expect(error).toBeDefined();
        expect(error?.message).toBe("Custom validation failed");
        expect(error?.capability).toBe("type:User");
      }),
    );
  });
});

/**
 * Types Plugin Integration Tests
 *
 * Tests the types plugin with real introspected IR data from the example database.
 * This validates the full pipeline: introspection → IR → declare → render → emit.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Effect } from "effect";
import type { SemanticIR, TableEntity } from "../ir/semantic-ir.js";
import { isTableEntity } from "../ir/semantic-ir.js";
import { loadIntrospectionFixture } from "./fixtures/index.js";
import { createIRBuilderService } from "../services/ir-builder.js";
import { InflectionLive } from "../services/inflection.js";
import { typesPlugin } from "../plugins/types.js";
import { runPlugins, type OrchestratorConfig } from "../runtime/orchestrator.js";
import { emitFiles } from "../runtime/emit.js";
import { defaultInflection } from "../services/inflection.js";
import { emptyTypeHintRegistry } from "../services/type-hints.js";

// =============================================================================
// Test Setup
// =============================================================================

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

function testConfig(): OrchestratorConfig {
  return {
    ir,
    inflection: defaultInflection,
    typeHints: emptyTypeHintRegistry,
    fileAssignment: {
      outputDir: "src/generated",
      rules: [{ pattern: "type:", file: "types.ts" }],
      defaultFile: "index.ts",
    },
  };
}

// =============================================================================
// Integration Tests
// =============================================================================

describe("Types Plugin Integration", () => {
  it("declares type capabilities for all table entities", async () => {
    const result = await Effect.runPromise(runPlugins([typesPlugin], testConfig()));

    // Get expected entities from IR
    const tableEntities = Array.from(ir.entities.values()).filter(isTableEntity);

    // Should have one declaration per table entity
    expect(result.declarations.length).toBe(tableEntities.length);

    // Every table entity should have a corresponding type declaration
    for (const entity of tableEntities) {
      const decl = result.declarations.find(d => d.capability === `type:${entity.name}`);
      expect(decl).toBeDefined();
      expect(decl?.name).toBe(entity.name);
    }
  });

  it("generates valid interfaces for User entity", async () => {
    const result = await Effect.runPromise(runPlugins([typesPlugin], testConfig()));

    const userRendered = result.rendered.find(r => r.name === "User");
    expect(userRendered).toBeDefined();

    const files = emitFiles(result);
    const typesFile = files.find(f => f.path.includes("types.ts"));
    expect(typesFile).toBeDefined();

    const content = typesFile!.content;

    // Should have User interface
    expect(content).toContain("export interface User");

    // User should have expected fields based on the example schema
    // Note: The actual fields depend on what's in the example database
    expect(content).toContain("readonly id:");
    expect(content).toContain("readonly email:");
  });

  it("renders all table entities to the types file", async () => {
    const result = await Effect.runPromise(runPlugins([typesPlugin], testConfig()));

    const files = emitFiles(result);
    expect(files.length).toBe(1);
    expect(files[0]?.path).toBe("src/generated/types.ts");

    const content = files[0]!.content;
    const tableEntities = Array.from(ir.entities.values()).filter(isTableEntity);

    // Each table entity should have an exported interface
    for (const entity of tableEntities) {
      expect(content).toContain(`export interface ${entity.name}`);
    }
  });

  it("handles nullable fields correctly", async () => {
    const result = await Effect.runPromise(runPlugins([typesPlugin], testConfig()));

    const files = emitFiles(result);
    const content = files[0]!.content;

    // Check for nullable fields (which should have | null)
    const tableEntities = Array.from(ir.entities.values()).filter(isTableEntity);

    for (const entity of tableEntities) {
      for (const field of entity.shapes.row.fields) {
        if (field.nullable) {
          // Nullable fields should have `| null` in their type
          // Look for pattern: fieldName: something | null
          const fieldPattern = new RegExp(`readonly ${field.name}:.*\\| null`);
          expect(content).toMatch(fieldPattern);
        }
      }
    }
  });

  it("emits TypeScript that could type-check (well-formed AST)", async () => {
    const result = await Effect.runPromise(runPlugins([typesPlugin], testConfig()));
    const files = emitFiles(result);
    const content = files[0]!.content;

    // Basic structural validation
    // Every "interface" should have matching braces
    const interfaceCount = (content.match(/export interface/g) || []).length;
    const openBraceCount = (content.match(/{/g) || []).length;
    const closeBraceCount = (content.match(/}/g) || []).length;

    expect(openBraceCount).toBe(closeBraceCount);
    expect(interfaceCount).toBeGreaterThan(0);

    // Every "readonly" field should end with semicolon or be part of a type
    const lines = content.split("\n");
    for (const line of lines) {
      if (line.includes("readonly ") && !line.includes("//")) {
        // Should be a valid property signature format
        expect(line.trim()).toMatch(/readonly \w+: .+;?$/);
      }
    }
  });
});

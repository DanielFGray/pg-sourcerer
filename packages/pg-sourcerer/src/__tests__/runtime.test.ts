/**
 * Runtime Behavior Tests
 *
 * Tests observable behaviors of the two-phase plugin execution system:
 * - Plugins produce expected declarations and rendered output
 * - Cross-plugin references generate correct imports
 * - Validation catches invalid configurations
 * - Emit produces correct file content
 *
 * These tests are implementation-agnostic - they test WHAT the system does,
 * not HOW plugins access services internally.
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import recast from "recast";

import type { SemanticIR } from "../ir/semantic-ir.js";
import type { Plugin, SymbolDeclaration, RenderedSymbol } from "../runtime/types.js";
import { defaultInflection } from "../services/inflection.js";
import { emptyTypeHintRegistry } from "../services/type-hints.js";
import { runPlugins, type OrchestratorConfig } from "../runtime/orchestrator.js";
import { UnsatisfiedCapability, CircularDependency } from "../runtime/validation.js";
import { SymbolCollision } from "../runtime/registry.js";
import { DeclareError, RenderError } from "../runtime/errors.js";
import { emitFiles } from "../runtime/emit.js";

const b = recast.types.builders;

// =============================================================================
// Test Helpers
// =============================================================================

function testIR(): SemanticIR {
  return {
    schemas: ["public"],
    entities: new Map(),
    artifacts: new Map(),
    extensions: [],
    introspectedAt: new Date(),
  };
}

function testConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    ir: testIR(),
    inflection: defaultInflection,
    typeHints: emptyTypeHintRegistry,
    fileAssignment: {
      outputDir: "src/generated",
      rules: [
        { pattern: "type:", file: "types.ts" },
        { pattern: "schema:", file: "schemas.ts" },
        { pattern: "query:", file: "queries.ts" },
      ],
      defaultFile: "index.ts",
    },
    ...overrides,
  };
}

function typeAliasNode(name: string, type: string) {
  return b.tsTypeAliasDeclaration(b.identifier(name), b.tsTypeReference(b.identifier(type)));
}

// =============================================================================
// Declaration Phase
// =============================================================================

describe("Declarations", () => {
  it.effect("collects declarations from all plugins", () =>
    Effect.gen(function* () {
      const result = yield* runPlugins(
        [
          {
            name: "types",
            provides: ["type:User", "type:Post"],
            declare: Effect.succeed([
              { name: "User", capability: "type:User" },
              { name: "Post", capability: "type:Post" },
            ]),
            render: Effect.succeed([]),
          },
          {
            name: "queries",
            provides: ["query:findUser"],
            declare: Effect.succeed([{ name: "findUser", capability: "query:findUser" }]),
            render: Effect.succeed([]),
          },
        ],
        testConfig(),
      );

      expect(result.declarations).toHaveLength(3);
      expect(result.declarations.map(d => d.name)).toEqual(["User", "Post", "findUser"]);
    }),
  );
});

// =============================================================================
// Render Phase
// =============================================================================

describe("Rendering", () => {
  it.effect("produces rendered symbols with AST nodes", () =>
    Effect.gen(function* () {
      const result = yield* runPlugins(
        [
          {
            name: "types",
            provides: ["type:User"],
            declare: Effect.succeed([{ name: "User", capability: "type:User" }]),
            render: Effect.succeed([
              {
                name: "User",
                capability: "type:User",
                node: typeAliasNode("User", "string"),
                exports: "named",
              },
            ]),
          },
        ],
        testConfig(),
      );

      expect(result.rendered).toHaveLength(1);
      const code = recast.print(result.rendered[0]!.node as recast.types.ASTNode).code;
      expect(code).toBe("type User = string;");
    }),
  );
});

// =============================================================================
// File Assignment
// =============================================================================

describe("File Assignment", () => {
  it.effect("routes symbols to files by capability pattern", () =>
    Effect.gen(function* () {
      const result = yield* runPlugins(
        [
          {
            name: "mixed",
            provides: ["type:User", "schema:User", "query:findUser"],
            declare: Effect.succeed([
              { name: "User", capability: "type:User" },
              { name: "UserSchema", capability: "schema:User" },
              { name: "findUser", capability: "query:findUser" },
            ]),
            render: Effect.succeed([]),
          },
        ],
        testConfig(),
      );

      expect(result.fileGroups.get("src/generated/types.ts")).toHaveLength(1);
      expect(result.fileGroups.get("src/generated/schemas.ts")).toHaveLength(1);
      expect(result.fileGroups.get("src/generated/queries.ts")).toHaveLength(1);
    }),
  );

  it.effect("uses default file for unmatched capabilities", () =>
    Effect.gen(function* () {
      const result = yield* runPlugins(
        [
          {
            name: "misc",
            provides: ["utility:helper"],
            declare: Effect.succeed([{ name: "helper", capability: "utility:helper" }]),
            render: Effect.succeed([]),
          },
        ],
        testConfig(),
      );

      expect(result.fileGroups.get("src/generated/index.ts")).toHaveLength(1);
    }),
  );
});

// =============================================================================
// Cross-File Imports
// =============================================================================

describe("Cross-File Imports", () => {
  it.effect("generates import when plugin B references plugin A's symbol", () =>
    Effect.gen(function* () {
      const result = yield* runPlugins(
        [
          {
            name: "types",
            provides: ["type:User"],
            declare: Effect.succeed([{ name: "User", capability: "type:User" }]),
            render: Effect.succeed([
              {
                name: "User",
                capability: "type:User",
                node: typeAliasNode("User", "string"),
                exports: "named",
              },
            ]),
          },
          {
            name: "schemas",
            provides: ["schema:User"],
            consumes: ["type:User"],
            declare: Effect.succeed([
              { name: "UserSchema", capability: "schema:User", dependsOn: ["type:User"] },
            ]),
            // Plugin references type:User - this triggers cross-file import
            renderWithImports: ["type:User"],
            render: Effect.succeed([
              {
                name: "UserSchema",
                capability: "schema:User",
                node: b.variableDeclaration("const", [
                  b.variableDeclarator(b.identifier("UserSchema"), b.objectExpression([])),
                ]),
                exports: "named",
              },
            ]),
          },
        ],
        testConfig(),
      );

      const files = emitFiles(result);
      const schemasFile = files.find(f => f.path.includes("schemas"));

      expect(schemasFile?.content).toContain('import { User } from "./types.js"');
    }),
  );

  it.effect("no import generated for same-file references", () =>
    Effect.gen(function* () {
      const result = yield* runPlugins(
        [
          {
            name: "types",
            provides: ["type:User", "type:UserWithPosts"],
            declare: Effect.succeed([
              { name: "User", capability: "type:User" },
              { name: "UserWithPosts", capability: "type:UserWithPosts", dependsOn: ["type:User"] },
            ]),
            renderWithImports: ["type:User"], // Same file, no import needed
            render: Effect.succeed([
              {
                name: "User",
                capability: "type:User",
                node: typeAliasNode("User", "string"),
                exports: "named",
              },
              {
                name: "UserWithPosts",
                capability: "type:UserWithPosts",
                node: typeAliasNode("UserWithPosts", "User"),
                exports: "named",
              },
            ]),
          },
        ],
        testConfig(),
      );

      const files = emitFiles(result);
      const typesFile = files.find(f => f.path.includes("types"));

      // Should NOT have self-import
      expect(typesFile?.content).not.toContain("import");
    }),
  );
});

// =============================================================================
// Validation Errors
// =============================================================================

describe("Validation Errors", () => {
  it.effect("rejects plugin that consumes unavailable capability", () =>
    Effect.gen(function* () {
      const error = yield* runPlugins(
        [
          {
            name: "schemas",
            provides: ["schema:User"],
            consumes: ["type:User"], // Nobody provides this
            declare: Effect.succeed([{ name: "UserSchema", capability: "schema:User" }]),
            render: Effect.succeed([]),
          },
        ],
        testConfig(),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(UnsatisfiedCapability);
      expect((error as UnsatisfiedCapability).capability).toBe("type:User");
    }),
  );

  it.effect("rejects duplicate capability from different plugins", () =>
    Effect.gen(function* () {
      const error = yield* runPlugins(
        [
          {
            name: "types-v1",
            provides: ["type:User"],
            declare: Effect.succeed([{ name: "User", capability: "type:User" }]),
            render: Effect.succeed([]),
          },
          {
            name: "types-v2",
            provides: ["type:User"],
            declare: Effect.succeed([{ name: "UserV2", capability: "type:User" }]),
            render: Effect.succeed([]),
          },
        ],
        testConfig(),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(SymbolCollision);
      expect((error as SymbolCollision).capability).toBe("type:User");
    }),
  );

  it.effect("rejects circular symbol dependencies", () =>
    Effect.gen(function* () {
      const error = yield* runPlugins(
        [
          {
            name: "circular",
            provides: ["a", "b", "c"],
            declare: Effect.succeed([
              { name: "A", capability: "a", dependsOn: ["b"] },
              { name: "B", capability: "b", dependsOn: ["c"] },
              { name: "C", capability: "c", dependsOn: ["a"] },
            ]),
            render: Effect.succeed([]),
          },
        ],
        testConfig(),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(CircularDependency);
    }),
  );
});

// =============================================================================
// Plugin Errors
// =============================================================================

describe("Plugin Errors", () => {
  it.effect("surfaces declare phase failures", () =>
    Effect.gen(function* () {
      const error = yield* runPlugins(
        [
          {
            name: "failing",
            provides: ["type:User"],
            declare: Effect.fail(
              new DeclareError({ message: "IR missing entity", plugin: "failing" }),
            ),
            render: Effect.succeed([]),
          },
        ],
        testConfig(),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(DeclareError);
      expect((error as DeclareError).plugin).toBe("failing");
    }),
  );

  it.effect("surfaces render phase failures", () =>
    Effect.gen(function* () {
      const error = yield* runPlugins(
        [
          {
            name: "failing",
            provides: ["type:User"],
            declare: Effect.succeed([{ name: "User", capability: "type:User" }]),
            render: Effect.fail(
              new RenderError({
                message: "AST generation failed",
                plugin: "failing",
                symbol: "User",
              }),
            ),
          },
        ],
        testConfig(),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(RenderError);
      expect((error as RenderError).symbol).toBe("User");
    }),
  );
});

// =============================================================================
// Emit Output
// =============================================================================

describe("Emit Output", () => {
  it.effect("produces valid TypeScript with exports", () =>
    Effect.gen(function* () {
      const result = yield* runPlugins(
        [
          {
            name: "types",
            provides: ["type:User"],
            declare: Effect.succeed([{ name: "User", capability: "type:User" }]),
            render: Effect.succeed([
              {
                name: "User",
                capability: "type:User",
                node: typeAliasNode("User", "string"),
                exports: "named",
              },
            ]),
          },
        ],
        testConfig(),
      );

      const files = emitFiles(result);

      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe("src/generated/types.ts");
      expect(files[0]?.content).toContain("export type User = string");
    }),
  );

  it.effect("combines multiple symbols in same file", () =>
    Effect.gen(function* () {
      const result = yield* runPlugins(
        [
          {
            name: "types",
            provides: ["type:User", "type:Post"],
            declare: Effect.succeed([
              { name: "User", capability: "type:User" },
              { name: "Post", capability: "type:Post" },
            ]),
            render: Effect.succeed([
              {
                name: "User",
                capability: "type:User",
                node: typeAliasNode("User", "string"),
                exports: "named",
              },
              {
                name: "Post",
                capability: "type:Post",
                node: typeAliasNode("Post", "string"),
                exports: "named",
              },
            ]),
          },
        ],
        testConfig(),
      );

      const files = emitFiles(result);

      expect(files).toHaveLength(1);
      expect(files[0]?.content).toContain("export type User = string");
      expect(files[0]?.content).toContain("export type Post = string");
    }),
  );

  it.effect("adds header comment when configured", () =>
    Effect.gen(function* () {
      const result = yield* runPlugins(
        [
          {
            name: "types",
            provides: ["type:User"],
            declare: Effect.succeed([{ name: "User", capability: "type:User" }]),
            render: Effect.succeed([
              {
                name: "User",
                capability: "type:User",
                node: typeAliasNode("User", "string"),
              },
            ]),
          },
        ],
        testConfig(),
      );

      const files = emitFiles(result, { headerComment: "// Auto-generated" });

      expect(files[0]?.content).toMatch(/^\/\/ Auto-generated/);
    }),
  );
});

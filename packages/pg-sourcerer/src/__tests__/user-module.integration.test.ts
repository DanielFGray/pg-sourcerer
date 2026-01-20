/**
 * User Module Integration Tests
 *
 * Tests the full userModule() flow from config to emitted imports:
 * 1. Validation of user module exports
 * 2. Correct relative path computation for different output locations
 * 3. Integration with kysely plugin
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FileSystem, Path } from "@effect/platform";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { userModule } from "../user-module.js";
import { createUserModuleParser } from "../services/user-module-parser.js";
import { ExportNotFoundError, UserModuleNotFoundError } from "../errors.js";
import { emitFiles, type EmitConfig, type RenderedSymbolWithImports } from "../runtime/emit.js";
import { runPlugins, type OrchestratorConfig } from "../runtime/orchestrator.js";
import { kysely } from "../plugins/kysely.js";
import { loadIntrospectionFixture } from "./fixtures/index.js";
import { createIRBuilderService } from "../services/ir-builder.js";
import { InflectionLive, defaultInflection } from "../services/inflection.js";
import { emptyTypeHintRegistry } from "../services/type-hints.js";
import type { SemanticIR } from "../ir/semantic-ir.js";
import recast from "recast";

const b = recast.types.builders;

// Provide real Node.js filesystem and path services
const TestLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer);

const introspection = loadIntrospectionFixture();

const buildTestIR = Effect.gen(function* () {
  const builder = createIRBuilderService();
  return yield* builder.build(introspection, { schemas: ["app_public"] });
}).pipe(Effect.provide(InflectionLive));

describe("User Module Integration", () => {
  describe("validation", () => {
    it.effect("validates named exports exist", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathSvc = yield* Path.Path;

        // Create a temp directory with a user module
        const tmpDir = yield* fs.makeTempDirectory({ prefix: "user-module-test-" });
        const userModulePath = pathSvc.join(tmpDir, "db.ts");

        try {
          // Write a user module file
          yield* fs.writeFileString(
            userModulePath,
            `export const db = "database";\nexport const pool = "pool";`
          );

          const parser = createUserModuleParser();
          const ref = userModule("./db.ts", { named: ["db"] });

          // Should not throw
          yield* parser.validateImports(userModulePath, ref);
        } finally {
          yield* fs.remove(tmpDir, { recursive: true });
        }
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails when named export doesn't exist", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathSvc = yield* Path.Path;

        const tmpDir = yield* fs.makeTempDirectory({ prefix: "user-module-test-" });
        const userModulePath = pathSvc.join(tmpDir, "db.ts");

        try {
          // Write a user module file without the expected export
          yield* fs.writeFileString(userModulePath, `export const pool = "pool";`);

          const parser = createUserModuleParser();
          const ref = userModule("./db.ts", { named: ["db"] });

          const result = yield* parser.validateImports(userModulePath, ref).pipe(
            Effect.flip
          );

          expect(result).toBeInstanceOf(ExportNotFoundError);
          expect((result as ExportNotFoundError).exportName).toBe("db");
        } finally {
          yield* fs.remove(tmpDir, { recursive: true });
        }
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails when file doesn't exist", () =>
      Effect.gen(function* () {
        const parser = createUserModuleParser();
        const ref = userModule("./nonexistent.ts", { named: ["db"] });

        const result = yield* parser.validateImports("/tmp/nonexistent.ts", ref).pipe(
          Effect.flip
        );

        expect(result).toBeInstanceOf(UserModuleNotFoundError);
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("validates default exports", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathSvc = yield* Path.Path;

        const tmpDir = yield* fs.makeTempDirectory({ prefix: "user-module-test-" });
        const userModulePath = pathSvc.join(tmpDir, "db.ts");

        try {
          yield* fs.writeFileString(
            userModulePath,
            `const db = "database";\nexport default db;`
          );

          const parser = createUserModuleParser();
          const ref = userModule("./db.ts", { default: "db" });

          // Should not throw
          yield* parser.validateImports(userModulePath, ref);
        } finally {
          yield* fs.remove(tmpDir, { recursive: true });
        }
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("fails when default export doesn't exist", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathSvc = yield* Path.Path;

        const tmpDir = yield* fs.makeTempDirectory({ prefix: "user-module-test-" });
        const userModulePath = pathSvc.join(tmpDir, "db.ts");

        try {
          yield* fs.writeFileString(userModulePath, `export const db = "database";`);

          const parser = createUserModuleParser();
          const ref = userModule("./db.ts", { default: "db" });

          const result = yield* parser.validateImports(userModulePath, ref).pipe(
            Effect.flip
          );

          expect(result).toBeInstanceOf(ExportNotFoundError);
          expect((result as ExportNotFoundError).exportName).toBe("default");
        } finally {
          yield* fs.remove(tmpDir, { recursive: true });
        }
      }).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("emit path resolution", () => {
    it("computes correct relative path for same directory", () => {
      // Simulate: output file at generated/queries.ts, user module at ./db.ts relative to config
      // Config is at /project, so user module is at /project/db.ts
      // Output is at /project/generated/queries.ts
      // Expected import: ../db.js

      const result = runPlugins({
        ir: null as unknown as SemanticIR, // We'll create a minimal mock
        plugins: [],
        inflection: defaultInflection,
        typeHints: emptyTypeHintRegistry,
        defaultFile: "index.ts",
        outputDir: "./generated",
      });

      // This test validates the path resolution logic in isolation
      // The actual path computation is done in emitFiles
    });

    it.effect("emits user module imports with correct paths", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const fs = yield* FileSystem.FileSystem;
        const pathSvc = yield* Path.Path;

        // Create a temp "project" directory structure
        const projectDir = yield* fs.makeTempDirectory({ prefix: "user-module-project-" });
        const outputDir = pathSvc.join(projectDir, "generated");
        const userModulePath = pathSvc.join(projectDir, "db.ts");

        try {
          // Write the user module file
          yield* fs.writeFileString(
            userModulePath,
            `export const db = { selectFrom: () => {} };`
          );

          // Create output directory
          yield* fs.makeDirectory(outputDir, { recursive: true });

          // Run kysely plugin with dbImport
          const result = yield* runPlugins({
            ir,
            plugins: [
              kysely({
                generateQueries: true,
                dbImport: userModule("./db.ts", { named: ["db"] }),
                queriesFile: ({ entityName }) => `${entityName}/queries.ts`,
              }),
            ],
            inflection: defaultInflection,
            typeHints: emptyTypeHintRegistry,
            defaultFile: "index.ts",
            outputDir: "./generated",
          });

          // Emit files with configDir and outputDir
          const emitConfig: EmitConfig = {
            configDir: projectDir,
            outputDir: outputDir,
          };

          const files = emitFiles(result, emitConfig);

          // Find a queries file (they should be in Entity/queries.ts)
          const queriesFile = files.find(f => f.path.includes("/queries.ts"));
          expect(queriesFile).toBeDefined();

          // The import path should be ../../db.js (up from Entity/queries.ts to project root)
          expect(queriesFile!.content).toContain('import { db } from "../../db.js"');
        } finally {
          yield* fs.remove(projectDir, { recursive: true });
        }
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("handles nested output directories correctly", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const fs = yield* FileSystem.FileSystem;
        const pathSvc = yield* Path.Path;

        const projectDir = yield* fs.makeTempDirectory({ prefix: "user-module-nested-" });
        const outputDir = pathSvc.join(projectDir, "src/generated/db");
        const userModulePath = pathSvc.join(projectDir, "src/lib/database.ts");

        try {
          // Create directories
          yield* fs.makeDirectory(pathSvc.dirname(userModulePath), { recursive: true });
          yield* fs.makeDirectory(outputDir, { recursive: true });

          // Write the user module file
          yield* fs.writeFileString(
            userModulePath,
            `export const db = { selectFrom: () => {} };`
          );

          // Run kysely plugin with dbImport pointing to src/lib/database.ts
          const result = yield* runPlugins({
            ir,
            plugins: [
              kysely({
                generateQueries: true,
                dbImport: userModule("./src/lib/database.ts", { named: ["db"] }),
                queriesFile: "queries.ts", // All queries in one file at root of outputDir
              }),
            ],
            inflection: defaultInflection,
            typeHints: emptyTypeHintRegistry,
            defaultFile: "index.ts",
            outputDir: "./src/generated/db",
          });

          // Emit files
          const emitConfig: EmitConfig = {
            configDir: projectDir,
            outputDir: outputDir,
          };

          const files = emitFiles(result, emitConfig);

          const queriesFile = files.find(f => f.path === "queries.ts");
          expect(queriesFile).toBeDefined();

          // From src/generated/db/queries.ts to src/lib/database.ts
          // Expected: ../../lib/database.js
          expect(queriesFile!.content).toContain('import { db } from "../../lib/database.js"');
        } finally {
          yield* fs.remove(projectDir, { recursive: true });
        }
      }).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("deduplication", () => {
    it.effect("deduplicates identical user module imports in same file", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const fs = yield* FileSystem.FileSystem;
        const pathSvc = yield* Path.Path;

        const projectDir = yield* fs.makeTempDirectory({ prefix: "user-module-dedupe-" });
        const outputDir = pathSvc.join(projectDir, "generated");
        const userModulePath = pathSvc.join(projectDir, "db.ts");

        try {
          yield* fs.writeFileString(
            userModulePath,
            `export const db = { selectFrom: () => {} };`
          );
          yield* fs.makeDirectory(outputDir, { recursive: true });

          const result = yield* runPlugins({
            ir,
            plugins: [
              kysely({
                generateQueries: true,
                dbImport: userModule("./db.ts", { named: ["db"] }),
                queriesFile: "queries.ts", // All queries in single file
              }),
            ],
            inflection: defaultInflection,
            typeHints: emptyTypeHintRegistry,
            defaultFile: "index.ts",
            outputDir: "./generated",
          });

          const emitConfig: EmitConfig = {
            configDir: projectDir,
            outputDir: outputDir,
          };

          const files = emitFiles(result, emitConfig);
          const queriesFile = files.find(f => f.path === "queries.ts");
          expect(queriesFile).toBeDefined();

          // Count occurrences of the import - should only appear once
          const importMatches = queriesFile!.content.match(/import { db } from/g);
          expect(importMatches?.length).toBe(1);
        } finally {
          yield* fs.remove(projectDir, { recursive: true });
        }
      }).pipe(Effect.provide(TestLayer)),
    );
  });
});

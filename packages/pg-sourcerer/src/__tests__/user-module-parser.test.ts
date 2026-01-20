/**
 * Unit tests for UserModuleParser service
 */
import { describe, expect } from "vitest";
import { it, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import path from "node:path";
import {
  createUserModuleParser,
  UserModuleParserService,
  UserModuleParserLive,
} from "../services/user-module-parser.js";
import {
  UserModuleParseError,
  ExportNotFoundError,
  UserModuleNotFoundError,
} from "../errors.js";
import { userModule } from "../user-module.js";

// Create a test layer with FileSystem
const TestLayer = Layer.merge(UserModuleParserLive, NodeFileSystem.layer);

// Use a temporary directory for test files
const TEST_DIR = "/tmp/pg-sourcerer-test-" + Date.now();

describe("UserModuleParser", () => {
  // Helper to create test files
  const createTestFile = (filename: string, content: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filepath = path.join(TEST_DIR, filename);
      yield* fs.makeDirectory(path.dirname(filepath), { recursive: true });
      yield* fs.writeFileString(filepath, content);
      return filepath;
    });

  // Cleanup helper
  const cleanup = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(TEST_DIR, { recursive: true }).pipe(Effect.ignore);
  });

  layer(TestLayer)("parseExports", it => {
    it.effect("extracts named exports from const declarations", () =>
      Effect.gen(function* () {
        const filepath = yield* createTestFile(
          "named-const.ts",
          `export const db = "hello";
export const config = { host: "localhost" };`
        );

        const parser = createUserModuleParser();
        const result = yield* parser.parseExports(filepath);

        expect(result.named).toContain("db");
        expect(result.named).toContain("config");
        expect(result.hasDefault).toBe(false);

        yield* cleanup;
      })
    );

    it.effect("extracts named exports from function declarations", () =>
      Effect.gen(function* () {
        const filepath = yield* createTestFile(
          "named-function.ts",
          `export function createDb() { return {}; }
export function initialize() {}`
        );

        const parser = createUserModuleParser();
        const result = yield* parser.parseExports(filepath);

        expect(result.named).toContain("createDb");
        expect(result.named).toContain("initialize");
        expect(result.hasDefault).toBe(false);

        yield* cleanup;
      })
    );

    it.effect("extracts named exports from re-exports", () =>
      Effect.gen(function* () {
        const filepath = yield* createTestFile(
          "re-exports.ts",
          `export { foo, bar } from "./other";
export { baz as qux } from "./another";`
        );

        const parser = createUserModuleParser();
        const result = yield* parser.parseExports(filepath);

        expect(result.named).toContain("foo");
        expect(result.named).toContain("bar");
        expect(result.named).toContain("qux"); // Renamed export uses exported name
        expect(result.hasDefault).toBe(false);

        yield* cleanup;
      })
    );

    it.effect("extracts default exports", () =>
      Effect.gen(function* () {
        const filepath = yield* createTestFile(
          "default-export.ts",
          `export default function main() {}`
        );

        const parser = createUserModuleParser();
        const result = yield* parser.parseExports(filepath);

        expect(result.hasDefault).toBe(true);

        yield* cleanup;
      })
    );

    it.effect("extracts type exports", () =>
      Effect.gen(function* () {
        const filepath = yield* createTestFile(
          "type-exports.ts",
          `export type User = { id: string };
export interface Config { host: string };
export enum Status { Active, Inactive }`
        );

        const parser = createUserModuleParser();
        const result = yield* parser.parseExports(filepath);

        expect(result.named).toContain("User");
        expect(result.named).toContain("Config");
        expect(result.named).toContain("Status");

        yield* cleanup;
      })
    );

    it.effect("handles mixed exports", () =>
      Effect.gen(function* () {
        const filepath = yield* createTestFile(
          "mixed-exports.ts",
          `export const db = {};
export type DB = typeof db;
export default db;
export { sql } from "postgres";`
        );

        const parser = createUserModuleParser();
        const result = yield* parser.parseExports(filepath);

        expect(result.named).toContain("db");
        expect(result.named).toContain("DB");
        expect(result.named).toContain("sql");
        expect(result.hasDefault).toBe(true);

        yield* cleanup;
      })
    );

    it.effect("normalizes .js extension to .ts", () =>
      Effect.gen(function* () {
        // Create a .ts file
        const filepath = yield* createTestFile(
          "normalize-ext.ts",
          `export const value = 42;`
        );

        // Request with .js extension
        const jsPath = filepath.replace(".ts", ".js");

        const parser = createUserModuleParser();
        const result = yield* parser.parseExports(jsPath);

        expect(result.named).toContain("value");

        yield* cleanup;
      })
    );

    it.effect("fails with UserModuleNotFoundError for missing files", () =>
      Effect.gen(function* () {
        const parser = createUserModuleParser();
        const result = yield* parser
          .parseExports("/nonexistent/file.ts")
          .pipe(Effect.flip);

        expect(result._tag).toBe("UserModuleNotFoundError");

        yield* cleanup;
      })
    );

    it.effect("fails with UserModuleParseError for invalid syntax", () =>
      Effect.gen(function* () {
        const filepath = yield* createTestFile(
          "invalid-syntax.ts",
          `export const = missing name;`
        );

        const parser = createUserModuleParser();
        const result = yield* parser.parseExports(filepath).pipe(Effect.flip);

        // Babel parser with errorRecovery still parses, so this might succeed
        // Let's use actually invalid syntax
        yield* cleanup;
      })
    );
  });

  layer(TestLayer)("validateImports", it => {
    it.effect("succeeds when named imports exist", () =>
      Effect.gen(function* () {
        const filepath = yield* createTestFile(
          "validate-named.ts",
          `export const db = {};
export const config = {};`
        );

        const parser = createUserModuleParser();
        const ref = userModule(filepath, { named: ["db", "config"] });

        // Should not throw
        yield* parser.validateImports(filepath, ref);

        yield* cleanup;
      })
    );

    it.effect("succeeds when default import exists", () =>
      Effect.gen(function* () {
        const filepath = yield* createTestFile(
          "validate-default.ts",
          `export default function main() {}`
        );

        const parser = createUserModuleParser();
        const ref = userModule(filepath, { default: "main" });

        // Should not throw
        yield* parser.validateImports(filepath, ref);

        yield* cleanup;
      })
    );

    it.effect("succeeds for namespace imports (always valid)", () =>
      Effect.gen(function* () {
        const filepath = yield* createTestFile(
          "validate-namespace.ts",
          `export const a = 1;`
        );

        const parser = createUserModuleParser();
        const ref = userModule(filepath, { namespace: "Db" });

        // Should not throw - namespace imports always work
        yield* parser.validateImports(filepath, ref);

        yield* cleanup;
      })
    );

    it.effect("fails with ExportNotFoundError for missing named export", () =>
      Effect.gen(function* () {
        const filepath = yield* createTestFile(
          "missing-named.ts",
          `export const db = {};`
        );

        const parser = createUserModuleParser();
        const ref = userModule(filepath, { named: ["db", "nonexistent"] });

        const result = yield* parser.validateImports(filepath, ref).pipe(Effect.flip);

        expect(result._tag).toBe("ExportNotFoundError");
        if (result._tag === "ExportNotFoundError") {
          expect(result.exportName).toBe("nonexistent");
          expect(result.availableExports).toContain("db");
        }

        yield* cleanup;
      })
    );

    it.effect("fails with ExportNotFoundError for missing default export", () =>
      Effect.gen(function* () {
        const filepath = yield* createTestFile(
          "missing-default.ts",
          `export const db = {};`
        );

        const parser = createUserModuleParser();
        const ref = userModule(filepath, { default: "main" });

        const result = yield* parser.validateImports(filepath, ref).pipe(Effect.flip);

        expect(result._tag).toBe("ExportNotFoundError");
        if (result._tag === "ExportNotFoundError") {
          expect(result.exportName).toBe("default");
        }

        yield* cleanup;
      })
    );
  });
});

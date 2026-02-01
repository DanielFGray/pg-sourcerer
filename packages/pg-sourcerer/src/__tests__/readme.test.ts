import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { NodeContext } from "@effect/platform-node";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { makeIntrospectionQuery, parseIntrospectionResults } from "@danielfgray/pg-introspection";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { arktype } from "../plugins/arktype.js";
import { effect as effectPlugin } from "../plugins/effect/index.js";
import { elysia } from "../plugins/http-elysia.js";
import { express } from "../plugins/http-express.js";
import { hono } from "../plugins/http-hono.js";
import { trpc } from "../plugins/http-trpc.js";
import { orpc } from "../plugins/http-orpc.js";
import { kysely } from "../plugins/kysely.js";
import { sqlQueries } from "../plugins/sql-queries.js";
import { typesPlugin } from "../plugins/types.js";
import { valibot } from "../plugins/valibot.js";
import { zod } from "../plugins/zod.js";
import { generate } from "../generate.js";
import { ConfigFromMemory } from "../services/config.js";
import {
  DatabaseIntrospectionService,
  type DatabaseIntrospection,
} from "../services/introspection.js";
import {
  ConnectionFailed,
  IntrospectionFailed,
  FixtureReadError,
  FixtureExecutionError,
  FileResolverError,
  SpecVerificationError,
} from "../errors.js";
import type { Plugin } from "../runtime/types.js";
import { verifyReadmeSpec } from "../testing/readme-spec.js";

const databaseName = "postgres";
const databaseVisitor = "app_visitor";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../../../");
const fixturePath = resolve(repoRoot, "packages/pg-sourcerer/test-fixtures/readme-users.sql");

const readFixture = Effect.tryPromise({
  try: () => readFile(fixturePath, "utf8"),
  catch: error =>
    new FixtureReadError({
      message: "Failed to read test fixture file",
      path: fixturePath,
      cause: error,
    }),
});

const createPglite: Effect.Effect<PGlite, ConnectionFailed> = Effect.tryPromise({
  try: async () => {
    const db = new PGlite({
      database: databaseName,
      extensions: {
        citext,
        pgcrypto,
      },
    });
    await db.waitReady;
    return db;
  },
  catch: error =>
    new ConnectionFailed({
      message: "Failed to create PGlite instance",
      connectionString: "pglite://",
      cause: error,
    }),
});

const applyFixture = (db: PGlite, sql: string) => {
  const replaced = sql.replace(/:DATABASE_VISITOR/g, databaseVisitor);
  return Effect.tryPromise({
    try: () => db.exec(replaced),
    catch: error =>
      new FixtureExecutionError({
        message: "Failed to execute SQL fixture in PGlite",
        cause: error,
      }),
  });
};

const makeIntrospectionLayer = (db: PGlite) =>
  Layer.succeed(DatabaseIntrospectionService, {
    introspect: () =>
      Effect.tryPromise({
        try: async () => {
          const result = await db.query<{ introspection: string }>(makeIntrospectionQuery());
          const raw = result.rows[0]?.introspection;
          if (!raw) {
            throw new IntrospectionFailed({
              message: "Introspection returned no results",
              schema: "*",
              cause: null,
            });
          }
          return parseIntrospectionResults(raw, true);
        },
        catch: error =>
          error instanceof IntrospectionFailed
            ? error
            : new IntrospectionFailed({
                message: "PGlite introspection failed",
                schema: "*",
                cause: error,
              }),
      }),
  } satisfies DatabaseIntrospection);

const generateConfig = (outputDir: string, plugins: readonly Plugin[]) => ({
  connectionString: "pglite://",
  role: databaseVisitor,
  schemas: ["app_public"],
  outputDir,
  plugins,
});

const toResolvedConfig = (config: ReturnType<typeof generateConfig>) => ({
  connectionString: config.connectionString,
  role: config.role,
  schemas: config.schemas,
  outputDir: config.outputDir,
  configDir: config.outputDir, // Use outputDir as configDir so userModule paths are relative to output
  typeHints: [],
  plugins: config.plugins.flat() as Plugin[],
});

/**
 * Creates an Effect-based file resolver that looks up files in memory.
 */
const createFileResolver =
  (fileMap: Map<string, string>) =>
  (filePath: string): Effect.Effect<string, FileResolverError> =>
    Effect.gen(function* () {
      const content = fileMap.get(filePath);
      if (!content) {
        return yield* new FileResolverError({
          message: "File not found in memory",
          requestedPath: filePath,
          availablePaths: Array.from(fileMap.keys()),
        });
      }
      return content;
    });

const passes: ReadonlyArray<{
  id: string;
  outputDir: string;
  plugins: readonly Plugin[];
}> = [
  {
    id: "zod-orpc-raw",
    outputDir: "generated/zod-http",
    plugins: [
      typesPlugin(),
      sqlQueries({
        sqlImport: {
          _tag: "UserModuleRef" as const,
          path: "../../db.js",
          named: ["sql"],
          validate: false,
        },
      }),
      zod(), // exportTypes defaults to true
      orpc(),
    ],
  },
  {
    id: "elysia-zod-kysely",
    outputDir: "generated/elysia",
    plugins: [kysely(), zod(), elysia()],
  },
  {
    id: "kysely-zod-express",
    outputDir: "generated/kysely",
    plugins: [kysely(), zod(), express()],
  },
  {
    id: "kysely-arktype-hono",
    outputDir: "generated/arktype",
    plugins: [kysely(), arktype(), hono()],
  },
  {
    id: "valibot-types-raw-trpc",
    outputDir: "generated/valibot",
    plugins: [typesPlugin(), sqlQueries(), valibot({ exportTypes: false }), trpc()],
  },
  {
    id: "effect",
    outputDir: "generated/effect",
    plugins: [typesPlugin(), ...effectPlugin()],
  },
] as const;

describe("README spec", () => {
  it.effect(
    "matches generated output",
    () =>
      Effect.gen(function* () {
        const db = yield* createPglite;
        const fixture = yield* readFixture;
        yield* applyFixture(db, fixture);

      const introspectionLayer = makeIntrospectionLayer(db);
      const runtimeLayer = Layer.mergeAll(introspectionLayer, NodeContext.layer);

      // Collect all emitted files in memory (dryRun mode)
      const allFiles = new Map<string, string>();

      yield* Effect.forEach(passes, pass =>
        Effect.gen(function* () {
          console.log(`\n=== PASS: ${pass.id} ===\n`);
          const config = toResolvedConfig(generateConfig(pass.outputDir, pass.plugins));

          const result = yield* generate({ outputDir: pass.outputDir, dryRun: true }).pipe(
            Effect.provide(runtimeLayer),
            Effect.provide(ConfigFromMemory(config)),
          );

          // Store emitted files in memory (resolve relative to repoRoot)
          for (const file of result.emittedFiles) {
            const fullPath = resolve(repoRoot, pass.outputDir, file.path);
            allFiles.set(fullPath, file.content);
          }

          return result;
        }),
      );

      // Create Effect-based file resolver
      const fileResolver = createFileResolver(allFiles);

      // Convert to Promise-based resolver for verifyReadmeSpec
      const promiseResolver = (filePath: string) => Effect.runPromise(fileResolver(filePath));

      // Verify README spec using in-memory files
      yield* Effect.tryPromise({
        try: () =>
          verifyReadmeSpec({
            repoRoot,
            fileResolver: promiseResolver,
          }),
        catch: error => {
          // Type-safe error handling
          if (error && typeof error === "object" && "details" in error) {
          // Narrow error shape defensively rather than using `as any`
          const verified = error && typeof error === "object" && "verified" in error
            ? (error as unknown as { verified?: number }).verified ?? 0
            : 0;
          const skipped = error && typeof error === "object" && "skipped" in error
            ? (error as unknown as { skipped?: number }).skipped ?? 0
            : 0;
          return new SpecVerificationError({
            message: "README specification verification failed",
            verified,
            skipped,
            failures: Array.isArray((error as unknown as { details?: unknown }).details)
              ? (error as unknown as { details?: string[] }).details!
              : [],
          });
          }
          return new SpecVerificationError({
            message: error instanceof Error ? error.message : String(error),
            verified: 0,
            skipped: 0,
            failures: [],
          });
        },
      }).pipe(
        Effect.catchTag("SpecVerificationError", error =>
          Effect.gen(function* () {
            console.error("\n=== VERIFICATION FAILURES ===");
            console.error(`Verified: ${error.verified}, Skipped: ${error.skipped}`);
            console.error(`Failures: ${error.failures.length}`);
            for (const detail of error.failures) {
              console.error("\n" + detail);
              console.error("---");
            }
            return yield* Effect.fail(error); // Re-throw after logging
          }),
        ),
      );
    }),
    15000,
  );
});

/// <reference lib="dom" />
/// <reference types="bun" />
/// <reference types="node" />

import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Effect, Layer } from "effect";
import { NodeContext } from "@effect/platform-node";
import { makeIntrospectionQuery, parseIntrospectionResults } from "@danielfgray/pg-introspection";
import {
  arktype,
  effect,
  elysia,
  express,
  hono,
  kysely,
  orpc,
  sqlQueries,
  trpc,
  typesPlugin,
  valibot,
  zod,
} from "../../pg-sourcerer/src/index.js";
import { generate } from "../../pg-sourcerer/src/generate.js";
import { ConfigFromMemory } from "../../pg-sourcerer/src/services/config.js";
import {
  DatabaseIntrospectionService,
  type DatabaseIntrospection,
} from "../../pg-sourcerer/src/services/introspection.js";
import { ConnectionFailed, IntrospectionFailed } from "../../pg-sourcerer/src/errors.js";
import type { Plugin } from "../../pg-sourcerer/src/runtime/types.js";
import { resolve } from "node:path";
import { verifyReadmeSpec } from "../../pg-sourcerer/src/testing/readme-spec.js";

const databaseName = "postgres";
const databaseVisitor = "app_visitor";

const repoRoot = resolve(import.meta.dir, "../../..");
const fixturePath = resolve(repoRoot, "packages/pg-sourcerer/test-fixtures/readme-users.sql");
const outputRoot = resolve(import.meta.dir, "../generated-readme/minimal");

const readFixture = Effect.tryPromise({
  try: () => Bun.file(fixturePath).text(),
  catch: error => new Error(`Failed to read fixture ${fixturePath}: ${String(error)}`),
});

const createPglite: Effect.Effect<PGlite, ConnectionFailed> = Effect.tryPromise({
  try: () =>
    PGlite.create({
      database: databaseName,
      extensions: {
        citext,
        pgcrypto,
      },
    }),
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
    catch: error => new Error(`Fixture execution failed: ${String(error)}`),
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
  typeHints: [],
  plugins: config.plugins.flat() as Plugin[],
});

const passes: ReadonlyArray<{
  id: string;
  outputDir: string;
  plugins: readonly Plugin[];
}> = [
  {
    id: "zod-http",
    outputDir: resolve(outputRoot, "zod-http"),
    plugins: [
      typesPlugin(),
      zod(),
      sqlQueries(),
      elysia(),
      express(),
      hono(),
      trpc(),
      orpc(),
    ],
  },
  {
    id: "kysely",
    outputDir: resolve(outputRoot, "kysely"),
    plugins: [typesPlugin(), kysely()],
  },
  {
    id: "arktype",
    outputDir: resolve(outputRoot, "arktype"),
    plugins: [typesPlugin(), arktype()],
  },
  {
    id: "valibot",
    outputDir: resolve(outputRoot, "valibot"),
    plugins: [typesPlugin(), valibot()],
  },
  {
    id: "effect",
    outputDir: resolve(outputRoot, "effect"),
    plugins: [typesPlugin(), ...effect()],
  },
] as const;

const main = Effect.gen(function* () {
  const db = yield* createPglite;
  const fixture = yield* readFixture;
  yield* applyFixture(db, fixture);

  const introspectionLayer = makeIntrospectionLayer(db);
  const runtimeLayer = Layer.mergeAll(introspectionLayer, NodeContext.layer);

  yield* Effect.forEach(passes, pass =>
    generate({ outputDir: pass.outputDir }).pipe(
      Effect.provide(runtimeLayer),
      Effect.provide(ConfigFromMemory(toResolvedConfig(generateConfig(pass.outputDir, pass.plugins)))),
      Effect.tap(() => Effect.log(`Generated README minimal output: ${pass.id}`)),
    ),
  );

  yield* Effect.promise(() => verifyReadmeSpec());
});

Effect.runPromise(main).catch(error => {
  console.error(error);
  process.exit(1);
});

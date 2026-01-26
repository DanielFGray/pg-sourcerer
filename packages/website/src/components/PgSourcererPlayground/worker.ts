import { Effect } from "effect";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import {
  createInflection,
  createIRBuilderService,
  createTypeHintRegistry,
  defineConfig,
  emitFiles,
  makeIntrospectionQuery,
  makeInflectionLayer,
  parseIntrospectionResults,
  runPlugins,
  typesPlugin,
  zod,
  sqlQueries,
  kysely,
  arktype,
  valibot,
  effect,
  elysia,
  express,
  hono,
  trpc,
  orpc,
} from "@danielfgray/pg-sourcerer/browser";

type GenerateRequest = {
  type: "generate";
  requestId: string;
  schemaSql: string;
  configSource: string;
};

type GenerateResponse = {
  type: "generated";
  requestId: string;
  ok: boolean;
  durationMs?: number;
  files?: Array<{ path: string; content: string }>;
  error?: string;
};

const evaluateConfig = (source: string) => {
  const scope = {
    defineConfig,
    typesPlugin,
    zod,
    sqlQueries,
    kysely,
    arktype,
    valibot,
    effect,
    elysia,
    express,
    hono,
    trpc,
    orpc,
  };

  const stripped = source
    .replace(/^\s*import[\s\S]*?;\s*$/gm, "")
    .replace(/export\s+default\s+/, "return ");

  const fn = new Function(...Object.keys(scope), `"use strict";\n${stripped}`);
  const result = fn(...Object.values(scope)) as unknown;
  if (!result) {
    throw new Error("Config evaluation returned empty result. Use export default defineConfig(...).");
  }
  return result as ReturnType<typeof defineConfig>;
};

let dbPromise: Promise<PGlite> | null = null;

const getDb = () => {
  if (!dbPromise) {
    dbPromise = PGlite.create({
      database: "playground",
      extensions: { citext, pgcrypto },
    });
  }
  return dbPromise;
};

const buildFiles = async (schemaSql: string, configSource: string) => {
  const config = evaluateConfig(configSource);
  const db = await getDb();
  await db.exec("drop schema if exists app_public cascade;");

  const sql = schemaSql.replace(/:DATABASE_VISITOR/g, "app_visitor");
  await db.exec(sql);

  const raw = await db.query<{ introspection: string }>(makeIntrospectionQuery());
  const introspectionRaw = raw.rows[0]?.introspection;
  if (!introspectionRaw) {
    throw new Error("Introspection returned no results.");
  }
  const introspection = parseIntrospectionResults(introspectionRaw, true);

  const irBuilder = createIRBuilderService();
  const ir = await Effect.runPromise(
    irBuilder
      .build(introspection, {
        schemas: config.schemas ?? ["public"],
        role: config.role,
      })
      .pipe(Effect.provide(makeInflectionLayer(config.inflection))),
  );

  const pluginResult = await Effect.runPromise(
    runPlugins({
      plugins: config.plugins.flat(),
      ir,
      typeHints: createTypeHintRegistry(config.typeHints ?? []),
      inflection: createInflection(config.inflection),
      defaultFile: config.defaultFile,
      outputDir: config.outputDir ?? "generated",
    }),
  );

  return emitFiles(pluginResult, {
    outputDir: config.outputDir ?? "generated",
  });
};

self.onmessage = async event => {
  const data = event.data as GenerateRequest;
  if (data.type !== "generate") return;

  const start = performance.now();
  try {
    const files = await buildFiles(data.schemaSql, data.configSource);
    const durationMs = Math.round(performance.now() - start);
    const response: GenerateResponse = {
      type: "generated",
      requestId: data.requestId,
      ok: true,
      durationMs,
      files: files.map(file => ({ path: file.path, content: file.content })),
    };
    self.postMessage(response);
  } catch (error) {
    const response: GenerateResponse = {
      type: "generated",
      requestId: data.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};

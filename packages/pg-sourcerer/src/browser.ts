/**
 * Browser-focused entry point for pg-sourcerer.
 *
 * Excludes Node-only config loaders and file system helpers.
 */

// Config + types
export { Config, TypeHint, TypeHintMatch, type ConfigInput, type ResolvedConfig } from "./config";

// Browser-friendly defineConfig (no Node deps)
export function defineConfig(
  config: import("./config").ConfigInput,
): import("./config").ConfigInput {
  return config;
}

// IR + builder
export {
  createIRBuilder,
  freezeIR,
  type SemanticIR,
  type SemanticIRBuilder,
} from "./ir/semantic-ir";
export { createIRBuilderService } from "./services/ir-builder";

// Inflection + type hints
export {
  createInflection,
  defaultInflection,
  makeInflectionLayer,
  composeInflectionConfigs,
  composeInflection,
  type InflectionConfig,
  type CoreInflection,
} from "./services/inflection";
export {
  createTypeHintRegistry,
  emptyTypeHintRegistry,
  type TypeHintRegistry,
  type TypeHintFieldMatch,
} from "./services/type-hints";

// Orchestrator + emit (string outputs)
export {
  runPlugins,
  type OrchestratorConfig,
  type OrchestratorResult,
} from "./runtime/orchestrator";
export { emitFiles, type EmittedFile, type EmitConfig } from "./runtime/emit-browser";

// Introspection helpers
export { makeIntrospectionQuery, parseIntrospectionResults } from "@danielfgray/pg-introspection";

// Plugins
export { typesPlugin } from "./plugins/types";
export { zod, type ZodConfig } from "./plugins/zod";
export { arktype, type ArkTypeConfig } from "./plugins/arktype";
export { valibot, type ValibotConfig } from "./plugins/valibot";
export { effect, type EffectConfig } from "./plugins/effect/index";
export { express, type HttpExpressConfig } from "./plugins/http-express";
export { elysia, type HttpElysiaConfig } from "./plugins/http-elysia";
export { hono, type HttpHonoConfig } from "./plugins/http-hono";
export { kysely, type KyselyConfig } from "./plugins/kysely";
export { sqlQueries, type SqlQueriesConfig } from "./plugins/sql-queries";
export { orpc, type HttpOrpcConfig } from "./plugins/http-orpc";
export { trpc, type HttpTrpcConfig } from "./plugins/http-trpc";

export { userModule } from "./user-module";

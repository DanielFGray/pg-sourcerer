/**
 * Testing Utilities
 *
 * Helpers for testing plugins and the generation pipeline.
 *
 * ## Plugin Testing
 *
 * ```typescript
 * import { testPlugin, testIR, testConfig } from "pg-sourcerer/testing"
 *
 * it.effect("generates types", () =>
 *   Effect.gen(function* () {
 *     const result = yield* testPlugin(myPlugin, {
 *       ir: testIR({ entities: [...] }),
 *     })
 *     expect(result.declarations).toHaveLength(1)
 *   })
 * )
 * ```
 *
 * ## IR Building
 *
 * Use testIRWithEntities with real entities from ir-builder, or create
 * minimal stubs for unit tests that don't need full introspection data.
 */

import { Effect } from "effect";
import type { Plugin } from "./runtime/types.js";
import {
  runPlugins,
  type OrchestratorConfig,
  type OrchestratorResult,
} from "./runtime/orchestrator.js";
import { emitFiles, type EmittedFile } from "./runtime/emit.js";
import type { SemanticIR, Entity } from "./ir/semantic-ir.js";
import { defaultInflection, type CoreInflection } from "./services/inflection.js";
import { emptyTypeHintRegistry, type TypeHintRegistry } from "./services/type-hints.js";

// =============================================================================
// Test IR Builders
// =============================================================================

/**
 * Create a minimal SemanticIR for testing.
 *
 * Most tests just need an empty or partial IR. For tests that don't need
 * real entity structures, use actual IRBuilder or provide entities directly.
 */
export function testIR(overrides?: Partial<SemanticIR>): SemanticIR {
  return {
    schemas: ["public"],
    entities: new Map(),
    artifacts: new Map(),
    extensions: [],
    introspectedAt: new Date(),
    ...overrides,
  };
}

/**
 * Create a SemanticIR with entities from a map or array.
 *
 * @example
 * ```typescript
 * // From array (uses entity.name as key)
 * const ir = testIRWithEntities([userEntity, postEntity])
 *
 * // From map
 * const ir = testIRWithEntities(new Map([["User", userEntity]]))
 * ```
 */
export function testIRWithEntities(
  entities: ReadonlyMap<string, Entity> | readonly Entity[],
): SemanticIR {
  const entityMap = Array.isArray(entities) ? new Map(entities.map(e => [e.name, e])) : entities;
  return testIR({ entities: entityMap as Map<string, Entity> });
}

// =============================================================================
// Test Orchestrator Config
// =============================================================================

/**
 * Options for testConfig.
 */
export interface TestConfigOptions {
  /** IR to use (defaults to empty testIR) */
  ir?: SemanticIR;
  /** Inflection config */
  inflection?: CoreInflection;
  /** Type hints */
  typeHints?: TypeHintRegistry;
  /** Default file for unmatched symbols */
  defaultFile?: string;
  /** Output directory */
  outputDir?: string;
}

/**
 * Create an OrchestratorConfig for testing.
 */
export function testConfig(options: TestConfigOptions = {}): OrchestratorConfig {
  return {
    plugins: [],
    ir: options.ir ?? testIR(),
    inflection: options.inflection ?? defaultInflection,
    typeHints: options.typeHints ?? emptyTypeHintRegistry,
    defaultFile: options.defaultFile ?? "index.ts",
    outputDir: options.outputDir ?? "src/generated",
  };
}

// =============================================================================
// Plugin Test Helpers
// =============================================================================

/**
 * Options for testing a plugin.
 */
export interface TestPluginOptions {
  /** IR to use (defaults to empty testIR) */
  ir?: SemanticIR;
  /** Inflection config */
  inflection?: CoreInflection;
  /** Type hints */
  typeHints?: TypeHintRegistry;
  /** Default file for unmatched symbols */
  defaultFile?: string;
  /** Output directory */
  outputDir?: string;
  /** Additional plugins to run before this one (for dependencies) */
  dependencies?: readonly Plugin[];
}

/**
 * Run a single plugin through the orchestrator and return results.
 *
 * Useful for unit testing plugins in isolation.
 *
 * @example
 * ```typescript
 * it.effect("declares User type", () =>
 *   Effect.gen(function* () {
 *     const result = yield* testPlugin(typesPlugin)
 *     expect(result.declarations).toContainEqual(
 *       expect.objectContaining({ name: "User" })
 *     )
 *   })
 * )
 * ```
 */
export function testPlugin(
  plugin: Plugin,
  options: TestPluginOptions = {},
): Effect.Effect<OrchestratorResult, unknown> {
  const config = testConfig({
    ir: options.ir,
    inflection: options.inflection,
    typeHints: options.typeHints,
    defaultFile: options.defaultFile,
    outputDir: options.outputDir,
  });

  const allPlugins = [...(options.dependencies ?? []), plugin];

  return runPlugins({ ...config, plugins: allPlugins });
}

/**
 * Run a plugin and emit files, returning both orchestration and emit results.
 *
 * @example
 * ```typescript
 * it.effect("generates valid TypeScript", () =>
 *   Effect.gen(function* () {
 *     const { files } = yield* testPluginEmit(typesPlugin, {
 *       ir: testIRWithEntities([...]),
 *     })
 *     expect(files[0].content).toContain("export type User")
 *   })
 * )
 * ```
 */
export function testPluginEmit(
  plugin: Plugin,
  options: TestPluginOptions = {},
): Effect.Effect<{ result: OrchestratorResult; files: readonly EmittedFile[] }, unknown> {
  return testPlugin(plugin, options).pipe(
    Effect.map(result => ({
      result,
      files: emitFiles(result),
    })),
  );
}

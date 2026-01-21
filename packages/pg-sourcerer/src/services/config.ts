/**
 * Config Service
 *
 * Effect-based configuration with multiple providers.
 *
 * ## Provider Pattern
 *
 * ConfigProvider is how config gets loaded - file, in-memory, wizard.
 * Each provider returns Effect<ResolvedConfig, ConfigError>.
 *
 * Providers can be chained with withFallback:
 *   withFallback(FileProvider(), () => WizardProvider())
 *
 * ## Layer Constructors
 *
 * - ConfigFromFile: Load from file, fail if not found
 * - ConfigFromMemory: Use provided config directly (testing)
 * - ConfigWithFallback: Load from file, fallback to another provider
 */

import { Context, Effect, Layer } from "effect";
import type { ResolvedConfig } from "../config.js";
import { ConfigNotFound, ConfigInvalid } from "../errors.js";
import { createConfigLoader, CONFIG_FILE_NAMES } from "./config-loader.js";

// ============================================================================
// Config Provider Interface
// ============================================================================

/**
 * A ConfigProvider knows how to produce a ResolvedConfig.
 * Different providers: file, wizard, in-memory, env vars.
 */
export interface ConfigProvider {
  readonly load: Effect.Effect<ResolvedConfig, ConfigNotFound | ConfigInvalid>;
}

// ============================================================================
// Config Providers
// ============================================================================

/**
 * File-based config provider using lilconfig.
 */
export const FileConfigProvider = (opts?: {
  readonly configPath?: string;
  readonly searchFrom?: string;
}): ConfigProvider => ({
  load: Effect.gen(function* () {
    const loader = createConfigLoader();
    return yield* loader.load(opts);
  }),
});

/**
 * In-memory config provider - returns the provided config directly.
 * Useful for testing or programmatic usage.
 */
export const InMemoryConfigProvider = (config: ResolvedConfig): ConfigProvider => ({
  load: Effect.succeed(config),
});

/**
 * Create a provider that tries primary first, falls back to secondary.
 * ConfigNotFound from primary triggers fallback; ConfigInvalid propagates.
 */
export const withFallback = (
  primary: ConfigProvider,
  fallback: () => ConfigProvider,
): ConfigProvider => ({
  load: primary.load.pipe(Effect.catchTag("ConfigNotFound", () => fallback().load)),
});

// ============================================================================
// Service Definition
// ============================================================================

/**
 * Service that provides the loaded configuration.
 * The service value IS the ResolvedConfig directly.
 */
export class ConfigService extends Context.Tag("ConfigService")<ConfigService, ResolvedConfig>() {}

// ============================================================================
// Layer Constructors
// ============================================================================

/**
 * Load config from file. Fails with ConfigNotFound if not found.
 */
export const ConfigFromFile = (opts?: {
  readonly configPath?: string;
  readonly searchFrom?: string;
}): Layer.Layer<ConfigService, ConfigNotFound | ConfigInvalid> =>
  Layer.effect(ConfigService, FileConfigProvider(opts).load);

/**
 * Provide config directly (for testing or programmatic use).
 */
export const ConfigFromMemory = (config: ResolvedConfig): Layer.Layer<ConfigService> =>
  Layer.succeed(ConfigService, config);

/**
 * Alias for ConfigFromMemory - clearer name for test contexts.
 */
export const ConfigTest = ConfigFromMemory;

/**
 * Load config with fallback provider chain.
 *
 * @example
 * ```typescript
 * // Try file first, fall back to wizard if not found
 * ConfigWithFallback(
 *   FileConfigProvider(),
 *   () => WizardConfigProvider()
 * )
 * ```
 */
export const ConfigWithFallback = (
  primary: ConfigProvider,
  fallback: () => ConfigProvider,
): Layer.Layer<ConfigService, ConfigNotFound | ConfigInvalid> =>
  Layer.effect(ConfigService, withFallback(primary, fallback).load);

// ============================================================================
// Utility
// ============================================================================

/**
 * Get the default search paths for config files.
 */
export const getConfigSearchPaths = (searchFrom: string = process.cwd()): string[] =>
  CONFIG_FILE_NAMES.map(name => `${searchFrom}/${name}`);

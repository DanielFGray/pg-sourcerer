/**
 * Config Service
 *
 * Provides loaded configuration via Effect DI.
 *
 * This is the service that effects depend on to get config.
 * The config-loader.ts provides the loading logic, while this
 * module provides the service tag and layer constructors.
 *
 * Layers available:
 * - ConfigFromFile: Load from file, fail if not found
 * - ConfigWithInit: Load from file, or run interactive init (for CLI)
 * - ConfigTest: Provide config directly for testing
 */

import { Console, Context, Effect, Layer } from "effect";
import { FileSystem, Terminal } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import type { ResolvedConfig } from "../config.js";
import { ConfigNotFound, ConfigInvalid } from "../errors.js";
import { createConfigLoader, CONFIG_FILE_NAMES } from "./config-loader.js";

// ============================================================================
// Service Definition
// ============================================================================

/**
 * Service that provides the loaded configuration.
 * The service value IS the ResolvedConfig directly.
 */
export class ConfigService extends Context.Tag("ConfigService")<
  ConfigService,
  ResolvedConfig
>() {}

// ============================================================================
// Layer Constructors
// ============================================================================

/**
 * Load config from file. Fails with ConfigNotFound if not found.
 */
export const ConfigFromFile = (opts?: {
  configPath?: string;
  searchFrom?: string;
}): Layer.Layer<ConfigService, ConfigNotFound | ConfigInvalid> =>
  Layer.effect(
    ConfigService,
    Effect.gen(function* () {
      const loader = createConfigLoader();
      return yield* loader.load(opts);
    }),
  );

/**
 * Load config from file, or run interactive init if not found.
 * This is the layer to use for CLI commands.
 *
 * Flow:
 * 1. Try to load config from file
 * 2. If ConfigNotFound, print message and run init prompts
 * 3. After init writes config, load it
 * 4. Return the loaded config
 */
export const ConfigWithInit = (opts?: {
  configPath?: string;
  searchFrom?: string;
}): Layer.Layer<
  ConfigService,
  ConfigInvalid | Error | Terminal.QuitException | PlatformError,
  Terminal.Terminal | FileSystem.FileSystem
> =>
  Layer.effect(
    ConfigService,
    Effect.gen(function* () {
      const loader = createConfigLoader();

      return yield* loader.load(opts).pipe(
        Effect.catchTag("ConfigNotFound", (error: ConfigNotFound) =>
          Effect.gen(function* () {
            yield* Console.error(`\n✗ No config file found`);
            yield* Console.error(`  Searched: ${error.searchPaths.join(", ")}`);

            // Dynamic import to avoid circular dependency with init.ts
            const initModule = yield* Effect.promise(() => import("../init.js"));
            const result = yield* initModule.runInit;

            // Load the newly created config
            return yield* loader.load({ configPath: result.configPath });
          }),
        ),
      );
    }),
  );

/**
 * Provide config directly for testing.
 */
export const ConfigTest = (config: ResolvedConfig): Layer.Layer<ConfigService> =>
  Layer.succeed(ConfigService, config);

/**
 * Get the default search paths for config files.
 */
export const getConfigSearchPaths = (searchFrom: string = process.cwd()): string[] =>
  CONFIG_FILE_NAMES.map(name => `${searchFrom}/${name}`);

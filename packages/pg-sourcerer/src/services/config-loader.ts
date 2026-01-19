/**
 * Config Loader Service
 *
 * Loads and validates pgsourcerer.config.{ts,js,mjs} using lilconfig.
 * Wraps the async config loading in Effect for proper error handling.
 */
import { Context, Effect, Layer, Schema as S, ParseResult, pipe } from "effect";
import { lilconfig } from "lilconfig";
import { Config, type ConfigInput, type ResolvedConfig } from "../config.js";
import { ConfigNotFound, ConfigInvalid } from "../errors.js";


/**
 * Config Loader service interface
 */
export interface ConfigLoader {
  /**
   * Load configuration from file.
   * @param configPath - Optional explicit path to config file
   * @param searchFrom - Directory to search from (default: cwd)
   */
  readonly load: (options?: {
    readonly configPath?: string;
    readonly searchFrom?: string;
  }) => Effect.Effect<ResolvedConfig, ConfigNotFound | ConfigInvalid>;
}

/**
 * ConfigLoader service tag
 */
export class ConfigLoaderService extends Context.Tag("ConfigLoader")<
  ConfigLoaderService,
  ConfigLoader
>() {}

/**
 * Default config file names to search for
 */
export const CONFIG_FILE_NAMES = [
  "pgsourcerer.config.ts",
  "pgsourcerer.config.js",
  "pgsourcerer.config.mjs",
  "pgsourcerer.config.cjs",
];

/**
 * Dynamic import loader for TypeScript files (Bun handles natively)
 */
const dynamicImport = async (filepath: string) => {
  const mod = (await import(filepath)) as { default: unknown };
  return mod.default ?? mod;
};

/**
 * Create the lilconfig instance with TypeScript support
 */
function createLilconfig() {
  return lilconfig("pgsourcerer", {
    searchPlaces: CONFIG_FILE_NAMES,
    loaders: { ".ts": dynamicImport },
  });
}

/**
 * Format Schema decode errors into readable strings
 */
function formatSchemaErrors(error: ParseResult.ParseError): readonly string[] {
  // Use the error message which is already formatted
  return [error.message];
}

/**
 * Create a ConfigLoader implementation
 */
export function createConfigLoader(): ConfigLoader {
  const lc = createLilconfig();

  return {
    load: options =>
      Effect.gen(function* () {
        const searchFrom = options?.searchFrom ?? process.cwd();
        const configPath = options?.configPath;

        // Search for or load specific config file
        const result = yield* Effect.tryPromise({
          try: async () => {
            if (configPath) {
              return await lc.load(configPath);
            }
            return await lc.search(searchFrom);
          },
          catch: error =>
            new ConfigInvalid({
              message: `Failed to load config: ${error instanceof Error ? error.message : String(error)}`,
              path: configPath ?? searchFrom,
              errors: [String(error)],
            }),
        });

        // Check if config was found
        if (!result || result.isEmpty) {
          return yield* Effect.fail(
            new ConfigNotFound({
              message: "No configuration file found",
              searchPaths: CONFIG_FILE_NAMES.map(name => `${searchFrom}/${name}`),
            }),
          );
        }

        const filepath = result.filepath;

        // Validate with Effect Schema
        const parseResult = yield* pipe(
          S.decodeUnknown(Config)(result.config),
          Effect.mapError(
            parseError =>
              new ConfigInvalid({
                message: `Invalid configuration in ${filepath}`,
                path: filepath,
                errors: formatSchemaErrors(parseError),
              }),
          ),
        );

        // Return resolved config
        const resolved: ResolvedConfig = {
          connectionString: parseResult.connectionString,
          schemas: parseResult.schemas,
          outputDir: parseResult.outputDir,
          role: parseResult.role,
          typeHints: parseResult.typeHints,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- inflection is S.Any in schema, validated by plugin system
          inflection: parseResult.inflection,
          plugins: parseResult.plugins,
          formatter: parseResult.formatter,
          defaultFile: parseResult.defaultFile,
        };

        return resolved;
      }),
  };
}

/**
 * Live layer for ConfigLoader
 */
export const ConfigLoaderLive = Layer.succeed(ConfigLoaderService, createConfigLoader());

/**
 * Helper to define a config (provides type safety for users)
 *
 * Uses `ConfigInput` which properly types `inflection` and `plugins`.
 */
export function defineConfig(config: ConfigInput): ConfigInput {
  return config;
}

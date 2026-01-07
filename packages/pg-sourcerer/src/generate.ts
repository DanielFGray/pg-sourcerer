/**
 * Generate Orchestration Function
 *
 * Threads together the full code generation pipeline:
 * 1. Load config
 * 2. Introspect database
 * 3. Build IR
 * 4. Prepare and run plugins
 * 5. Write files
 */
import { Effect, Layer, Console } from "effect"
import { FileSystem, Path } from "@effect/platform"
import type { ResolvedConfig } from "./config.js"
import type { ConfiguredPlugin, RunResult } from "./services/plugin-runner.js"
import {
  ConfigLoaderService,
  ConfigLoaderLive,
} from "./services/config-loader.js"
import {
  DatabaseIntrospectionService,
  DatabaseIntrospectionLive,
} from "./services/introspection.js"
import { createIRBuilderService } from "./services/ir-builder.js"
import { PluginRunner } from "./services/plugin-runner.js"
import { createFileWriter, type WriteResult } from "./services/file-writer.js"
import { TypeHintsLive } from "./services/type-hints.js"
import { makeInflectionLayer } from "./services/inflection.js"
import type { SemanticIR } from "./ir/semantic-ir.js"
import {
  ConfigNotFound,
  ConfigInvalid,
  ConnectionFailed,
  IntrospectionFailed,
  TagParseError,
  CapabilityConflict,
  CapabilityCycle,
  CapabilityNotSatisfied,
  DuplicatePlugin,
  PluginConfigInvalid,
  PluginExecutionFailed,
  EmitConflict,
  SymbolConflict,
  WriteError,
} from "./errors.js"

/**
 * Options for the generate function
 */
export interface GenerateOptions {
  /** Path to config file (optional - will search if not provided) */
  readonly configPath?: string
  /** Directory to search for config from (default: cwd) */
  readonly searchFrom?: string
  /** Override output directory from config */
  readonly outputDir?: string
  /** Dry run - don't write files, just return what would be written */
  readonly dryRun?: boolean
  /** Verbose logging */
  readonly verbose?: boolean
}

/**
 * Result of a generate operation
 */
export interface GenerateResult {
  /** The loaded configuration */
  readonly config: ResolvedConfig
  /** The built semantic IR */
  readonly ir: SemanticIR
  /** Plugin execution results */
  readonly pluginResult: RunResult
  /** File write results */
  readonly writeResults: readonly WriteResult[]
}

/**
 * All possible errors from the generate pipeline
 */
export type GenerateError =
  | ConfigNotFound
  | ConfigInvalid
  | ConnectionFailed
  | IntrospectionFailed
  | TagParseError
  | CapabilityConflict
  | CapabilityCycle
  | CapabilityNotSatisfied
  | DuplicatePlugin
  | PluginConfigInvalid
  | PluginExecutionFailed
  | EmitConflict
  | SymbolConflict
  | WriteError

/**
 * The main generate pipeline
 */
export const generate = (
  options: GenerateOptions = {}
): Effect.Effect<
  GenerateResult,
  GenerateError,
  | ConfigLoaderService
  | DatabaseIntrospectionService
  | PluginRunner
  | FileSystem.FileSystem
  | Path.Path
> =>
  Effect.gen(function* () {
    const verbose = options.verbose ?? false

    // 1. Load configuration
    if (verbose) yield* Console.log("Loading configuration...")
    const configLoader = yield* ConfigLoaderService
    const config = yield* configLoader.load(
      // Only include defined properties to satisfy exactOptionalPropertyTypes
      Object.fromEntries(
        Object.entries({
          configPath: options.configPath,
          searchFrom: options.searchFrom,
        }).filter(([, v]) => v !== undefined)
      ) as { configPath?: string; searchFrom?: string }
    )
    if (verbose) yield* Console.log(`  Schemas: ${config.schemas.join(", ")}`)
    if (verbose) yield* Console.log(`  Plugins: ${config.plugins.length}`)

    // 2. Introspect database
    if (verbose) yield* Console.log("Introspecting database...")
    const dbService = yield* DatabaseIntrospectionService
    const introspection = yield* dbService.introspect({
      connectionString: config.connectionString,
    })
    if (verbose) {
      const tableCount = introspection.classes.filter(
        (c) => c.relkind === "r"
      ).length
      yield* Console.log(`  Found ${tableCount} tables`)
    }

    // 3. Build IR
    if (verbose) yield* Console.log("Building semantic IR...")
    const irBuilder = createIRBuilderService()
    
    // Create inflection layer from config (or use defaults)
    const inflectionLayer = makeInflectionLayer(config.inflection)
    
    const ir = yield* irBuilder
      .build(introspection, { schemas: config.schemas as string[] })
      .pipe(Effect.provide(inflectionLayer))
    if (verbose) {
      yield* Console.log(`  Entities: ${ir.entities.size}`)
      yield* Console.log(`  Enums: ${ir.enums.size}`)
    }

    // 4. Prepare and run plugins
    if (verbose) yield* Console.log("Running plugins...")
    const runner = yield* PluginRunner

    // Cast plugins from config to ConfiguredPlugin[]
    // The config stores them as unknown[], but they should be ConfiguredPlugin[]
    const plugins = config.plugins as readonly ConfiguredPlugin[]

    const prepared = yield* runner.prepare(plugins)
    if (verbose) {
      yield* Console.log(
        `  Execution order: ${prepared.map((p) => p.plugin.name).join(" → ")}`
      )
    }

    // Create TypeHints layer from config
    const typeHintsLayer = TypeHintsLive(config.typeHints)

    const pluginResult = yield* runner
      .run(prepared, ir)
      .pipe(Effect.provide(typeHintsLayer))

    if (verbose) {
      const emissions = pluginResult.emissions.getAll()
      yield* Console.log(`  Generated ${emissions.length} files`)
    }

    // 5. Write files
    const outputDir = options.outputDir ?? config.outputDir
    if (verbose) yield* Console.log(`Writing files to ${outputDir}...`)

    const writer = createFileWriter()
    const writeResults = yield* writer.writeAll(
      pluginResult.emissions.getAll(),
      {
        outputDir,
        dryRun: options.dryRun ?? false,
      }
    )

    if (verbose) {
      const written = writeResults.filter((r) => r.written).length
      yield* Console.log(
        `  Wrote ${written} files${options.dryRun ? " (dry run)" : ""}`
      )
    }

    return {
      config,
      ir,
      pluginResult,
      writeResults,
    }
  })

/**
 * Layer that provides all services needed for generate()
 */
export const GenerateLive = Layer.mergeAll(
  ConfigLoaderLive,
  Layer.effect(DatabaseIntrospectionService, DatabaseIntrospectionLive),
  PluginRunner.Default
)

/**
 * Run generate with all dependencies provided
 *
 * This is the main entry point for programmatic usage.
 * Requires FileSystem and Path from @effect/platform.
 */
export const runGenerate = (
  options: GenerateOptions = {}
): Effect.Effect<
  GenerateResult,
  GenerateError,
  FileSystem.FileSystem | Path.Path
> => generate(options).pipe(Effect.provide(GenerateLive))

/**
 * Generate Orchestration Function
 *
 * Threads together the full code generation pipeline:
 * 1. Load config
 * 2. Introspect database
 * 3. Build IR
 * 4. Prepare and run plugins
 * 5. Write files
 *
 * Logging:
 * - Effect.log (INFO) - Progress messages shown by default
 * - Effect.logDebug (DEBUG) - Detailed info (entity names, file lists)
 * 
 * Configure via Logger.withMinimumLogLevel at the call site.
 */
import { Effect, Layer } from "effect"
import { FileSystem, Path, Command, CommandExecutor } from "@effect/platform"
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
import { getEnumEntities, getTableEntities, getDomainEntities, getCompositeEntities, type SemanticIR } from "./ir/semantic-ir.js"
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
  FormatError,
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
  | FormatError

/**
 * Run a formatter command on the output directory.
 * Spawns a subprocess and fails if it exits non-zero.
 * Output is piped to the parent process's stdout/stderr.
 */
const runFormatter = (
  command: string,
  outputDir: string
): Effect.Effect<void, FormatError, CommandExecutor.CommandExecutor> => {
  // Parse command string into program and args, append outputDir
  const parts = command.split(/\s+/).filter(Boolean)
  const program = parts[0] ?? "echo"
  const args = parts.slice(1)
  const cmd = Command.make(program, ...args, outputDir).pipe(
    Command.stdout("inherit"),
    Command.stderr("inherit"),
    Command.runInShell(true)
  )
  return Command.exitCode(cmd).pipe(
    Effect.flatMap((code) =>
      code === 0
        ? Effect.void
        : Effect.fail(
            new FormatError({
              message: `Formatter command failed with exit code ${code}: ${command} ${outputDir}`,
              path: outputDir,
              cause: new Error(`Exit code: ${code}`),
            })
          )
    ),
    Effect.mapError((cause) =>
      cause instanceof FormatError
        ? cause
        : new FormatError({
            message: `Formatter command failed: ${command} ${outputDir}`,
            path: outputDir,
            cause,
          })
    )
  )
}

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
  | FileSystem.FileSystem
  | Path.Path
  | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    // 1. Load configuration
    yield* Effect.logDebug("Loading configuration...")
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
    yield* Effect.logDebug(`Config schemas: ${config.schemas.join(", ")}`)
    yield* Effect.logDebug(`Config plugins: ${config.plugins.length}`)

    // 2. Introspect database
    yield* Effect.log("Introspecting database...")
    const dbService = yield* DatabaseIntrospectionService
    const introspection = yield* dbService.introspect({
      connectionString: config.connectionString,
      role: config.role,
    })

    const tables = introspection.classes.filter((c) => c.relkind === "r")
    const views = introspection.classes.filter((c) => c.relkind === "v")

    yield* Effect.log(`Found ${tables.length} tables, ${views.length} views`)

    if (tables.length > 0) {
      const tableNames = tables.map((t) => t.relname).sort()
      yield* Effect.logDebug(`Tables: ${tableNames.join(", ")}`)
    }
    if (views.length > 0) {
      const viewNames = views.map((v) => v.relname).sort()
      yield* Effect.logDebug(`Views: ${viewNames.join(", ")}`)
    }

    // 3. Build IR with user's inflection config
    yield* Effect.log("Building semantic IR...")
    const irBuilder = createIRBuilderService()

    // Create inflection layer from config (or use defaults)
    const inflectionLayer = makeInflectionLayer(config.inflection)

    const ir = yield* irBuilder
      .build(introspection, { schemas: config.schemas as string[], role: config.role })
      .pipe(Effect.provide(inflectionLayer))

    const enumEntities = getEnumEntities(ir)
    const tableEntities = getTableEntities(ir)
    const domainEntities = getDomainEntities(ir)
    const compositeEntities = getCompositeEntities(ir)
    
    const counts = [
      `${tableEntities.length} tables/views`,
      `${enumEntities.length} enums`,
    ]
    if (domainEntities.length > 0) counts.push(`${domainEntities.length} domains`)
    if (compositeEntities.length > 0) counts.push(`${compositeEntities.length} composites`)
    yield* Effect.log(`Built ${counts.join(", ")}`)

    if (ir.entities.size > 0) {
      const entityNames = [...ir.entities.keys()].sort()
      yield* Effect.logDebug(`Entities: ${entityNames.join(", ")}`)
    }
    if (enumEntities.length > 0) {
      const enumNames = enumEntities.map(e => e.name).sort()
      yield* Effect.logDebug(`Enums: ${enumNames.join(", ")}`)
    }

    // 4. Prepare and run plugins
    // NOTE: We create the PluginRunner with the user's inflection layer
    // so plugins use the same naming conventions as the IR
    yield* Effect.log("Running plugins...")
    
    // Cast plugins from config to ConfiguredPlugin[]
    // The config stores them as unknown[], but they should be ConfiguredPlugin[]
    const plugins = config.plugins as readonly ConfiguredPlugin[]

    // Create TypeHints layer from config
    const typeHintsLayer = TypeHintsLive(config.typeHints)

    // Run plugins with user's inflection (not default identity inflection)
    // Use DefaultWithoutDependencies so our inflectionLayer takes precedence
    const pluginResult = yield* Effect.gen(function* () {
      const runner = yield* PluginRunner
      const prepared = yield* runner.prepare(plugins)
      
      const pluginNames = prepared.map((p) => p.plugin.name)
      yield* Effect.log(`Plugin order: ${pluginNames.join(" → ")}`)
      
      return yield* runner.run(prepared, ir)
    }).pipe(
      Effect.provide(typeHintsLayer),
      Effect.provide(
        Layer.provide(PluginRunner.DefaultWithoutDependencies, inflectionLayer)
      )
    )

    const emissions = pluginResult.emissions.getAll()
    yield* Effect.log(`Generated ${emissions.length} files`)

    // 5. Write files
    const outputDir = options.outputDir ?? config.outputDir
    yield* Effect.log(`Writing to ${outputDir}...`)

    const writer = createFileWriter()
    const writeResults = yield* writer.writeAll(emissions, {
      outputDir,
      dryRun: options.dryRun ?? false,
    })

    // 6. Format files (if formatter provided and not dry run)
    if (config.formatter && !options.dryRun) {
      yield* Effect.log(`Formatting with: ${config.formatter} ${outputDir}`)
      yield* runFormatter(config.formatter, outputDir)
      yield* Effect.log("Formatting complete")
    }

    // Log each file at debug level
    yield* Effect.forEach(writeResults, (result) => {
      const status = options.dryRun
        ? "(dry run)"
        : result.written
          ? "✓"
          : "–"
      return Effect.logDebug(`${status} ${result.path}`)
    })

    const written = writeResults.filter((r) => r.written).length
    const dryRunSuffix = options.dryRun ? " (dry run)" : ""
    yield* Effect.log(`Wrote ${written} files${dryRunSuffix}`)

    return {
      config,
      ir,
      pluginResult,
      writeResults,
    }
  })

/**
 * Layer that provides all services needed for generate()
 * 
 * Note: PluginRunner is NOT included here because it needs to be
 * created with the user's inflection config (from loaded config).
 * The generate() function creates the PluginRunner internally.
 */
export const GenerateLive = Layer.mergeAll(
  ConfigLoaderLive,
  Layer.effect(DatabaseIntrospectionService, DatabaseIntrospectionLive),
)

/**
 * Run generate with all dependencies provided
 *
 * This is the main entry point for programmatic usage.
 * Requires FileSystem, Path, and CommandExecutor from @effect/platform.
 */
export const runGenerate = (
  options: GenerateOptions = {}
): Effect.Effect<
  GenerateResult,
  GenerateError,
  FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor
> => generate(options).pipe(Effect.provide(GenerateLive))

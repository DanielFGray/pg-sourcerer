/**
 * Generate Orchestration Function
 *
 * Threads together the full code generation pipeline:
 * 1. Load config
 * 2. Introspect database
 * 3. Build IR
 * 4. Run plugins
 * 5. Emit files
 * 6. Write files
 *
 * Logging:
 * - Effect.log (INFO) - Progress messages shown by default
 * - Effect.logDebug (DEBUG) - Detailed info (entity names, file lists)
 *
 * Configure via Logger.withMinimumLogLevel at the call site.
 */
import { Effect, Layer, Schema } from "effect";
import { Command } from "@effect/platform";
import type { ResolvedConfig } from "./config.js";
import type { Plugin } from "./runtime/types.js";
import { runPlugins, type OrchestratorResult } from "./runtime/orchestrator.js";
import { emitFiles, type EmittedFile } from "./runtime/emit.js";
import { ConfigService } from "./services/config.js";
import {
  DatabaseIntrospectionService,
  DatabaseIntrospectionLive,
} from "./services/introspection.js";
import { createIRBuilderService } from "./services/ir-builder.js";
import { createFileWriter, type WriteResult } from "./services/file-writer.js";
import { createInflection, makeInflectionLayer } from "./services/inflection.js";
import { createTypeHintRegistry } from "./services/type-hints.js";
import {
  getEnumEntities,
  getTableEntities,
  getDomainEntities,
  getCompositeEntities,
  type SemanticIR,
} from "./ir/semantic-ir.js";

/**
 * Options for the generate function
 */
export interface GenerateOptions {
  /** Override output directory from config */
  readonly outputDir?: string;
  /** Dry run - don't write files, just return what would be written */
  readonly dryRun?: boolean;
}

/**
 * Result of a generate operation
 */
export interface GenerateResult {
  /** The loaded configuration */
  readonly config: ResolvedConfig;
  /** The built semantic IR */
  readonly ir: SemanticIR;
  /** Plugin execution results */
  readonly pluginResult: OrchestratorResult;
  /** Emitted files before writing */
  readonly emittedFiles: readonly EmittedFile[];
  /** File write results */
  readonly writeResults: readonly WriteResult[];
}

export class FormatError extends Schema.TaggedError<FormatError>()("FormatError", {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Run a formatter command on the output directory.
 * Spawns a subprocess and fails if it exits non-zero.
 * Output is piped to the parent process's stdout/stderr.
 */
const runFormatter = (command: string, outputDir: string) => {
  const parts = command.split(/\s+/).filter(Boolean);
  const program = parts[0] ?? "echo";
  const args = parts.slice(1);
  const cmd = Command.make(program, ...args, outputDir).pipe(
    Command.stdout("inherit"),
    Command.stderr("inherit"),
    Command.runInShell(true),
  );
  return Command.exitCode(cmd).pipe(
    Effect.flatMap(code =>
      code === 0
        ? Effect.void
        : Effect.fail(
            new FormatError({
              message: `Formatter command failed with exit code ${code}: ${command} ${outputDir}`,
              path: outputDir,
              cause: new Error(`Exit code: ${code}`),
            }),
          ),
    ),
    Effect.mapError(cause =>
      cause instanceof FormatError
        ? cause
        : new FormatError({
            message: `Formatter command failed: ${command} ${outputDir}`,
            path: outputDir,
            cause,
          }),
    ),
  );
};

/**
 * The main generate pipeline.
 *
 * Config is provided via ConfigService layer (Effect DI).
 * Use ConfigFromFile or ConfigWithFallback layers depending on context.
 */
export const generate = (options: GenerateOptions = {}) =>
  Effect.gen(function* () {
    yield* Effect.logDebug("Loading configuration...");
    const config = yield* ConfigService;
    yield* Effect.logDebug(`Config schemas: ${config.schemas.join(", ")}`);
    yield* Effect.logDebug(`Config plugins: ${config.plugins.length}`);

    yield* Effect.log("Introspecting database...");
    const dbService = yield* DatabaseIntrospectionService;
    const introspection = yield* dbService.introspect({
      connectionString: config.connectionString,
      role: config.role,
    });

    const tables = introspection.classes.filter(c => c.relkind === "r");
    const views = introspection.classes.filter(c => c.relkind === "v");

    yield* Effect.log(`Found ${tables.length} tables, ${views.length} views`);

    if (tables.length > 0) {
      const tableNames = tables.map(t => t.relname).sort();
      yield* Effect.logDebug(`Tables: ${tableNames.join(", ")}`);
    }
    if (views.length > 0) {
      const viewNames = views.map(v => v.relname).sort();
      yield* Effect.logDebug(`Views: ${viewNames.join(", ")}`);
    }

    yield* Effect.log("Building semantic IR...");
    const irBuilder = createIRBuilderService();
    const inflectionLayer = makeInflectionLayer(config.inflection);

    const ir = yield* irBuilder
      .build(introspection, {
        schemas: config.schemas as string[],
        role: config.role,
      })
      .pipe(Effect.provide(inflectionLayer));

    const enumEntities = getEnumEntities(ir);
    const tableEntities = getTableEntities(ir);
    const domainEntities = getDomainEntities(ir);
    const compositeEntities = getCompositeEntities(ir);

    const counts = [`${tableEntities.length} tables/views`, `${enumEntities.length} enums`];
    if (domainEntities.length > 0) counts.push(`${domainEntities.length} domains`);
    if (compositeEntities.length > 0) counts.push(`${compositeEntities.length} composites`);
    yield* Effect.log(`Built ${counts.join(", ")}`);

    if (ir.entities.size > 0) {
      const entityNames = [...ir.entities.keys()].sort();
      yield* Effect.logDebug(`Entities: ${entityNames.join(", ")}`);
    }
    if (enumEntities.length > 0) {
      const enumNames = enumEntities.map(e => e.name).sort();
      yield* Effect.logDebug(`Enums: ${enumNames.join(", ")}`);
    }

    yield* Effect.log("Running plugins...");
    const plugins = config.plugins as readonly Plugin[];
    const pluginNames = plugins.map(p => p.name);
    yield* Effect.log(`Plugins: ${pluginNames.join(", ")}`);

    const typeHints = createTypeHintRegistry(config.typeHints ?? []);
    const inflection = createInflection(config.inflection);

    const pluginResult = yield* runPlugins({
      plugins,
      ir,
      typeHints,
      inflection,
      defaultFile: config.defaultFile,
      outputDir: config.outputDir,
    });

    const emittedFiles = emitFiles(pluginResult);
    yield* Effect.log(`Generated ${emittedFiles.length} files`);

    const outputDir = options.outputDir ?? config.outputDir;
    yield* Effect.log(`Writing to ${outputDir}...`);

    const writer = createFileWriter();
    const writeResults = yield* writer.writeAll(emittedFiles, {
      outputDir,
      dryRun: options.dryRun ?? false,
    });

    if (config.formatter && !options.dryRun) {
      yield* Effect.log(`Formatting with: ${config.formatter} ${outputDir}`);
      yield* runFormatter(config.formatter, outputDir);
      yield* Effect.log("Formatting complete");
    }

    yield* Effect.forEach(
      writeResults,
      result => {
        const status = options.dryRun ? "(dry run)" : result.written ? "✓" : "–";
        return Effect.logDebug(`${status} ${result.path}`);
      },
      { discard: true },
    );

    const written = writeResults.filter(r => r.written).length;
    const dryRunSuffix = options.dryRun ? " (dry run)" : "";
    yield* Effect.log(`Wrote ${written} files${dryRunSuffix}`);

    return {
      config,
      ir,
      pluginResult,
      emittedFiles,
      writeResults,
    };
  });

/**
 * Layer that provides database introspection for generate().
 */
export const GenerateLive = Layer.effect(DatabaseIntrospectionService, DatabaseIntrospectionLive);

/**
 * Run generate with database introspection provided.
 */
export const runGenerate = (options: GenerateOptions = {}) =>
  generate(options).pipe(Effect.provide(GenerateLive));

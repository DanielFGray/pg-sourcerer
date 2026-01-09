#!/usr/bin/env bun
/**
 * pg-sourcerer CLI
 *
 * Command-line interface for code generation from PostgreSQL schema.
 *
 * Log verbosity is controlled via the built-in --log-level flag:
 *   --log-level debug   Show detailed output (table names, file paths)
 *   --log-level info    Default - show progress messages
 *   --log-level none    Suppress all output except errors
 */
import { Command, Options } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Option } from "effect";
import { runGenerate, type GenerateError } from "./generate.js";
import { runInit } from "./init.js";
import packageJson from "../package.json" with { type: "json" };

// ============================================================================
// Options
// ============================================================================

const configPath = Options.file("config").pipe(
  Options.withAlias("c"),
  Options.withDescription("Path to config file"),
  Options.optional,
);

const outputDir = Options.directory("output").pipe(
  Options.withAlias("o"),
  Options.withDescription("Override output directory"),
  Options.optional,
);

const dryRun = Options.boolean("dry-run").pipe(
  Options.withAlias("n"),
  Options.withDescription("Show what would be generated without writing files"),
  Options.withDefault(false),
);

// ============================================================================
// Shared Generate Logic
// ============================================================================

interface GenerateArgs {
  readonly configPath: Option.Option<string>;
  readonly outputDir: Option.Option<string>;
  readonly dryRun: boolean;
}

const runGenerateCommand = (args: GenerateArgs) => {
  const opts = {
    configPath: Option.getOrUndefined(args.configPath),
    outputDir: Option.getOrUndefined(args.outputDir),
    dryRun: args.dryRun,
  };

  const logSuccess = (result: { writeResults: readonly { written: boolean }[] }) => {
    const written = result.writeResults.filter(r => r.written).length;
    const total = result.writeResults.length;
    const suffix = args.dryRun ? " (dry run)" : "";
    return Console.log(`\n✓ Generated ${args.dryRun ? total : written} files${suffix}`);
  };

  return runGenerate(opts).pipe(
    Effect.tap(logSuccess),
    // Handle ConfigNotFound specially - offer to run init
    Effect.catchTag("ConfigNotFound", error =>
      Console.error(`\n✗ No config file found`).pipe(
        Effect.andThen(Console.error(`  Searched: ${error.searchPaths.join(", ")}`)),
        Effect.andThen(
          runInit.pipe(
            Effect.asVoid,
            Effect.catchAll(() => Effect.fail(error)),
          ),
        ),
      ),
    ),
    // Handle errors with extra details
    Effect.catchTags({
      ConfigInvalid: error => logErrorWithDetails(error, error.errors),
      PluginConfigInvalid: error => logErrorWithDetails(error, error.errors),
      CapabilityCycle: error =>
        Console.error(`\n✗ Error: ${error._tag}`).pipe(
          Effect.andThen(Console.error(`  ${error.message}`)),
          Effect.andThen(Console.error(`  Cycle: ${error.cycle.join(" → ")}`)),
          Effect.andThen(Effect.fail(error)),
        ),
    }),
    // Generic fallback for remaining errors
    Effect.catchAll((error: GenerateError) =>
      Console.error(`\n✗ Error: ${error._tag}`).pipe(
        Effect.andThen(Console.error(`  ${error.message}`)),
        Effect.andThen(Effect.fail(error)),
      ),
    ),
  );
};

/** Log an error with a list of detail messages */
const logErrorWithDetails = (error: GenerateError, details: readonly string[]) =>
  Console.error(`\n✗ Error: ${error._tag}`).pipe(
    Effect.andThen(Console.error(`  ${error.message}`)),
    Effect.andThen(Effect.forEach(details, e => Console.error(`    - ${e}`))),
    Effect.andThen(Effect.fail(error)),
  );

// ============================================================================
// Commands
// ============================================================================

const generateCommand = Command.make("generate", { configPath, outputDir, dryRun }, runGenerateCommand);

const initCommand = Command.make("init", {}, () =>
  runInit.pipe(
    Effect.flatMap(result =>
      result.runGenerate ? runGenerateCommand({ configPath: Option.none(), outputDir: Option.none(), dryRun: false }) : Effect.void,
    ),
  ),
);

// Root command runs generate by default (which triggers init if no config)
const rootCommand = Command.make("pgsourcerer", { configPath, outputDir, dryRun }, runGenerateCommand).pipe(
  Command.withSubcommands([generateCommand, initCommand]),
);

// ============================================================================
// CLI App
// ============================================================================

const cli = Command.run(rootCommand, {
  name: "pgsourcerer",
  version: packageJson.version,
});

// Run with Node.js platform
cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);

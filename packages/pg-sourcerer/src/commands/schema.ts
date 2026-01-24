/**
 * Schema CLI Commands
 *
 * Commands for interactive schema/DDL management.
 */
import { Command, Options } from "@effect/cli";
import { Console, Effect, Option } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";
import { runSchemaBuilder } from "../schema-builder/index.js";
import { ConfigService, FileConfigProvider, ConfigWithFallback } from "../services/config.js";
import { runInit } from "../init.js";

// =============================================================================
// Options
// =============================================================================

const outputPath = Options.file("output").pipe(
  Options.withAlias("o"),
  Options.withDescription("Output file path for generated DDL"),
  Options.optional,
);

const schemaName = Options.text("schema").pipe(
  Options.withAlias("s"),
  Options.withDescription("Default schema name"),
  Options.withDefault("public"),
);

const configPath = Options.file("config").pipe(
  Options.withAlias("c"),
  Options.withDescription("Path to config file"),
  Options.optional,
);

// =============================================================================
// schema new - Create new table interactively
// =============================================================================

interface SchemaNewArgs {
  readonly outputPath: Option.Option<string>;
  readonly schemaName: string;
  readonly configPath: Option.Option<string>;
}

const runSchemaNew = (args: SchemaNewArgs) => {
  const runNew = Effect.gen(function* () {
    yield* Console.log("Loading configuration...");

    const config = yield* ConfigService;
    const pool = new pg.Pool({ connectionString: config.connectionString });

    try {
      yield* Console.log("Starting Schema Builder...\n");

      // Run the TUI (this is async, not Effect-based)
      const result = yield* Effect.tryPromise({
        try: () =>
          runSchemaBuilder({
            defaultSchema: args.schemaName,
            db: pool,
          }),
        catch: (error) => new Error(`Schema builder failed: ${error}`),
      });

      // Small delay to let terminal settle after alternate screen exit
      yield* Effect.sleep("100 millis");

      if (!result) {
        // Use sync write to ensure output after alternate screen
        process.stdout.write("\nCancelled.\n");
        return;
      }

      // Use sync writes to ensure output appears after alternate screen
      process.stdout.write("\n--- Generated DDL ---\n\n");
      process.stdout.write(result.ddl + "\n");

      // Determine output path
      const outPath = Option.getOrUndefined(args.outputPath);

      if (outPath) {
        // Write to specified path
        const dir = path.dirname(outPath);
        if (dir && dir !== ".") {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(outPath, result.ddl + "\n");
        process.stdout.write(`\n✓ Saved to: ${outPath}\n`);
      } else {
        // Suggest a filename
        const suggestedName = `${result.state.tableName}.sql`;
        process.stdout.write(`\nTo save, run again with: --output ${suggestedName}\n`);
        process.stdout.write("Or copy the DDL above.\n");
      }
    } finally {
      yield* Effect.promise(() => pool.end());
    }
  });

  const configOpts = { configPath: Option.getOrUndefined(args.configPath) };
  const configLayer = ConfigWithFallback(
    FileConfigProvider(configOpts),
    () => FileConfigProvider(configOpts),
  );

  const runNewOnce = runNew.pipe(Effect.provide(configLayer));

  return runNewOnce.pipe(
    Effect.catchTags({
      ConfigNotFound: () =>
        Console.log("No config file found. Running init...").pipe(
          Effect.zipRight(runInit),
          Effect.zipRight(
            runNewOnce.pipe(
              Effect.catchTags({
                ConfigNotFound: () => Console.error("No config file found after init."),
                ConfigInvalid: (error) =>
                  Effect.forEach(error.errors, (e) => Console.error(`  - ${e}`)),
              }),
            ),
          ),
        ),
      ConfigInvalid: (error) => Effect.forEach(error.errors, (e) => Console.error(`  - ${e}`)),
    }),
  );
};

const schemaNewCommand = Command.make(
  "new",
  { outputPath, schemaName, configPath },
  runSchemaNew,
).pipe(Command.withDescription("Create a new table interactively"));

// =============================================================================
// schema command (parent)
// =============================================================================

export const schemaCommand = Command.make("schema", {}, () =>
  Console.log("Schema commands:\n  new    Create a new table interactively\n\nRun 'pgsourcerer schema <command> --help' for details."),
).pipe(
  Command.withDescription("Schema/DDL management commands"),
  Command.withSubcommands([schemaNewCommand]),
);

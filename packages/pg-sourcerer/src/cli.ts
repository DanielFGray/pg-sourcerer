/**
 * pg-sourcerer CLI
 */
import { Command, Options } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Option } from "effect";
import { runGenerate } from "./generate.js";
import { runInit } from "./init.js";
import { ConfigWithFallback, FileConfigProvider } from "./services/config.js";
import packageJson from "../package.json" with { type: "json" };

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

interface GenerateArgs {
  readonly configPath: Option.Option<string>;
  readonly outputDir: Option.Option<string>;
  readonly dryRun: boolean;
}

const runGenerateCommand = (args: GenerateArgs) => {
  const opts = {
    outputDir: Option.getOrUndefined(args.outputDir),
    dryRun: args.dryRun,
  };

  const logSuccess = (result: { writeResults: readonly { written: boolean }[] }) => {
    const written = result.writeResults.filter(r => r.written).length;
    const total = result.writeResults.length;
    const suffix = args.dryRun ? " (dry run)" : "";
    return Console.log(`\n✓ Generated ${args.dryRun ? total : written} files${suffix}`);
  };

  const configOpts = {
    configPath: Option.getOrUndefined(args.configPath),
  };

  const configLayer = ConfigWithFallback(FileConfigProvider(configOpts), () =>
    FileConfigProvider(configOpts),
  );

  return runGenerate(opts).pipe(
    Effect.provide(configLayer),
    Effect.tap(logSuccess),
    Effect.catchTags({
      ConfigNotFound: () =>
        Console.log("No config file found. Running init...").pipe(
          Effect.zipRight(runInit),
          Effect.tap(() => Console.log("\nRun 'pgsourcerer' again to generate code.")),
        ),
      ConfigInvalid: error =>
        Effect.forEach(error.errors, e => Console.error(`  - ${e}`)),
    }),
  );
};



const generateCommand = Command.make(
  "generate",
  { configPath, outputDir, dryRun },
  runGenerateCommand,
);

const initCommand = Command.make("init", {}, () =>
  runInit.pipe(Effect.tap(() => Console.log("\nRun 'pgsourcerer' to generate code."))),
);

const rootCommand = Command.make(
  "pgsourcerer",
  { configPath, outputDir, dryRun },
  runGenerateCommand,
).pipe(Command.withSubcommands([generateCommand, initCommand]));

const cli = Command.run(rootCommand, {
  name: "pgsourcerer",
  version: packageJson.version,
});

NodeRuntime.runMain(cli(process.argv).pipe(Effect.provide(NodeContext.layer)));

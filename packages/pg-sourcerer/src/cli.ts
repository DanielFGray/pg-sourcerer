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
import { Command, Options } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { runGenerate, type GenerateError } from "./generate.js"
import { runInit } from "./init.js"

// ============================================================================
// Options
// ============================================================================

const configPath = Options.file("config").pipe(
  Options.withAlias("c"),
  Options.withDescription("Path to config file"),
  Options.optional
)

const outputDir = Options.directory("output").pipe(
  Options.withAlias("o"),
  Options.withDescription("Override output directory"),
  Options.optional
)

const dryRun = Options.boolean("dry-run").pipe(
  Options.withAlias("n"),
  Options.withDescription("Show what would be generated without writing files"),
  Options.withDefault(false)
)

// ============================================================================
// Generate Command
// ============================================================================

const generateCommand = Command.make(
  "generate",
  { configPath, outputDir, dryRun },
  (args) =>
    Effect.gen(function* () {
      // Build options object, only including defined values
      const opts: {
        configPath?: string
        outputDir?: string
        dryRun?: boolean
      } = {
        dryRun: args.dryRun,
      }
      if (args.configPath._tag === "Some") {
        opts.configPath = args.configPath.value
      }
      if (args.outputDir._tag === "Some") {
        opts.outputDir = args.outputDir.value
      }

      const result = yield* runGenerate(opts)

      // Summary
      const written = result.writeResults.filter((r) => r.written).length
      const total = result.writeResults.length
      const suffix = args.dryRun ? " (dry run)" : ""

      yield* Console.log(`\n✓ Generated ${args.dryRun ? total : written} files${suffix}`)
    }).pipe(
      Effect.catchAll((error: GenerateError) =>
        Effect.gen(function* () {
          yield* Console.error(`\n✗ Error: ${error._tag}`)
          yield* Console.error(`  ${error.message}`)

          // Additional context based on error type
          if (error._tag === "ConfigNotFound") {
            yield* Console.error(`  Searched: ${error.searchPaths.join(", ")}`)
          } else if (error._tag === "ConfigInvalid") {
            for (const e of error.errors) {
              yield* Console.error(`    - ${e}`)
            }
          } else if (error._tag === "PluginConfigInvalid") {
            for (const e of error.errors) {
              yield* Console.error(`    - ${e}`)
            }
          } else if (error._tag === "CapabilityCycle") {
            yield* Console.error(`  Cycle: ${error.cycle.join(" → ")}`)
          }

          yield* Effect.fail(error)
        })
      )
    )
)

// ============================================================================
// Init Command
// ============================================================================

const initCommand = Command.make("init", {}, () => runInit)

// ============================================================================
// Root Command
// ============================================================================

const rootCommand = Command.make("pgsourcerer", {}, () =>
  Console.log("pg-sourcerer - Generate TypeScript from PostgreSQL\n\nRun 'pgsourcerer --help' for usage.")
).pipe(Command.withSubcommands([generateCommand, initCommand]))

// ============================================================================
// CLI App
// ============================================================================

const cli = Command.run(rootCommand, {
  name: "pgsourcerer",
  version: "0.0.1",
})

// Run with Node.js platform
cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)

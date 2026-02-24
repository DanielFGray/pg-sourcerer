#!/usr/bin/env bun
/// <reference types="bun" />
/// <reference types="node" />

/**
 * Runner script for README spec verification.
 * 
 * NOTE: This currently fails due to a bug where zod({ exportTypes: true })
 * causes SymbolCollision errors. The test uses exportTypes: false as a workaround,
 * but that means generated output doesn't match README expectations.
 * 
 * TODO: Fix zod plugin exportTypes bug, then re-enable this runner.
 */

import { Effect } from "effect";
import { Command } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const pgIntrospectionDir = resolve(repoRoot, "packages/pg-introspection");
const pgSourcererDir = resolve(repoRoot, "packages/pg-sourcerer");

const runCommand = (command: string, args: string[], cwd: string) =>
  Command.make(command, ...args).pipe(
    Command.workingDirectory(cwd),
    Command.stdout("inherit"),
    Command.stderr("inherit"),
    Command.runInShell(true),
    Command.exitCode,
    Effect.flatMap(code =>
      code === 0
        ? Effect.void
        : Effect.fail(new Error(`Command failed: ${command} ${args.join(" ")}`)),
    ),
  );

const main = Effect.gen(function* () {
  yield* Effect.log("Building pg-introspection...");
  yield* runCommand("bun", ["run", "build"], pgIntrospectionDir);
  
  yield* Effect.log("Running readme.test.ts...");
  yield* runCommand("bun", ["run", "test", "readme.test"], pgSourcererDir);
}).pipe(Effect.provide(NodeContext.layer));

Effect.runPromise(main).catch(error => {
  console.error(error);
  process.exit(1);
});

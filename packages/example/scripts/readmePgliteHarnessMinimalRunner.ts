/// <reference types="bun" />
/// <reference types="node" />

import { Effect } from "effect";
import { Command } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const pgIntrospectionDir = resolve(repoRoot, "packages/pg-introspection");
const exampleDir = resolve(repoRoot, "packages/example");

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
  yield* runCommand("bun", ["run", "build"], pgIntrospectionDir);
  yield* runCommand("bun", ["scripts/readmePgliteHarnessMinimal.ts"], exampleDir);
}).pipe(Effect.provide(NodeContext.layer));

Effect.runPromise(main).catch(error => {
  console.error(error);
  process.exit(1);
});

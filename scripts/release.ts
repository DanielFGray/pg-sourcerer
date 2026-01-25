/// <reference types="bun" />
/**
 * Release Script
 * 
 * Squash-merges develop into main for release-please to handle.
 * 
 * Usage:
 *   bun scripts/release.ts              # Squash-merge develop to main
 *   bun scripts/release.ts --dry-run    # Show what would happen without making changes
 * 
 * Workflow:
 * 1. Run this script from develop branch
 * 2. Script squash-merges develop into main and pushes
 * 3. CI runs, release-please creates a release PR with changelog
 * 4. Merge the release PR to trigger npm publish
 */

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

const run = async (command: string[], cwd?: string) => {
  console.log(`$ ${command.join(" ")}`);
  if (dryRun) return;
  
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
};

const runCapture = async (command: string[], cwd?: string): Promise<string> => {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(stderr.trim() || stdout.trim());
    process.exit(exitCode);
  }
  return stdout;
};

const runCheck = async (command: string[], cwd?: string): Promise<boolean> => {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
};

const ensureClean = async () => {
  const status = (await runCapture(["git", "status", "--porcelain"])).trim();
  if (status.length > 0) {
    console.error("Working tree not clean:\n" + status);
    process.exit(1);
  }
};

const ensureBranch = async (name: string) => {
  const branch = (await runCapture(["git", "branch", "--show-current"])).trim();
  if (branch !== name) {
    console.error(`Expected branch '${name}', got '${branch}'.`);
    process.exit(1);
  }
};

const ensureDevelopContainsMain = async () => {
  await run(["git", "fetch", "origin"]);
  const hasMain = await runCheck(["git", "merge-base", "--is-ancestor", "origin/main", "develop"]);
  if (!hasMain) {
    console.error("Develop is missing commits from main. Run: git merge origin/main");
    process.exit(1);
  }
};

const ensureDevelopUpToDate = async () => {
  const output = await runCapture([
    "git",
    "rev-list",
    "--left-right",
    "--count",
    "origin/develop...develop",
  ]);
  const [behind = 0] = output.trim().split("\t").map(Number);
  if (behind > 0) {
    console.error("Develop is behind origin/develop. Run: git pull");
    process.exit(1);
  }
};

const ensureDevelopAheadOfMain = async () => {
  const output = await runCapture([
    "git",
    "rev-list",
    "--count",
    "origin/main..develop",
  ]);
  const ahead = parseInt(output.trim(), 10);
  if (ahead === 0) {
    console.error("Develop has no commits ahead of main. Nothing to release.");
    process.exit(1);
  }
  console.log(`Develop is ${ahead} commit(s) ahead of main.`);
  return ahead;
};

const runTests = async () => {
  console.log("\nRunning tests...");
  await run(["bun", "run", "typecheck"], "packages/pg-sourcerer");
  await run(["bun", "run", "test:unit"], "packages/pg-sourcerer");
};

const getCommitSummary = async (): Promise<string> => {
  const log = await runCapture([
    "git",
    "log",
    "--oneline",
    "origin/main..develop",
  ]);
  const lines = log.trim().split("\n").filter(Boolean);
  
  // Group by conventional commit type
  const features = lines.filter(l => l.includes("feat"));
  const fixes = lines.filter(l => l.includes("fix"));
  const others = lines.filter(l => !l.includes("feat") && !l.includes("fix"));
  
  const parts: string[] = [];
  if (features.length) parts.push(`${features.length} feature(s)`);
  if (fixes.length) parts.push(`${fixes.length} fix(es)`);
  if (others.length) parts.push(`${others.length} other`);
  
  return parts.join(", ");
};

const squashMergeToMain = async (summary: string) => {
  console.log("\nSquash-merging develop into main...");
  
  // Checkout main
  await run(["git", "checkout", "main"]);
  await run(["git", "pull", "origin", "main"]);
  
  // Squash merge develop
  await run(["git", "merge", "--squash", "develop"]);
  
  // Commit with summary
  const message = `chore: merge develop (${summary})`;
  await run(["git", "commit", "-m", message]);
  
  // Push main
  await run(["git", "push", "origin", "main"]);
  
  // Return to develop
  await run(["git", "checkout", "develop"]);
};

const main = async () => {
  if (dryRun) {
    console.log("=== DRY RUN MODE ===\n");
  }
  
  console.log("Checking prerequisites...");
  await ensureClean();
  await ensureBranch("develop");
  await ensureDevelopContainsMain();
  await ensureDevelopUpToDate();
  await ensureDevelopAheadOfMain();
  
  await runTests();
  
  const summary = await getCommitSummary();
  console.log(`\nCommit summary: ${summary}`);
  
  await squashMergeToMain(summary);
  
  console.log(`
Release merge complete!

Next steps:
1. Wait for CI to run on main
2. Release-please will create a PR with version bump and changelog
3. Review and merge the release PR
4. Publish will run automatically after merge
`);
};

main().catch(console.error);

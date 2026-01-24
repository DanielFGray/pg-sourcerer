import { $ } from "bun";

const version = process.argv[2];
if (!version) {
  console.error("Usage: bun scripts/release.ts <version>");
  process.exit(1);
}

const semverPattern = /^\d+\.\d+\.\d+$/;
if (!semverPattern.test(version)) {
  console.error(`Invalid version: ${version}. Expected X.Y.Z`);
  process.exit(1);
}

const run = async (command: string[], cwd?: string) => {
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

const runCapture = async (command: string[], cwd?: string) => {
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

const readText = async (path: string) => Bun.file(path).text();

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

const ensureTagAvailable = async (tag: string) => {
  const local = (await runCapture(["git", "tag", "--list", tag])).trim();
  if (local.length > 0) {
    console.error(`Tag ${tag} already exists locally.`);
    process.exit(1);
  }

  const remote = (await runCapture(["git", "ls-remote", "--tags", "origin", tag])).trim();
  if (remote.length > 0) {
    console.error(`Tag ${tag} already exists on origin.`);
    process.exit(1);
  }
};

const bumpVersion = async () => {
  const pkgPath = "packages/pg-sourcerer/package.json";
  const manifestPath = ".release-please-manifest.json";

  const pkg = JSON.parse(await readText(pkgPath)) as { version: string };
  pkg.version = version;
  await Bun.write(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  const manifest = JSON.parse(await readText(manifestPath)) as Record<string, string>;
  manifest["packages/pg-sourcerer"] = version;
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
};

const runTests = async () => {
  await run(["bun", "run", "typecheck"], "packages/pg-sourcerer");
  await run(["bun", "run", "test"], "packages/pg-sourcerer");
};

const commitVersion = async () => {
  await run([
    "git",
    "add",
    "packages/pg-sourcerer/package.json",
    ".release-please-manifest.json",
  ]);
  await run([
    "git",
    "commit",
    "-m",
    `chore: bump version to ${version}`,
    "-m",
    "- sync release-please manifest",
    "-m",
    `- prep release ${version}`,
  ]);
};

const pushDevelop = async () => {
  await run(["git", "push", "origin", "develop"]);
};

const mergeToMain = async () => {
  await run(["git", "checkout", "main"]);
  await run(["git", "pull", "origin", "main"]);
  await run([
    "git",
    "merge",
    "develop",
    "-m",
    `Release v${version} - prepare release`,
  ]);
  await run(["git", "tag", `v${version}`]);
  await run(["git", "push", "origin", "main"]);
  await run(["git", "push", "origin", `v${version}`]);
};

const triggerReleasePlease = async () => {
  await run(["gh", "workflow", "run", "release-please.yml", "--ref", "main"]);
};

const returnToDevelop = async () => {
  await run(["git", "checkout", "develop"]);
};

const main = async () => {
  await ensureClean();
  await ensureBranch("develop");
  await ensureTagAvailable(`v${version}`);
  await bumpVersion();
  await runTests();
  await commitVersion();
  await pushDevelop();
  await mergeToMain();
  await triggerReleasePlease();
  await returnToDevelop();
  console.log(`Release ${version} prepared and pushed.`);
};

await main();

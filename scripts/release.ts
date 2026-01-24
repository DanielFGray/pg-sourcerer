/// <reference types="bun" />

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

const runCaptureOptional = async (command: string[], cwd?: string) => {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
};

const runCheck = async (command: string[], cwd?: string) => {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
};

const readText = async (path: string) => Bun.file(path).text();

const parseVersion = (input: string) => {
  const [major = 0, minor = 0, patch = 0] = input.split(".").map(Number);
  return [major, minor, patch] as const;
};

const compareSemver = (left: string, right: string) => {
  const [lMajor, lMinor, lPatch] = parseVersion(left);
  const [rMajor, rMinor, rPatch] = parseVersion(right);
  if (lMajor !== rMajor) return lMajor - rMajor;
  if (lMinor !== rMinor) return lMinor - rMinor;
  return lPatch - rPatch;
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

const ensureReleasePleasePrClosed = async () => {
  const result = await runCaptureOptional([
    "gh",
    "pr",
    "list",
    "--state",
    "open",
    "--search",
    "release-please",
    "--json",
    "number,title",
  ]);
  if (result.exitCode !== 0) {
    console.warn("Warning: unable to check release-please PR status.");
    return;
  }

  const prs = JSON.parse(result.stdout) as Array<{ number: number; title: string }>;
  if (prs.length > 0) {
    console.error(
      [
        "Release-please PR already open:",
        ...prs.map(pr => `#${pr.number} ${pr.title}`),
      ].join("\n"),
    );
    process.exit(1);
  }
};

const ensureDevelopContainsMain = async () => {
  await run(["git", "fetch", "origin"]);
  const hasMain = await runCheck(["git", "merge-base", "--is-ancestor", "origin/main", "develop"]);
  if (!hasMain) {
    console.error("Develop is missing commits from main. Merge main into develop first.");
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
    console.error("Develop is behind origin/develop. Pull first.");
    process.exit(1);
  }
};

const ensureVersionAdvances = async () => {
  const manifest = JSON.parse(
    await readText(".release-please-manifest.json"),
  ) as Record<string, string>;
  const current = manifest["packages/pg-sourcerer"];
  if (!current) {
    console.error("Release-please manifest missing packages/pg-sourcerer version.");
    process.exit(1);
  }

  if (compareSemver(version, current) <= 0) {
    console.error(`Version must be greater than ${current}.`);
    process.exit(1);
  }

  const pkg = JSON.parse(
    await readText("packages/pg-sourcerer/package.json"),
  ) as { version: string };
  if (pkg.version !== current) {
    console.error("Package version and release-please manifest are out of sync.");
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

const main = async () => {
  await ensureClean();
  await ensureBranch("develop");
  await ensureDevelopContainsMain();
  await ensureDevelopUpToDate();
  await ensureReleasePleasePrClosed();
  await ensureVersionAdvances();
  await ensureTagAvailable(`v${version}`);
  await bumpVersion();
  await runTests();
  await commitVersion();
  await pushDevelop();
  console.log(
    [
      `Version bump ${version} committed and pushed to develop.`,
      "Next: merge develop into main and let release-please open the PR.",
    ].join("\n"),
  );
};

await main();

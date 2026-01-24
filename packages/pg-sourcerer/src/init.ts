/**
 * pg-sourcerer init command
 *
 * Interactive config generator using @effect/cli Prompt.
 */
import { Prompt } from "@effect/cli";
import { FileSystem, Terminal } from "@effect/platform";
import { Array, Console, Effect, HashMap, HashSet, Option, pipe } from "effect";
import path from "node:path";
import postgres from "postgres";
import type { Introspection } from "@danielfgray/pg-introspection";
import { introspectDatabase } from "./services/introspection.js";
import { ConfigFromFile, FileConfigProvider } from "./services/config.js";
import { conjure } from "./conjure/index.js";

interface PluginInfo {
  readonly value: string;
  readonly importName: string;
}

/** Maps plugin selection values to their import names from pg-sourcerer */
const pluginImportNames: Record<string, string> = {
  // Type generators
  types: "typesPlugin",
  zod: "zod",
  arktype: "arktype",
  effect: "effect",
  valibot: "valibot",
  // Kysely
  "kysely-types": "kysely",
  "kysely-queries": "kysely",
  // SQL queries
  "sql-queries": "sqlQueries",
  // HTTP frameworks
  "http-elysia": "elysia",
  "http-express": "express",
  "http-hono": "hono",
  "http-trpc": "trpc",
  "http-orpc": "orpc",
};

const getPluginInfo = (value: string): PluginInfo | undefined => {
  const importName = pluginImportNames[value];
  return importName ? { value, importName } : undefined;
};

interface EnvMatch {
  readonly key: string;
  readonly value: string;
  readonly source: ".env" | "process.env";
}

interface PackageJson {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

const POSTGRES_URL_REGEX = /^postgres(ql)?:\/\//i;

const findNearestPackageJsonPath = (
  startDir: string,
): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let currentDir = startDir;

    while (true) {
      const candidate = path.join(currentDir, "package.json");
      const exists = yield* fs.exists(candidate).pipe(Effect.catchAll(() => Effect.succeed(false)));
      if (exists) {
        return Option.some(candidate);
      }

      const parent = path.dirname(currentDir);
      if (parent === currentDir) {
        return Option.none();
      }

      currentDir = parent;
    }
  });

const readPackageJson = (
  packageJsonPath: string,
): Effect.Effect<PackageJson, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(packageJsonPath).pipe(
      Effect.flatMap((content) =>
        Effect.try({
          try: () => JSON.parse(content) as PackageJson,
          catch: (error) =>
            new Error(
              `Failed to parse package.json: ${error instanceof Error ? error.message : String(error)}`,
            ),
        }),
      ),
      Effect.catchAll(() => Effect.succeed({} as PackageJson)),
    );
  });

const collectDependencySet = (
  packageJson: PackageJson,
): HashSet.HashSet<string> =>
  pipe(
    [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ],
    HashSet.fromIterable,
  );

interface DetectedPluginDefaults {
  readonly hasKysely: boolean;
  readonly schemaPlugins: readonly string[];
  readonly httpPlugins: readonly string[];
}

const detectPluginDefaults: Effect.Effect<
  DetectedPluginDefaults,
  never,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const packageJsonPath = yield* findNearestPackageJsonPath(process.cwd());
  if (Option.isNone(packageJsonPath)) {
    return { hasKysely: false, schemaPlugins: [], httpPlugins: [] };
  }

  const packageJson = yield* readPackageJson(packageJsonPath.value);
  const dependencies = collectDependencySet(packageJson);

  const hasKysely =
    HashSet.has(dependencies, "kysely") || HashSet.has(dependencies, "kysely-codegen");

  const schemaPlugins = pipe(
    [
      { dependency: "zod", plugin: "zod" },
      { dependency: "arktype", plugin: "arktype" },
      { dependency: "effect", plugin: "effect" },
      { dependency: "valibot", plugin: "valibot" },
    ],
    Array.filter((entry) => HashSet.has(dependencies, entry.dependency)),
    Array.map((entry) => entry.plugin),
  );

  const httpPlugins = pipe(
    [
      { dependency: "elysia", plugin: "http-elysia" },
      { dependency: "express", plugin: "http-express" },
      { dependency: "hono", plugin: "http-hono" },
      { dependency: "@trpc/server", plugin: "http-trpc" },
      { dependency: "@orpc/server", plugin: "http-orpc" },
    ],
    Array.filter((entry) => HashSet.has(dependencies, entry.dependency)),
    Array.map((entry) => entry.plugin),
  );

  return { hasKysely, schemaPlugins, httpPlugins };
});

const parseDotEnv = (content: string): HashMap.HashMap<string, string> =>
  pipe(
    content.split("\n"),
    Array.map((line) => line.trim()),
    Array.filter((line) => line.length > 0 && !line.startsWith("#")),
    Array.filterMap((line) => {
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) return Option.none();

      const key = line.slice(0, eqIndex).trim();
      let value = line.slice(eqIndex + 1).trim();

      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      return Option.some([key, value] as const);
    }),
    HashMap.fromIterable,
  );

const filterPostgresUrls = (
  entries: HashMap.HashMap<string, string>,
  source: ".env" | "process.env",
): readonly EnvMatch[] =>
  pipe(
    entries,
    HashMap.filter((value) => POSTGRES_URL_REGEX.test(value)),
    HashMap.toEntries,
    Array.map(([key, value]) => ({ key, value, source })),
  );

const processEnvExcluding = (exclude: HashSet.HashSet<string>): HashMap.HashMap<string, string> =>
  pipe(
    Object.entries(process.env),
    Array.filter(([key, value]) => value != null && !HashSet.has(exclude, key)),
    Array.map(([key, value]) => [key, value!] as const),
    HashMap.fromIterable,
  );

const scanEnvForConnectionStrings: Effect.Effect<
  readonly EnvMatch[],
  never,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const envPath = `${process.cwd()}/.env`;

  const dotEnvMatches = yield* fs.readFileString(envPath).pipe(
    Effect.map((content) => filterPostgresUrls(parseDotEnv(content), ".env")),
    Effect.catchAll(() => Effect.succeed([] as readonly EnvMatch[])),
  );

  const dotEnvKeys = pipe(
    dotEnvMatches,
    Array.map((m) => m.key),
    HashSet.fromIterable,
  );

  const processEnvMatches = filterPostgresUrls(processEnvExcluding(dotEnvKeys), "process.env");

  return [...dotEnvMatches, ...processEnvMatches];
});

const connectionStringPrompt = Prompt.text({
  message: "Database connection string",
  validate: (value) =>
    value.trim().length === 0
      ? Effect.fail("Connection string is required")
      : Effect.succeed(value.trim()),
});

const promptAndTestConnection = (
  defaultValue?: string,
): Effect.Effect<string, Terminal.QuitException, Terminal.Terminal> =>
  Effect.gen(function* () {
    const prompt = defaultValue
      ? Prompt.text({ message: "Database connection string", default: defaultValue })
      : connectionStringPrompt;
    const connStr = yield* prompt;

    yield* Console.log("Testing connection...");
    const result = yield* testConnection(connStr).pipe(
      Effect.map((version) => ({ success: true as const, version })),
      Effect.catchAll((e) => Effect.succeed({ success: false as const, error: e.message })),
    );

    if (result.success) {
      yield* Console.log(`✓ Connected to ${result.version}\n`);
      return connStr;
    } else {
      yield* Console.error(`✗ ${result.error}`);
      yield* Console.log("Please try again.\n");
      return yield* promptAndTestConnection(connStr);
    }
  });

interface ConnectionResult {
  readonly connectionString: string;
  readonly configValue: string;
  readonly isEnvRef: boolean;
}

const getConnectionString: Effect.Effect<
  ConnectionResult,
  Terminal.QuitException,
  FileSystem.FileSystem | Terminal.Terminal
> = Effect.gen(function* () {
  const envMatches = yield* scanEnvForConnectionStrings;

  if (Array.isEmptyReadonlyArray(envMatches)) {
    const connectionString = yield* promptAndTestConnection();
    return { connectionString, configValue: connectionString, isEnvRef: false };
  }

  yield* Console.log(
    `Found ${envMatches.length} potential connection string${envMatches.length === 1 ? "" : "s"} in environment:\n`,
  );

  const choices = pipe(
    envMatches,
    Array.map((m) => ({
      title: `${m.key} (${m.source})`,
      value: m.key,
    })),
    Array.append({ title: "Enter manually", value: "__manual__" }),
  );

  const selected = yield* Prompt.select({
    message: "Select connection string",
    choices,
  });

  if (selected === "__manual__") {
    const connectionString = yield* promptAndTestConnection();
    return { connectionString, configValue: connectionString, isEnvRef: false };
  }

  const match = pipe(
    envMatches,
    Array.findFirst((m) => m.key === selected),
    Option.getOrThrow,
  );

  yield* Console.log(`\nTesting ${match.key}...`);

  const testResult = yield* testConnection(match.value).pipe(
    Effect.map((version) => ({ success: true as const, version })),
    Effect.catchAll((e) => Effect.succeed({ success: false as const, error: e.message })),
  );

  if (testResult.success) {
    yield* Console.log(`✓ Connected to ${testResult.version}\n`);
    return {
      connectionString: match.value,
      configValue: `process.env.${match.key}`,
      isEnvRef: true,
    };
  }

  yield* Console.error(`✗ ${testResult.error}`);
  yield* Console.log("Connection failed. Please enter manually.\n");
  const connectionString = yield* promptAndTestConnection(match.value);
  return { connectionString, configValue: connectionString, isEnvRef: false };
});

const makeRolePrompt = () =>
  Prompt.text({
    message: "PostgreSQL role (for RLS - leave empty if not using RLS)",
    default: "",
  }).pipe(Prompt.map((s) => s.trim() || undefined));

const makeSchemasPrompt = (introspection: Introspection) => {
  const schemaCounts = new Map<string, number>();

  for (const schema of introspection.namespaces) {
    if (schema.nspname.startsWith("pg_") || schema.nspname === "information_schema") continue;
    schemaCounts.set(schema.nspname, 0);
  }

  for (const c of introspection.classes) {
    if (c.relkind !== "r" && c.relkind !== "v" && c.relkind !== "m" && c.relkind !== "p") continue;
    const schema = c.getNamespace()?.nspname;
    if (!schema || schema.startsWith("pg_") || schema === "information_schema") continue;
    schemaCounts.set(schema, (schemaCounts.get(schema) ?? 0) + 1);
  }

  const schemas = [...schemaCounts.entries()].sort((a, b) => {
    if (a[0] === "public") return -1;
    if (b[0] === "public") return 1;
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });

  if (schemas.length === 0) {
    return Prompt.text({
      message: "Schemas to introspect (comma-separated)",
      default: "public",
    }).pipe(
      Prompt.map((s) =>
        s
          .split(",")
          .map((x) => x.trim())
          .filter((x) => x.length > 0),
      ),
    );
  }

  return Prompt.multiSelect({
    message: "Select schemas to introspect",
    choices: schemas.map(([name, count]) => ({
      title:
        count > 0
          ? `${name} (${count} table${count === 1 ? "" : "s"})`
          : `${name} (no tables)`,
      value: name,
      selected: name === "public" || schemas.length === 1,
    })),
  });
};

const makeOutputDirPrompt = () =>
  Prompt.text({
    message: "Output directory",
    default: "./generated",
  });

const formatDetectedTitle = (title: string, detected: boolean) =>
  detected ? `${title} (detected)` : title;

const buildSchemaChoices = (detectedPlugins: readonly string[]) => {
  const detectedSet = new Set(detectedPlugins);
  const entries = [
    { title: "Zod", value: "zod" },
    { title: "ArkType", value: "arktype" },
    { title: "Effect Schema", value: "effect" },
    { title: "Valibot", value: "valibot" },
  ];

  const detectedEntries = entries.filter((entry) => detectedSet.has(entry.value));
  const remainingEntries = entries.filter((entry) => !detectedSet.has(entry.value));
  const orderedEntries = [...detectedEntries, ...remainingEntries];

  return orderedEntries.map((entry) => ({
    title: formatDetectedTitle(entry.title, detectedSet.has(entry.value)),
    value: entry.value,
  }));
};

const buildQueryChoices = (hasKysely: boolean) => {
  const kyselyChoice = {
    title: formatDetectedTitle("kysely-queries - Query builders", hasKysely),
    value: "kysely-queries",
  };
  const sqlChoice = {
    title: "sql-queries - Raw SQL query functions",
    value: "sql-queries",
  };

  return hasKysely ? [kyselyChoice, sqlChoice] : [sqlChoice, kyselyChoice];
};

const buildHttpChoices = (detectedPlugins: readonly string[]) => {
  const detectedSet = new Set(detectedPlugins);
  const entries = [
    { title: "Elysia routes", value: "http-elysia" },
    { title: "Express routes", value: "http-express" },
    { title: "Hono routes", value: "http-hono" },
    { title: "tRPC router", value: "http-trpc" },
    { title: "oRPC router", value: "http-orpc" },
  ];

  const detectedEntries = entries.filter((entry) => detectedSet.has(entry.value));
  const remainingEntries = entries.filter((entry) => !detectedSet.has(entry.value));
  const orderedEntries = [...detectedEntries, ...remainingEntries];

  const choices = orderedEntries.map((entry) => ({
    title: formatDetectedTitle(entry.title, detectedSet.has(entry.value)),
    value: entry.value,
  }));

  return detectedEntries.length > 0
    ? [...choices, { title: "None", value: "" }]
    : [{ title: "None", value: "" }, ...choices];
};

const makePluginsPrompt = () =>
  Effect.gen(function* () {
    const detected = yield* detectPluginDefaults;

    const wantsSchema = yield* Prompt.confirm({
      message: "Generate schema validators?",
      initial: detected.schemaPlugins.length > 0,
    });

    const typePlugin = wantsSchema
      ? yield* Prompt.select({
          message: "Select schema library",
          choices: buildSchemaChoices(detected.schemaPlugins),
        })
      : "types";

    const wantsKyselyTypes = yield* Prompt.confirm({
      message: "Generate Kysely types?",
      initial: detected.hasKysely,
    });

    const wantsQueries = yield* Prompt.confirm({
      message: "Generate query helpers?",
      initial: detected.hasKysely,
    });

    const queryPlugin = wantsQueries
      ? yield* Prompt.select({
          message: "Select query style",
          choices: buildQueryChoices(detected.hasKysely),
        })
      : undefined;

    const httpPlugin = queryPlugin
      ? yield* Prompt.select({
          message: "HTTP/RPC framework (optional)",
          choices: buildHttpChoices(detected.httpPlugins),
        })
      : "";

    const shouldIncludeKyselyTypes = wantsKyselyTypes || queryPlugin === "kysely-queries";

    const selectedPlugins = [
      typePlugin,
      ...(shouldIncludeKyselyTypes ? ["kysely-types"] : []),
      ...(queryPlugin ? [queryPlugin] : []),
      ...(httpPlugin ? [httpPlugin] : []),
    ];

    return selectedPlugins as readonly string[];
  });

const makeFormatterPrompt = () =>
  Prompt.text({
    message: "Formatter command (optional, leave empty to skip)",
    default: "",
  });

const testConnection = (connectionString: string) =>
  Effect.tryPromise({
    try: async () => {
      const sql = postgres(connectionString, { max: 1 });
      try {
        const result = await sql`SELECT version()`;
        const version = result[0]?.["version"] as string;
        const match = version.match(/PostgreSQL [\d.]+/);
        return match?.[0] ?? "PostgreSQL";
      } finally {
        await sql.end();
      }
    },
    catch: (error) =>
      new Error(`Connection failed: ${error instanceof Error ? error.message : String(error)}`),
  });

interface InitAnswers {
  connectionString: string;
  connectionConfigValue: string;
  isEnvRef: boolean;
  role: string | undefined;
  schemas: readonly string[];
  outputDir: string;
  plugins: readonly string[];
  formatter: string;
}

const generateConfigContent = (answers: InitAnswers): string => {
  // Get unique plugin imports (dedupe e.g., kysely-types + kysely-queries -> single kysely import)
  const selectedPlugins = pipe(
    answers.plugins,
    Array.filterMap((value) => {
      const info = getPluginInfo(value);
      return info ? Option.some(info) : Option.none();
    }),
  );

  // Deduplicate by import name (keep first occurrence)
  const uniqueImports = pipe(
    selectedPlugins,
    Array.dedupeWith((a, b) => a.importName === b.importName),
  );

  const allImportNames = ["defineConfig", ...uniqueImports.map((p) => p.importName)];

  // Build import declaration: import { defineConfig, plugin1, plugin2 } from "@danielfgray/pg-sourcerer"
  const importDecl = conjure.import.named("@danielfgray/pg-sourcerer", ...allImportNames);

  // Build config object
  let configObj = conjure.obj();

  // connectionString - either env ref or literal
  if (answers.isEnvRef) {
    const envKey = answers.connectionConfigValue.replace("process.env.", "");
    // process.env.VAR!
    configObj = configObj.prop(
      "connectionString",
      conjure.nonNull(conjure.id("process").prop("env").prop(envKey).build())
    );
  } else {
    configObj = configObj.prop("connectionString", conjure.str(answers.connectionConfigValue));
  }

  // role (optional)
  if (answers.role) {
    configObj = configObj.prop("role", conjure.str(answers.role));
  }

  // schemas (only if not default ["public"])
  if (answers.schemas.length !== 1 || answers.schemas[0] !== "public") {
    configObj = configObj.prop(
      "schemas",
      conjure.arr(...answers.schemas.map((s) => conjure.str(s))).build()
    );
  }

  // outputDir (only if not default)
  if (answers.outputDir !== "./generated") {
    configObj = configObj.prop("outputDir", conjure.str(answers.outputDir));
  }

  // formatter (optional)
  if (answers.formatter.trim()) {
    configObj = configObj.prop("formatter", conjure.str(answers.formatter.trim()));
  }

  // plugins array: [plugin1(), plugin2(), ...]
  const pluginCalls = uniqueImports.map((p) =>
    conjure.id(p.importName).call().build()
  );
  configObj = configObj.prop("plugins", conjure.arr(...pluginCalls).build());

  // Build: export default defineConfig({ ... })
  const defineConfigCall = conjure.id("defineConfig").call([configObj.build()]).build();
  const exportDefault = conjure.export.default(defineConfigCall);

  // Create program and print
  const program = conjure.program(importDecl, exportDefault);
  return conjure.print(program) + "\n";
};

const CONFIG_FILENAME = "pgsourcerer.config.ts";

export const runInit = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const configPath = `${process.cwd()}/${CONFIG_FILENAME}`;

  const exists = yield* fs.exists(configPath);
  if (exists) {
    yield* Console.error(`\n✗ ${CONFIG_FILENAME} already exists`);
    yield* Console.log("  Edit it directly or delete it to start fresh.");
    return yield* Effect.fail(new Error("Config already exists"));
  }

  yield* Console.log("\n🔧 pg-sourcerer config generator\n");

  const { connectionString, configValue, isEnvRef } = yield* getConnectionString;

  yield* Console.log("Introspecting database...");
  const introspection = yield* introspectDatabase({ connectionString }).pipe(
    Effect.catchAll((e) =>
      Console.error(`Warning: ${e.message}`).pipe(
        Effect.andThen(Effect.succeed({ classes: [] } as unknown as Introspection)),
      ),
    ),
  );

  const role = yield* makeRolePrompt();
  const schemas = yield* makeSchemasPrompt(introspection);
  const outputDir = yield* makeOutputDirPrompt();
  const plugins = yield* makePluginsPrompt();
  const formatter = yield* makeFormatterPrompt();

  if (plugins.length === 0) {
    yield* Console.error("✗ At least one plugin must be selected");
    return yield* Effect.fail(new Error("No plugins selected"));
  }

  const answers: InitAnswers = {
    connectionString,
    connectionConfigValue: configValue,
    isEnvRef,
    role,
    schemas: schemas.length > 0 ? schemas : ["public"],
    outputDir: outputDir.trim() || "generated",
    plugins,
    formatter,
  };

  const configContent = generateConfigContent(answers);
  yield* fs.writeFileString(configPath, configContent);

  yield* Console.log(`\n✓ Created ${CONFIG_FILENAME}`);

  return { configPath };
});

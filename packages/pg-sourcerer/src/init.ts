/**
 * pg-sourcerer init command
 *
 * Interactive config generator using @effect/cli Prompt.
 */
import { Prompt } from "@effect/cli";
import { FileSystem, Terminal } from "@effect/platform";
import { Array, Console, Effect, HashMap, HashSet, Option, pipe } from "effect";
import postgres from "postgres";
import recast from "recast";
import type { Introspection } from "@danielfgray/pg-introspection";
import { introspectDatabase } from "./services/introspection.js";
import { ConfigFromFile, FileConfigProvider } from "./services/config.js";

interface PluginInfo {
  readonly value: string;
  readonly importName: string;
}

const pluginImportNames: Record<string, string> = {
  types: "types",
  zod: "zod",
  "kysely-queries": "kyselyQueriesPlugin",
  "http-elysia": "elysiaHttp",
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

const POSTGRES_URL_REGEX = /^postgres(ql)?:\/\//i;

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
  for (const c of introspection.classes) {
    if (c.relkind !== "r" && c.relkind !== "v" && c.relkind !== "m") continue;
    const schema = c.getNamespace()?.nspname;
    if (!schema || schema.startsWith("pg_") || schema === "information_schema") continue;
    schemaCounts.set(schema, (schemaCounts.get(schema) ?? 0) + 1);
  }

  const schemas = [...schemaCounts.entries()].sort((a, b) => {
    if (a[0] === "public") return -1;
    if (b[0] === "public") return 1;
    return b[1] - a[1];
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
      title: `${name} (${count} table${count === 1 ? "" : "s"})`,
      value: name,
      selected: name === "public" || schemas.length === 1,
    })),
  });
};

const makeOutputDirPrompt = () =>
  Prompt.text({
    message: "Output directory",
    default: "./src/generated",
  });

const makePluginsPrompt = () =>
  Effect.gen(function* () {
    const usesKysely = yield* Prompt.confirm({
      message: "Do you use Kysely?",
      initial: false,
    });

    if (usesKysely) {
      const kyselyPlugins = yield* Prompt.multiSelect({
        message: "Select Kysely plugins",
        choices: [
          { title: "kysely-types - Kysely-compatible types", value: "kysely-types", selected: true },
          { title: "kysely-queries - Query builders", value: "kysely-queries", selected: true },
        ],
      });

      const hasQueries = kyselyPlugins.includes("kysely-queries");
      if (hasQueries) {
        const httpPlugins = yield* Prompt.multiSelect({
          message: "HTTP/RPC framework (optional, requires query plugin)",
          choices: [
            { title: "Elysia routes", value: "http-elysia", selected: false },
          ],
        });
        return [...kyselyPlugins, ...httpPlugins] as readonly string[];
      }
      return kyselyPlugins;
    }

    const typeApproach = yield* Prompt.select({
      message: "How do you want your types generated?",
      choices: [
        { title: "Raw TypeScript types", value: "raw" },
        { title: "Schema-driven (with validation library)", value: "schema" },
      ],
    });

    let typePlugin: string;
    if (typeApproach === "raw") {
      typePlugin = "types";
    } else {
      typePlugin = yield* Prompt.select({
        message: "Select schema library",
        choices: [
          { title: "Zod", value: "zod" },
          { title: "ArkType", value: "arktype" },
          { title: "Effect Schema", value: "effect" },
        ],
      });
    }

    const queryPlugins = yield* Prompt.multiSelect({
      message: "Query generation (optional)",
      choices: [
        { title: "sql-queries - Raw SQL query functions", value: "sql-queries", selected: false },
      ],
    });

    if (queryPlugins.length > 0) {
      const httpPlugins = yield* Prompt.multiSelect({
        message: "HTTP/RPC framework (optional)",
        choices: [
          { title: "Elysia routes", value: "http-elysia", selected: false },
        ],
      });
      return [typePlugin, ...queryPlugins, ...httpPlugins] as readonly string[];
    }

    return [typePlugin, ...queryPlugins] as readonly string[];
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
  const selectedPlugins = pipe(
    answers.plugins,
    Array.filterMap((value) => {
      const info = getPluginInfo(value);
      return info ? Option.some(info) : Option.none();
    }),
  );

  const allImports = ["defineConfig", ...selectedPlugins.map((p) => p.importName)];

  const importDecl = `import { ${allImports.join(", ")} } from "@danielfgray/pg-sourcerer";`;

  let configObj = `{\n  connectionString: `;

  if (answers.isEnvRef) {
    const envKey = answers.connectionConfigValue.replace("process.env.", "");
    configObj += `process.env.${envKey}!,\n`;
  } else {
    configObj += `"${answers.connectionConfigValue}",\n`;
  }

  if (answers.role) {
    configObj += `  role: "${answers.role}",\n`;
  }

  if (answers.schemas.length !== 1 || answers.schemas[0] !== "public") {
    configObj += `  schemas: [${answers.schemas.map((s) => `"${s}"`).join(", ")}],\n`;
  }

  if (answers.outputDir !== "src/generated") {
    configObj += `  outputDir: "${answers.outputDir}",\n`;
  }

  if (answers.formatter.trim()) {
    configObj += `  formatter: "${answers.formatter.trim()}",\n`;
  }

  const pluginCalls = selectedPlugins.map((p) => `  ${p.importName}()`).join(",\n");
  configObj += `  plugins: [\n${pluginCalls}\n  ]\n}`;

  return `${importDecl}\n\nexport default defineConfig(${configObj});\n`;
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
    outputDir: outputDir.trim() || "src/generated",
    plugins,
    formatter,
  };

  const configContent = generateConfigContent(answers);
  yield* fs.writeFileString(configPath, configContent);

  yield* Console.log(`\n✓ Created ${CONFIG_FILENAME}`);

  return { configPath };
});

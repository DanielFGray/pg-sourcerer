/**
 * pg-sourcerer init command
 *
 * Interactive config generator using @effect/cli Prompt.
 * Uses conjure AST builder to generate the config file.
 */
import { Prompt } from "@effect/cli";
import { FileSystem, Terminal } from "@effect/platform";
import { Array, Console, Effect, HashMap, HashSet, Option, pipe } from "effect";
import postgres from "postgres";
import { conjure, cast } from "./lib/conjure.js";
import type { ExpressionKind } from "ast-types/lib/gen/kinds.js";
import recast from "recast";

// ============================================================================
// Plugin Registry
// ============================================================================

interface PluginChoice {
  readonly title: string;
  readonly value: string;
  readonly description: string;
  readonly importName: string;
  readonly selected?: boolean;
}

const availablePlugins: readonly PluginChoice[] = [
  {
    title: "types",
    value: "types",
    description: "TypeScript type definitions",
    importName: "typesPlugin",
    selected: true, // Default selected
  },
  {
    title: "zod",
    value: "zod",
    description: "Zod validation schemas",
    importName: "zodPlugin",
  },
  {
    title: "arktype",
    value: "arktype",
    description: "ArkType schemas",
    importName: "arktypePlugin",
  },
  {
    title: "effect-model",
    value: "effect-model",
    description: "Effect Schema models",
    importName: "effectModelPlugin",
  },
  {
    title: "sql-queries",
    value: "sql-queries",
    description: "SQL query functions",
    importName: "sqlQueriesPlugin",
  },
  {
    title: "kysely-queries",
    value: "kysely-queries",
    description: "Kysely query builders",
    importName: "kyselyQueriesPlugin",
  },
] as const;

// ============================================================================
// Environment Scanning
// ============================================================================

interface EnvMatch {
  readonly key: string;
  readonly value: string;
  readonly source: ".env" | "process.env";
}

const POSTGRES_URL_REGEX = /^postgres(ql)?:\/\//i;

/**
 * Parse .env content into HashMap<string, string>
 * Handles: KEY=value, KEY="value", KEY='value', comments, empty lines
 */
const parseDotEnv = (content: string): HashMap.HashMap<string, string> =>
  pipe(
    content.split("\n"),
    Array.map(line => line.trim()),
    Array.filter(line => line.length > 0 && !line.startsWith("#")),
    Array.filterMap(line => {
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) return Option.none();

      const key = line.slice(0, eqIndex).trim();
      let value = line.slice(eqIndex + 1).trim();

      // Remove surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      return Option.some([key, value] as const);
    }),
    HashMap.fromIterable,
  );

/**
 * Filter entries matching postgres URL pattern
 */
const filterPostgresUrls = (
  entries: HashMap.HashMap<string, string>,
  source: ".env" | "process.env",
): readonly EnvMatch[] =>
  pipe(
    entries,
    HashMap.filter(value => POSTGRES_URL_REGEX.test(value)),
    HashMap.toEntries,
    Array.map(([key, value]) => ({ key, value, source })),
  );

/**
 * Get process.env as HashMap, excluding specified keys
 */
const processEnvExcluding = (exclude: HashSet.HashSet<string>): HashMap.HashMap<string, string> =>
  pipe(
    Object.entries(process.env),
    Array.filter(([key, value]) => value != null && !HashSet.has(exclude, key)),
    Array.map(([key, value]) => [key, value!] as const),
    HashMap.fromIterable,
  );

/**
 * Scan .env file and process.env for postgres connection strings.
 */
const scanEnvForConnectionStrings: Effect.Effect<
  readonly EnvMatch[],
  never,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const envPath = `${process.cwd()}/.env`;

  // Try to read .env file
  const dotEnvMatches = yield* fs.readFileString(envPath).pipe(
    Effect.map(content => filterPostgresUrls(parseDotEnv(content), ".env")),
    Effect.catchAll(() => Effect.succeed([] as readonly EnvMatch[])),
  );

  // Scan process.env, excluding keys already found in .env
  const dotEnvKeys = pipe(
    dotEnvMatches,
    Array.map(m => m.key),
    HashSet.fromIterable,
  );

  const processEnvMatches = filterPostgresUrls(processEnvExcluding(dotEnvKeys), "process.env");

  return [...dotEnvMatches, ...processEnvMatches];
});

// ============================================================================
// Prompts
// ============================================================================

const connectionStringPrompt = Prompt.text({
  message: "Database connection string",
  validate: value =>
    value.trim().length === 0
      ? Effect.fail("Connection string is required")
      : Effect.succeed(value.trim()),
});

/**
 * Prompt for connection string and immediately test it.
 * Re-prompts on failure until successful.
 */
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
      Effect.map(version => ({ success: true as const, version })),
      Effect.catchAll(e => Effect.succeed({ success: false as const, error: e.message })),
    );

    if (result.success) {
      yield* Console.log(`✓ Connected to ${result.version}\n`);
      return connStr;
    } else {
      yield* Console.error(`✗ ${result.error}`);
      yield* Console.log("Please try again.\n");
      // On retry, use the failed value as the new default so user can edit it
      return yield* promptAndTestConnection(connStr);
    }
  });

/**
 * Result of connection string selection.
 * If isEnvRef is true, configValue contains "process.env.KEY" and should
 * be emitted as an identifier expression rather than a string literal.
 */
interface ConnectionResult {
  readonly connectionString: string;
  readonly configValue: string;
  readonly isEnvRef: boolean;
}

/**
 * Get connection string - either from detected env var or manual entry.
 */
const getConnectionString: Effect.Effect<
  ConnectionResult,
  Terminal.QuitException,
  FileSystem.FileSystem | Terminal.Terminal
> = Effect.gen(function* () {
  const envMatches = yield* scanEnvForConnectionStrings;

  // No matches → manual entry
  if (Array.isEmptyReadonlyArray(envMatches)) {
    const connectionString = yield* promptAndTestConnection();
    return { connectionString, configValue: connectionString, isEnvRef: false };
  }

  yield* Console.log(
    `Found ${envMatches.length} potential connection string${envMatches.length === 1 ? "" : "s"} in environment:\n`,
  );

  const choices = pipe(
    envMatches,
    Array.map(m => ({
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

  // Find selected match and test connection
  const match = pipe(
    envMatches,
    Array.findFirst(m => m.key === selected),
    Option.getOrThrow, // Safe: we know it exists from the choices
  );

  yield* Console.log(`\nTesting ${match.key}...`);

  const testResult = yield* testConnection(match.value).pipe(
    Effect.map(version => ({ success: true as const, version })),
    Effect.catchAll(e => Effect.succeed({ success: false as const, error: e.message })),
  );

  if (testResult.success) {
    yield* Console.log(`✓ Connected to ${testResult.version}\n`);
    return {
      connectionString: match.value,
      configValue: `process.env.${match.key}`,
      isEnvRef: true,
    };
  }

  // Failed → fall back to manual with value as default
  yield* Console.error(`✗ ${testResult.error}`);
  yield* Console.log("Connection failed. Please enter manually.\n");
  const connectionString = yield* promptAndTestConnection(match.value);
  return { connectionString, configValue: connectionString, isEnvRef: false };
});

/**
 * Role prompt with explanation of when to use it.
 *
 * If using Row Level Security (RLS), set this to the role your app connects as.
 * This ensures generated types only include columns/tables visible to that role.
 * Leave empty if not using RLS or connecting as a superuser.
 */
const makeRolePrompt = () =>
  Prompt.text({
    message: "PostgreSQL role (for RLS - leave empty if not using RLS)",
    default: "",
  }).pipe(Prompt.map(s => s.trim() || undefined));

const makeSchemasPrompt = () =>
  Prompt.text({
    message: "Schemas to introspect (comma-separated)",
    default: "public",
  }).pipe(
    Prompt.map(s =>
      s
        .split(",")
        .map(x => x.trim())
        .filter(x => x.length > 0),
    ),
  );

const makeOutputDirPrompt = () =>
  Prompt.text({
    message: "Output directory",
    default: "./generated",
  });

const makePluginsPrompt = () =>
  Prompt.multiSelect({
    message: "Select plugins to enable (space to toggle, enter to confirm)",
    choices: availablePlugins.map(p => ({
      title: `${p.title} - ${p.description}`,
      value: p.value,
      selected: p.selected,
    })),
  });

const makeFormatterPrompt = () =>
  Prompt.text({
    message: "Formatter command (optional, leave empty to skip)",
    default: "",
  });

// ============================================================================
// Connection Test
// ============================================================================

const testConnection = (connectionString: string) =>
  Effect.tryPromise({
    try: async () => {
      const sql = postgres(connectionString, { max: 1 });
      try {
        const result = await sql`SELECT version()`;
        const version = result[0]?.["version"] as string;
        // Extract just the version number (e.g., "PostgreSQL 15.2")
        const match = version.match(/PostgreSQL [\d.]+/);
        return match?.[0] ?? "PostgreSQL";
      } finally {
        await sql.end();
      }
    },
    catch: error =>
      new Error(`Connection failed: ${error instanceof Error ? error.message : String(error)}`),
  });

// ============================================================================
// Config Generation (using conjure AST builder)
// ============================================================================

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
  const selectedPlugins = availablePlugins.filter(p => answers.plugins.includes(p.value));

  // Build import specifiers
  const coreImports = ["defineConfig"];
  const allImports = [...coreImports, ...selectedPlugins.map(p => p.importName)];

  // Build the import statement
  const importDecl = conjure.b.importDeclaration(
    allImports.map(name => conjure.b.importSpecifier(conjure.b.identifier(name))),
    conjure.str("@danielfgray/pg-sourcerer"),
  );

  // Build the config object - handle env ref vs literal
  let configObj = conjure.obj();

  if (answers.isEnvRef) {
    // Generate: connectionString: process.env.DATABASE_URL
    const envKey = answers.connectionConfigValue.replace("process.env.", "");
    const envAccess = conjure.b.memberExpression(
      conjure.b.memberExpression(conjure.b.identifier("process"), conjure.b.identifier("env")),
      conjure.b.identifier(envKey),
    );
    configObj = configObj.prop("connectionString", envAccess);
  } else {
    configObj = configObj.prop("connectionString", conjure.str(answers.connectionConfigValue));
  }

  // Role (only if set)
  if (answers.role) {
    configObj = configObj.prop("role", conjure.str(answers.role));
  }

  // Schemas (only if not just ["public"])
  if (answers.schemas.length !== 1 || answers.schemas[0] !== "public") {
    const schemasArr = conjure.arr(...answers.schemas.map(s => conjure.str(s)));
    configObj = configObj.prop("schemas", schemasArr.build());
  }

  // Output directory (only if not default)
  if (answers.outputDir !== "src/generated") {
    configObj = configObj.prop("outputDir", conjure.str(answers.outputDir));
  }

  // Formatter (only if set)
  if (answers.formatter.trim()) {
    configObj = configObj.prop("formatter", conjure.str(answers.formatter.trim()));
  }

  // Plugins array - no config needed, all plugins have sensible defaults
  const pluginCalls = selectedPlugins.map(plugin =>
    conjure
      .id(plugin.importName)
      .call([])
      .build(),
  );
  const pluginsArr = conjure.arr(...pluginCalls);
  configObj = configObj.prop("plugins", pluginsArr.build());

  // Build the export default statement
  const defineConfigCall = conjure.id("defineConfig").call([configObj.build()]).build();
  const exportDefault = conjure.b.exportDefaultDeclaration(
    cast.toExpr(defineConfigCall) as ExpressionKind,
  );

  // Build the program and print with 2-space indentation
  const program = conjure.program(importDecl, exportDefault);
  return recast.print(program, { tabWidth: 2 }).code + "\n";
};

// ============================================================================
// Main Init Effect
// ============================================================================

const CONFIG_FILENAME = "pgsourcerer.config.ts";

export const runInit = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const configPath = `${process.cwd()}/${CONFIG_FILENAME}`;

  // Check if config already exists
  const exists = yield* fs.exists(configPath);
  if (exists) {
    yield* Console.error(`\n✗ ${CONFIG_FILENAME} already exists`);
    yield* Console.log("  Edit it directly or delete it to start fresh.");
    return yield* Effect.fail(new Error("Config already exists"));
  }

  yield* Console.log("\n🔧 pg-sourcerer config generator\n");

  // Collect answers - connection string may be detected from env
  const { connectionString, configValue, isEnvRef } = yield* getConnectionString;
  const role = yield* makeRolePrompt();
  const schemas = yield* makeSchemasPrompt();
  const outputDir = yield* makeOutputDirPrompt();
  const plugins = yield* makePluginsPrompt();
  const formatter = yield* makeFormatterPrompt();

  // Validate at least one plugin selected
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

  // Generate and write config
  const configContent = generateConfigContent(answers);
  yield* fs.writeFileString(configPath, configContent);

  yield* Console.log(`\n✓ Created ${CONFIG_FILENAME}`);
  yield* Console.log("\nNext steps:");
  yield* Console.log("  1. Review the generated config file");
  yield* Console.log("  2. Run: pgsourcerer generate");
});

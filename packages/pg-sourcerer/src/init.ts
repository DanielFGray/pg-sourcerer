/**
 * pg-sourcerer init command
 *
 * Interactive config generator using @effect/cli Prompt.
 * Uses conjure AST builder to generate the config file.
 */
import { Prompt } from "@effect/cli"
import { FileSystem, Terminal } from "@effect/platform"
import { Console, Effect } from "effect"
import postgres from "postgres"
import { conjure, cast } from "./lib/conjure.js"
import type { ExpressionKind } from "ast-types/lib/gen/kinds.js"
import recast from "recast"

// ============================================================================
// Plugin Registry
// ============================================================================

interface PluginChoice {
  readonly title: string
  readonly value: string
  readonly description: string
  readonly importName: string
  readonly selected?: boolean
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
] as const

// ============================================================================
// Prompts
// ============================================================================

const connectionStringPrompt = Prompt.text({
  message: "Database connection string",
  validate: (value) =>
    value.trim().length === 0
      ? Effect.fail("Connection string is required")
      : Effect.succeed(value.trim()),
})

/**
 * Prompt for connection string and immediately test it.
 * Re-prompts on failure until successful.
 */
const promptAndTestConnection = (
  defaultValue?: string
): Effect.Effect<string, Terminal.QuitException, Terminal.Terminal> =>
  Effect.gen(function* () {
    const prompt = defaultValue
      ? Prompt.text({ message: "Database connection string", default: defaultValue })
      : connectionStringPrompt
    const connStr = yield* prompt

    yield* Console.log("Testing connection...")
    const result = yield* testConnection(connStr).pipe(
      Effect.map((version) => ({ success: true as const, version })),
      Effect.catchAll((e) => Effect.succeed({ success: false as const, error: e.message }))
    )

    if (result.success) {
      yield* Console.log(`✓ Connected to ${result.version}\n`)
      return connStr
    } else {
      yield* Console.error(`✗ ${result.error}`)
      yield* Console.log("Please try again.\n")
      // On retry, use the failed value as the new default so user can edit it
      return yield* promptAndTestConnection(connStr)
    }
  })

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
  }).pipe(Prompt.map((s) => s.trim() || undefined))

const makeSchemasPrompt = () =>
  Prompt.text({
    message: "Schemas to introspect (comma-separated)",
    default: "public",
  }).pipe(Prompt.map((s) => s.split(",").map((x) => x.trim()).filter((x) => x.length > 0)))

const makeOutputDirPrompt = () =>
  Prompt.text({
    message: "Output directory",
    default: "src/generated",
  })

const makePluginsPrompt = () =>
  Prompt.multiSelect({
    message: "Select plugins to enable (space to toggle, enter to confirm)",
    choices: availablePlugins.map((p) => ({
      title: `${p.title} - ${p.description}`,
      value: p.value,
      selected: p.selected,
    })),
  })

const makeClassicInflectionPrompt = () =>
  Prompt.confirm({
    message: "Use classic inflection? (PascalCase entities, camelCase fields)",
    initial: true,
  })

const makeFormatterPrompt = () =>
  Prompt.text({
    message: "Formatter command (optional, leave empty to skip)",
    default: "",
  })

// ============================================================================
// Connection Test
// ============================================================================

const testConnection = (connectionString: string) =>
  Effect.tryPromise({
    try: async () => {
      const sql = postgres(connectionString, { max: 1 })
      try {
        const result = await sql`SELECT version()`
        const version = result[0]?.["version"] as string
        // Extract just the version number (e.g., "PostgreSQL 15.2")
        const match = version.match(/PostgreSQL [\d.]+/)
        return match?.[0] ?? "PostgreSQL"
      } finally {
        await sql.end()
      }
    },
    catch: (error) =>
      new Error(
        `Connection failed: ${error instanceof Error ? error.message : String(error)}`
      ),
  })

// ============================================================================
// Config Generation (using conjure AST builder)
// ============================================================================

interface InitAnswers {
  connectionString: string
  role: string | undefined
  schemas: readonly string[]
  outputDir: string
  plugins: readonly string[]
  classicInflection: boolean
  formatter: string
}

const generateConfigContent = (answers: InitAnswers): string => {
  const selectedPlugins = availablePlugins.filter((p) =>
    answers.plugins.includes(p.value)
  )

  // Build import specifiers
  const coreImports = ["defineConfig"]
  if (answers.classicInflection) {
    coreImports.push("classicInflectionConfig")
  }
  const allImports = [...coreImports, ...selectedPlugins.map((p) => p.importName)]

  // Build the import statement
  const importDecl = conjure.b.importDeclaration(
    allImports.map((name) => conjure.b.importSpecifier(conjure.b.identifier(name))),
    conjure.str("@danielfgray/pg-sourcerer")
  )

  // Build the config object
  let configObj = conjure.obj()
    .prop("connectionString", conjure.str(answers.connectionString))

  // Role (only if set)
  if (answers.role) {
    configObj = configObj.prop("role", conjure.str(answers.role))
  }

  // Schemas (only if not just ["public"])
  if (answers.schemas.length !== 1 || answers.schemas[0] !== "public") {
    const schemasArr = conjure.arr(...answers.schemas.map((s) => conjure.str(s)))
    configObj = configObj.prop("schemas", schemasArr.build())
  }

  // Output directory (only if not default)
  if (answers.outputDir !== "src/generated") {
    configObj = configObj.prop("outputDir", conjure.str(answers.outputDir))
  }

  // Formatter (only if set)
  if (answers.formatter.trim()) {
    configObj = configObj.prop("formatter", conjure.str(answers.formatter.trim()))
  }

  // Inflection (only if classic)
  if (answers.classicInflection) {
    configObj = configObj.prop("inflection", conjure.id("classicInflectionConfig").build())
  }

  // Plugins array
  const pluginCalls = selectedPlugins.map((plugin) =>
    conjure.id(plugin.importName)
      .call([conjure.obj().prop("outputDir", conjure.str(plugin.value)).build()])
      .build()
  )
  const pluginsArr = conjure.arr(...pluginCalls)
  configObj = configObj.prop("plugins", pluginsArr.build())

  // Build the export default statement
  const defineConfigCall = conjure.id("defineConfig").call([configObj.build()]).build()
  const exportDefault = conjure.b.exportDefaultDeclaration(
    cast.toExpr(defineConfigCall) as ExpressionKind
  )

  // Build the program and print with 2-space indentation
  const program = conjure.program(importDecl, exportDefault)
  return recast.print(program, { tabWidth: 2 }).code + "\n"
}

// ============================================================================
// Main Init Effect
// ============================================================================

const CONFIG_FILENAME = "pgsourcerer.config.ts"

export const runInit = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const configPath = `${process.cwd()}/${CONFIG_FILENAME}`

  // Check if config already exists
  const exists = yield* fs.exists(configPath)
  if (exists) {
    yield* Console.error(`\n✗ ${CONFIG_FILENAME} already exists`)
    yield* Console.log("  Edit it directly or delete it to start fresh.")
    return yield* Effect.fail(new Error("Config already exists"))
  }

  yield* Console.log("\n🔧 pg-sourcerer config generator\n")

  // Collect answers - connection string is tested immediately
  const connectionString = yield* promptAndTestConnection()
  const role = yield* makeRolePrompt()
  const schemas = yield* makeSchemasPrompt()
  const outputDir = yield* makeOutputDirPrompt()
  const plugins = yield* makePluginsPrompt()
  const classicInflection = yield* makeClassicInflectionPrompt()
  const formatter = yield* makeFormatterPrompt()

  // Validate at least one plugin selected
  if (plugins.length === 0) {
    yield* Console.error("✗ At least one plugin must be selected")
    return yield* Effect.fail(new Error("No plugins selected"))
  }

  const answers: InitAnswers = {
    connectionString,
    role,
    schemas: schemas.length > 0 ? schemas : ["public"],
    outputDir: outputDir.trim() || "src/generated",
    plugins,
    classicInflection,
    formatter,
  }

  // Generate and write config
  const configContent = generateConfigContent(answers)
  yield* fs.writeFileString(configPath, configContent)

  yield* Console.log(`\n✓ Created ${CONFIG_FILENAME}`)
  yield* Console.log("\nNext steps:")
  yield* Console.log("  1. Review the generated config file")
  yield* Console.log("  2. Run: pgsourcerer generate")
})

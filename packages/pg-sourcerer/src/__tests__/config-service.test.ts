/**
 * ConfigService Layer Tests
 *
 * Tests for the new ConfigService pattern where config is provided via
 * Effect's dependency injection rather than loaded imperatively.
 *
 * This tests:
 * 1. ConfigService tag definition
 * 2. ConfigFromFile layer (loads from disk)
 * 3. ConfigWithInit layer (loads or runs init prompts)
 * 4. Effects consuming ConfigService
 */
import { describe, it, expect } from "@effect/vitest"
import { Effect, Layer, Context, Exit, Cause } from "effect"

import type { ResolvedConfig } from "../config.js"
import { ConfigNotFound, ConfigInvalid } from "../errors.js"

// ============================================================================
// ConfigService Definition
// ============================================================================

/**
 * Service that provides the loaded configuration.
 * The service value IS the ResolvedConfig - simple and direct.
 */
class ConfigService extends Context.Tag("ConfigService")<
  ConfigService,
  ResolvedConfig
>() {}

// ============================================================================
// Test Fixtures
// ============================================================================

const testConfig: ResolvedConfig = {
  connectionString: "postgres://localhost/test",
  schemas: ["public"],
  outputDir: "src/generated",
  typeHints: [],
  generators: [],
}

// ============================================================================
// Layer Constructors
// ============================================================================

/**
 * Create a layer that provides a static config (for testing).
 */
const ConfigTest = (config: ResolvedConfig): Layer.Layer<ConfigService> =>
  Layer.succeed(ConfigService, config)

/**
 * Simulated config loader behavior.
 */
type LoaderBehavior = "found" | "not-found" | "invalid"

const mockLoad = (
  behavior: LoaderBehavior,
  opts?: { configPath?: string },
): Effect.Effect<ResolvedConfig, ConfigNotFound | ConfigInvalid> => {
  switch (behavior) {
    case "found":
      return Effect.succeed(testConfig)
    case "not-found":
      return Effect.fail(
        new ConfigNotFound({
          message: "No configuration file found",
          searchPaths: ["/test/pgsourcerer.config.ts"],
        }),
      )
    case "invalid":
      return Effect.fail(
        new ConfigInvalid({
          message: "Invalid config",
          path: opts?.configPath ?? "/test/pgsourcerer.config.ts",
          errors: ["connectionString is required"],
        }),
      )
  }
}

/**
 * Layer that loads config from file (fails if not found).
 */
const ConfigFromFile = (
  behavior: LoaderBehavior,
  opts?: { configPath?: string },
): Layer.Layer<ConfigService, ConfigNotFound | ConfigInvalid> =>
  Layer.effect(ConfigService, mockLoad(behavior, opts))

/**
 * Layer that loads config, or uses fallback if not found.
 * In real impl, fallback would come from running init prompts.
 */
const ConfigWithFallback = (
  behavior: LoaderBehavior,
  fallbackConfig: ResolvedConfig,
  opts?: { configPath?: string },
): Layer.Layer<ConfigService, ConfigInvalid> =>
  Layer.effect(
    ConfigService,
    mockLoad(behavior, opts).pipe(
      Effect.catchTag("ConfigNotFound", () =>
        // In real impl, this would run prompts, write file, then reload
        Effect.succeed(fallbackConfig),
      ),
    ),
  )

// ============================================================================
// Tests
// ============================================================================

describe("ConfigService", () => {
  describe("ConfigService tag", () => {
    it.effect("can be provided and consumed", () =>
      Effect.gen(function* () {
        const config = yield* ConfigService
        expect(config.connectionString).toBe("postgres://localhost/test")
        expect(config.schemas).toEqual(["public"])
      }).pipe(Effect.provide(ConfigTest(testConfig))),
    )

    it.effect("type-checks config properties", () =>
      Effect.gen(function* () {
        const config = yield* ConfigService
        // These should all type-check correctly
        const _connStr: string = config.connectionString
        const _schemas: readonly string[] = config.schemas
        const _outputDir: string = config.outputDir
        const _role: string | undefined = config.role
        expect(_connStr).toBeDefined()
      }).pipe(Effect.provide(ConfigTest(testConfig))),
    )
  })

  describe("ConfigFromFile layer", () => {
    it.effect("provides config when file exists", () =>
      Effect.gen(function* () {
        const config = yield* ConfigService
        expect(config.connectionString).toBe("postgres://localhost/test")
      }).pipe(Effect.provide(ConfigFromFile("found"))),
    )

    it.effect("fails with ConfigNotFound when file missing", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          ConfigService.pipe(Effect.provide(ConfigFromFile("not-found"))),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const failure = Cause.failureOption(exit.cause)
          expect(failure._tag).toBe("Some")
          if (failure._tag === "Some") {
            expect(failure.value).toBeInstanceOf(ConfigNotFound)
          }
        }
      }),
    )

    it.effect("fails with ConfigInvalid when config has errors", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          ConfigService.pipe(Effect.provide(ConfigFromFile("invalid"))),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const failure = Cause.failureOption(exit.cause)
          expect(failure._tag).toBe("Some")
          if (failure._tag === "Some") {
            expect(failure.value).toBeInstanceOf(ConfigInvalid)
          }
        }
      }),
    )
  })

  describe("ConfigWithFallback layer", () => {
    const fallbackConfig: ResolvedConfig = {
      connectionString: "postgres://localhost/from-init",
      schemas: ["public"],
      outputDir: "src/generated",
      typeHints: [],
      generators: [],
    }

    it.effect("provides config when file exists (no fallback needed)", () =>
      Effect.gen(function* () {
        const config = yield* ConfigService
        // Should get the loaded config, not fallback
        expect(config.connectionString).toBe("postgres://localhost/test")
      }).pipe(Effect.provide(ConfigWithFallback("found", fallbackConfig))),
    )

    it.effect("provides fallback config when file not found", () =>
      Effect.gen(function* () {
        const config = yield* ConfigService
        // Should get the fallback (init-generated) config
        expect(config.connectionString).toBe("postgres://localhost/from-init")
      }).pipe(Effect.provide(ConfigWithFallback("not-found", fallbackConfig))),
    )

    it.effect("still fails on ConfigInvalid (fallback only handles not-found)", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          ConfigService.pipe(Effect.provide(ConfigWithFallback("invalid", fallbackConfig))),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const failure = Cause.failureOption(exit.cause)
          expect(failure._tag).toBe("Some")
          if (failure._tag === "Some") {
            expect(failure.value).toBeInstanceOf(ConfigInvalid)
          }
        }
      }),
    )
  })

  describe("effect composition", () => {
    /**
     * Simulate a command that depends on ConfigService
     */
    const myCommand = Effect.gen(function* () {
      const config = yield* ConfigService
      return `Connected to: ${config.connectionString}`
    })

    it.effect("command can be provided config layer", () =>
      Effect.gen(function* () {
        const result = yield* myCommand
        expect(result).toBe("Connected to: postgres://localhost/test")
      }).pipe(Effect.provide(ConfigTest(testConfig))),
    )

    it.effect("command inherits config layer errors", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(myCommand.pipe(Effect.provide(ConfigFromFile("not-found"))))

        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )

    it.effect("command with fallback recovers from missing config", () =>
      Effect.gen(function* () {
        const result = yield* myCommand.pipe(
          Effect.provide(
            ConfigWithFallback("not-found", {
              ...testConfig,
              connectionString: "postgres://localhost/recovered",
            }),
          ),
        )
        expect(result).toBe("Connected to: postgres://localhost/recovered")
      }),
    )
  })

  describe("layer composition", () => {
    /**
     * Test that ConfigService can be composed with other layers.
     */
    class DatabaseService extends Context.Tag("DatabaseService")<
      DatabaseService,
      { readonly query: (sql: string) => Effect.Effect<string> }
    >() {}

    const DatabaseLive = Layer.effect(
      DatabaseService,
      Effect.gen(function* () {
        const config = yield* ConfigService
        return {
          query: (sql: string) => Effect.succeed(`${sql} @ ${config.connectionString}`),
        }
      }),
    )

    it.effect("DatabaseService can depend on ConfigService", () =>
      Effect.gen(function* () {
        const db = yield* DatabaseService
        const result = yield* db.query("SELECT 1")
        expect(result).toBe("SELECT 1 @ postgres://localhost/test")
      }).pipe(
        Effect.provide(DatabaseLive),
        Effect.provide(ConfigTest(testConfig)),
      ),
    )

    it.effect("layer merge works correctly", () =>
      Effect.gen(function* () {
        const config = yield* ConfigService
        const db = yield* DatabaseService
        const result = yield* db.query("SELECT 1")

        expect(config.outputDir).toBe("src/generated")
        expect(result).toContain("postgres://localhost/test")
      }).pipe(
        Effect.provide(
          Layer.provideMerge(DatabaseLive, ConfigTest(testConfig)),
        ),
      ),
    )
  })
})

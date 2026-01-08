/**
 * Generate Pipeline Error Handling Tests
 *
 * Tests that the generate() function surfaces clear, actionable errors
 * when things go wrong. These test observable behavior from the user's
 * perspective - the error types and messages they receive.
 */
import { describe, expect, layer } from "@effect/vitest"
import { Effect, Exit, Layer, Logger, LogLevel, Schema as S } from "effect"
import { FileSystem } from "@effect/platform"
import { NodeFileSystem, NodePath, NodeCommandExecutor } from "@effect/platform-node"

import { generate } from "../generate.js"
import { ConfigLoaderService } from "../services/config-loader.js"
import { DatabaseIntrospectionService } from "../services/introspection.js"
import { definePlugin } from "../services/plugin.js"
import { typesPlugin } from "../plugins/types.js"
import type { ResolvedConfig } from "../config.js"
import {
  ConfigNotFound,
  ConfigInvalid,
  ConnectionFailed,
  PluginExecutionFailed,
  CapabilityNotSatisfied,
  CapabilityConflict,
} from "../errors.js"
import { loadIntrospectionFixture } from "./fixtures/index.js"

// Platform layers - NodeCommandExecutor depends on FileSystem, so provide it
const PlatformLayer = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  Layer.provide(NodeCommandExecutor.layer, NodeFileSystem.layer)
)

// Suppress logs during tests
const QuietLogger = Logger.minimumLogLevel(LogLevel.None)

// Real database introspection layer (for plugin tests that need the real DB)
// Now uses fixture - no DB connection required
const IntrospectionStubLayer = Layer.succeed(DatabaseIntrospectionService, {
  introspect: () => Effect.succeed(loadIntrospectionFixture()),
})

/**
 * Create a stub ConfigLoader that returns the given config
 */
const makeConfigLoaderStub = (config: ResolvedConfig) =>
  Layer.succeed(ConfigLoaderService, {
    load: () => Effect.succeed(config),
  })

/**
 * Create a stub ConfigLoader that fails with ConfigNotFound
 */
const makeConfigNotFoundStub = (searchPaths: string[]) =>
  Layer.succeed(ConfigLoaderService, {
    load: () =>
      Effect.fail(
        new ConfigNotFound({
          message: "No configuration file found",
          searchPaths,
        })
      ),
  })

/**
 * Create a stub ConfigLoader that fails with ConfigInvalid
 */
const makeConfigInvalidStub = (path: string, errors: string[]) =>
  Layer.succeed(ConfigLoaderService, {
    load: () =>
      Effect.fail(
        new ConfigInvalid({
          message: `Invalid configuration in ${path}`,
          path,
          errors,
        })
      ),
  })

/**
 * Create a stub DatabaseIntrospection that fails with ConnectionFailed
 */
const makeConnectionFailedStub = () =>
  Layer.succeed(DatabaseIntrospectionService, {
    introspect: (options) =>
      Effect.fail(
        new ConnectionFailed({
          message: "Failed to connect to database",
          connectionString: options.connectionString.replace(/:[^:@]+@/, ":***@"),
          cause: new Error("ECONNREFUSED"),
        })
      ),
  })

/**
 * Stub introspection that never gets called (for config error tests)
 * Config errors happen before introspection, so this won't be reached
 */
const NeverCalledIntrospectionStub = Layer.succeed(DatabaseIntrospectionService, {
  introspect: () => Effect.die("Introspection should not be called - config error expected first"),
})

// ============================================================================
// Config Error Tests - Don't need real database (stub introspection)
// ============================================================================

// Layer that provides platform + stub introspection (config fails before we need real DB)
const ConfigErrorTestLayer = Layer.mergeAll(PlatformLayer, NeverCalledIntrospectionStub)

layer(ConfigErrorTestLayer)("Config Error Handling", (it) => {
  it.effect("returns ConfigNotFound when no config file exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectory({ prefix: "generate-err-" })

      try {
        const exit = yield* generate({ outputDir: tmpDir }).pipe(
          Effect.provide(makeConfigNotFoundStub([
            `${tmpDir}/pgsourcerer.config.ts`,
            `${tmpDir}/pgsourcerer.config.js`,
          ])),
          Effect.provide(QuietLogger),
          Effect.exit
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = exit.cause
          // Should be a ConfigNotFound error
          expect(error._tag).toBe("Fail")
          if (error._tag === "Fail") {
            expect(error.error).toBeInstanceOf(ConfigNotFound)
            expect((error.error as ConfigNotFound).message).toContain("No configuration file found")
          }
        }
      } finally {
        yield* fs.remove(tmpDir, { recursive: true })
      }
    }),
    { timeout: 10000 }
  )

  it.effect("returns ConfigInvalid when config has schema errors", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectory({ prefix: "generate-err-" })

      try {
        const exit = yield* generate({ outputDir: tmpDir }).pipe(
          Effect.provide(makeConfigInvalidStub(
            `${tmpDir}/pgsourcerer.config.ts`,
            ["connectionString: Required property is missing"]
          )),
          Effect.provide(QuietLogger),
          Effect.exit
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = exit.cause
          expect(error._tag).toBe("Fail")
          if (error._tag === "Fail") {
            expect(error.error).toBeInstanceOf(ConfigInvalid)
            const configError = error.error as ConfigInvalid
            expect(configError.errors).toContain("connectionString: Required property is missing")
          }
        }
      } finally {
        yield* fs.remove(tmpDir, { recursive: true })
      }
    }),
    { timeout: 10000 }
  )
})

// ============================================================================
// Database Error Tests - Use stubbed introspection that fails
// ============================================================================

const DatabaseErrorTestLayer = PlatformLayer // Introspection stub provided per-test

layer(DatabaseErrorTestLayer)("Database Error Handling", (it) => {
  it.effect("returns ConnectionFailed when database is unreachable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectory({ prefix: "generate-err-" })

      try {
        const config: ResolvedConfig = {
          connectionString: "postgres://localhost:59999/nonexistent",
          schemas: ["public"],
          outputDir: tmpDir,
          typeHints: [],
          plugins: [typesPlugin({ outputDir: "types" })],
        }

        const exit = yield* generate({ outputDir: tmpDir }).pipe(
          Effect.provide(makeConfigLoaderStub(config)),
          Effect.provide(makeConnectionFailedStub()),
          Effect.provide(QuietLogger),
          Effect.exit
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = exit.cause
          expect(error._tag).toBe("Fail")
          if (error._tag === "Fail") {
            expect(error.error).toBeInstanceOf(ConnectionFailed)
            const connError = error.error as ConnectionFailed
            expect(connError.message).toContain("Failed to connect")
            // Password should be masked in error
            expect(connError.connectionString).not.toContain("password")
          }
        }
      } finally {
        yield* fs.remove(tmpDir, { recursive: true })
      }
    }),
    { timeout: 10000 }
  )
})

// ============================================================================
// Plugin Error Tests - Need real database for introspection
// ============================================================================

const PluginTestLayer = Layer.mergeAll(PlatformLayer, IntrospectionStubLayer)

layer(PluginTestLayer)("Plugin Error Handling", (it) => {
  it.effect("returns PluginExecutionFailed when plugin throws", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectory({ prefix: "generate-err-" })

      // Create a plugin that throws
      const throwingPlugin = definePlugin({
        name: "throwing-plugin",
        provides: ["test:throw"],
        configSchema: S.Struct({}),
        inflection: {
          outputFile: () => "test.ts",
          symbolName: (name) => name,
        },
        run: () => {
          throw new Error("Plugin intentionally failed")
        },
      })

      try {
        const config: ResolvedConfig = {
          connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/test",
          schemas: ["app_public"],
          outputDir: tmpDir,
          typeHints: [],
          plugins: [throwingPlugin({})],
        }

        const exit = yield* generate({ outputDir: tmpDir }).pipe(
          Effect.provide(makeConfigLoaderStub(config)),
          Effect.provide(QuietLogger),
          Effect.exit
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = exit.cause
          expect(error._tag).toBe("Fail")
          if (error._tag === "Fail") {
            expect(error.error).toBeInstanceOf(PluginExecutionFailed)
            const pluginError = error.error as PluginExecutionFailed
            expect(pluginError.plugin).toBe("throwing-plugin")
            expect(pluginError.message).toContain("throwing-plugin")
          }
        }
      } finally {
        yield* fs.remove(tmpDir, { recursive: true })
      }
    }),
    { timeout: 30000 }
  )

  it.effect("returns PluginExecutionFailed when async plugin rejects", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectory({ prefix: "generate-err-" })

      // Create a plugin that returns a rejected promise
      const asyncThrowingPlugin = definePlugin({
        name: "async-throwing-plugin",
        provides: ["test:async-throw"],
        configSchema: S.Struct({}),
        inflection: {
          outputFile: () => "test.ts",
          symbolName: (name) => name,
        },
        run: async () => {
          await Promise.resolve() // simulate async work
          throw new Error("Async plugin intentionally failed")
        },
      })

      try {
        const config: ResolvedConfig = {
          connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/test",
          schemas: ["app_public"],
          outputDir: tmpDir,
          typeHints: [],
          plugins: [asyncThrowingPlugin({})],
        }

        const exit = yield* generate({ outputDir: tmpDir }).pipe(
          Effect.provide(makeConfigLoaderStub(config)),
          Effect.provide(QuietLogger),
          Effect.exit
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = exit.cause
          expect(error._tag).toBe("Fail")
          if (error._tag === "Fail") {
            expect(error.error).toBeInstanceOf(PluginExecutionFailed)
            const pluginError = error.error as PluginExecutionFailed
            expect(pluginError.plugin).toBe("async-throwing-plugin")
          }
        }
      } finally {
        yield* fs.remove(tmpDir, { recursive: true })
      }
    }),
    { timeout: 30000 }
  )

  it.effect("returns CapabilityNotSatisfied when plugin requires missing capability", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectory({ prefix: "generate-err-" })

      // Create a plugin that requires a capability nothing provides
      const needyPlugin = definePlugin({
        name: "needy-plugin",
        requires: ["nonexistent:capability"],
        provides: ["test:needy"],
        configSchema: S.Struct({}),
        inflection: {
          outputFile: () => "test.ts",
          symbolName: (name) => name,
        },
        run: () => {
          // Won't run - will fail during preparation
        },
      })

      try {
        const config: ResolvedConfig = {
          connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/test",
          schemas: ["app_public"],
          outputDir: tmpDir,
          typeHints: [],
          plugins: [needyPlugin({})],
        }

        const exit = yield* generate({ outputDir: tmpDir }).pipe(
          Effect.provide(makeConfigLoaderStub(config)),
          Effect.provide(QuietLogger),
          Effect.exit
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = exit.cause
          expect(error._tag).toBe("Fail")
          if (error._tag === "Fail") {
            expect(error.error).toBeInstanceOf(CapabilityNotSatisfied)
            const capError = error.error as CapabilityNotSatisfied
            expect(capError.required).toBe("nonexistent:capability")
            expect(capError.requiredBy).toBe("needy-plugin")
          }
        }
      } finally {
        yield* fs.remove(tmpDir, { recursive: true })
      }
    }),
    { timeout: 30000 }
  )

  it.effect("returns CapabilityConflict when two plugins provide same capability", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectory({ prefix: "generate-err-" })

      // Create two plugins that provide the same capability
      const plugin1 = definePlugin({
        name: "plugin-1",
        provides: ["shared:capability"],
        configSchema: S.Struct({}),
        inflection: {
          outputFile: () => "test1.ts",
          symbolName: (name) => name,
        },
        run: () => {},
      })

      const plugin2 = definePlugin({
        name: "plugin-2",
        provides: ["shared:capability"],
        configSchema: S.Struct({}),
        inflection: {
          outputFile: () => "test2.ts",
          symbolName: (name) => name,
        },
        run: () => {},
      })

      try {
        const config: ResolvedConfig = {
          connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/test",
          schemas: ["app_public"],
          outputDir: tmpDir,
          typeHints: [],
          plugins: [plugin1({}), plugin2({})],
        }

        const exit = yield* generate({ outputDir: tmpDir }).pipe(
          Effect.provide(makeConfigLoaderStub(config)),
          Effect.provide(QuietLogger),
          Effect.exit
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = exit.cause
          expect(error._tag).toBe("Fail")
          if (error._tag === "Fail") {
            expect(error.error).toBeInstanceOf(CapabilityConflict)
            const capError = error.error as CapabilityConflict
            // Capability expansion means "shared:capability" also registers "shared"
            // The conflict is detected at the first common prefix
            expect(capError.capability).toBe("shared")
            expect(capError.providers).toContain("plugin-1")
            expect(capError.providers).toContain("plugin-2")
          }
        }
      } finally {
        yield* fs.remove(tmpDir, { recursive: true })
      }
    }),
    { timeout: 30000 }
  )
})

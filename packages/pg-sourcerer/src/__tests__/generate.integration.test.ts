/**
 * Generate Pipeline Integration Tests
 *
 * Tests the generate() function end-to-end with stubbed services.
 * This covers generate.ts and config-loader.ts through real usage.
 *
 * Requires the example database to be running (cd packages/example && bun db:ensure)
 */
import { describe, expect, layer } from "@effect/vitest"
import { Effect, Layer, Logger, LogLevel } from "effect"
import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath, NodeCommandExecutor } from "@effect/platform-node"

import { generate } from "../generate.js"
import { ConfigLoaderService } from "../services/config-loader.js"
import { DatabaseIntrospectionLive, DatabaseIntrospectionService } from "../services/introspection.js"
import { typesPlugin } from "../plugins/types.js"
import { zodPlugin } from "../plugins/zod.js"
import { inflect } from "../services/inflection.js"
import type { ResolvedConfig } from "../config.js"

// Connection string from environment (set via --env-file in package.json)
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://localhost:5432/test"

// Platform layers - NodeCommandExecutor depends on FileSystem, so provide it
const PlatformLayer = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  Layer.provide(NodeCommandExecutor.layer, NodeFileSystem.layer)
)

// Suppress logs during tests
const QuietLogger = Logger.minimumLogLevel(LogLevel.None)

// Real database introspection service
const IntrospectionLayer = Layer.effect(
  DatabaseIntrospectionService,
  DatabaseIntrospectionLive
)

/**
 * Create a stub ConfigLoader that returns the given config
 */
const makeConfigLoaderStub = (config: ResolvedConfig) =>
  Layer.succeed(ConfigLoaderService, {
    load: () => Effect.succeed(config),
  })

// Base test layer with platform + introspection
const BaseTestLayer = Layer.mergeAll(PlatformLayer, IntrospectionLayer)

layer(BaseTestLayer)("Generate Pipeline Integration", (it) => {
  describe("generate() with stubbed config", () => {
    it.effect("types plugin generates correct interfaces and enums", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const pathSvc = yield* Path.Path
        const tmpDir = yield* fs.makeTempDirectory({ prefix: "generate-test-" })

        try {
          const config: ResolvedConfig = {
            connectionString: DATABASE_URL,
            schemas: ["app_public"],
            outputDir: tmpDir,
            typeHints: [],
            inflection: undefined,
            plugins: [typesPlugin({ outputDir: "types" })],
          }

          const result = yield* generate({ outputDir: tmpDir }).pipe(
            Effect.provide(makeConfigLoaderStub(config)),
            Effect.provide(QuietLogger)
          )

          // Verify pipeline results
          expect(result.ir.entities.size).toBeGreaterThan(0)
          expect(result.writeResults.length).toBeGreaterThan(0)

          // With undefined, "users" → "User"
          const entityNames = [...result.ir.entities.keys()]
          expect(entityNames).toContain("User")

          // ================================================================
          // Verify User.ts file content
          // ================================================================
          const userWrite = result.writeResults.find((r) => r.path.endsWith("/User.ts"))
          expect(userWrite).toBeDefined()
          expect(userWrite?.written).toBe(true)

          const userContent = yield* fs.readFileString(userWrite!.path)

          // Header comment
          expect(userContent).toContain("AUTO-GENERATED")

          // Shape interfaces (patch no longer generated - identical to update)
          expect(userContent).toContain("export interface User")
          expect(userContent).toContain("export interface UserInsert")
          expect(userContent).toContain("export interface UserUpdate")

          // Fields are snake_case by default (fieldName not transformed)
          expect(userContent).toContain("avatar_url")
          expect(userContent).toContain("is_verified")
          expect(userContent).toContain("created_at")
          expect(userContent).toContain("updated_at")

          // TypeScript types
          expect(userContent).toContain("id: string")       // uuid → string
          expect(userContent).toContain("username: string") // domain → string
          expect(userContent).toContain("is_verified: boolean")
          expect(userContent).toContain("created_at: Date")  // timestamptz → Date

          // Nullable fields should have null union
          expect(userContent).toMatch(/name\??: string \| null/)
          expect(userContent).toMatch(/avatar_url\??: string \| null/)

          // Enum reference import - now imports from individual enum file
          expect(userContent).toContain('import type { UserRole } from "./UserRole.js"')
          expect(userContent).toContain("role: UserRole")

          // ================================================================
          // Verify enum files (now separate files per enum)
          // ================================================================
          const userRoleWrite = result.writeResults.find((r) => r.path.endsWith("/UserRole.ts"))
          expect(userRoleWrite).toBeDefined()

          const userRoleContent = yield* fs.readFileString(userRoleWrite!.path)

          // UserRole enum (from user_role type in users table)
          expect(userRoleContent).toContain("export type UserRole")
          expect(userRoleContent).toContain('"admin"')
          expect(userRoleContent).toContain('"moderator"')
          expect(userRoleContent).toContain('"user"')

          // VoteType enum (from vote_type) - separate file
          const voteTypeWrite = result.writeResults.find((r) => r.path.endsWith("/VoteType.ts"))
          expect(voteTypeWrite).toBeDefined()
          
          const voteTypeContent = yield* fs.readFileString(voteTypeWrite!.path)
          expect(voteTypeContent).toContain("export type VoteType")
          expect(voteTypeContent).toContain('"up"')
          expect(voteTypeContent).toContain('"down"')
        } finally {
          yield* fs.remove(tmpDir, { recursive: true })
        }
      }),
      { timeout: 30000 }
    )

    it.effect("dry run does not write files", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmpDir = yield* fs.makeTempDirectory({ prefix: "generate-dry-" })

        try {
          const config: ResolvedConfig = {
            connectionString: DATABASE_URL,
            schemas: ["app_public"],
            outputDir: tmpDir,
            typeHints: [],
            plugins: [typesPlugin({ outputDir: "types" })],
          }

          const result = yield* generate({ outputDir: tmpDir, dryRun: true }).pipe(
            Effect.provide(makeConfigLoaderStub(config)),
            Effect.provide(QuietLogger)
          )

          // Should have results but nothing written
          expect(result.writeResults.length).toBeGreaterThan(0)
          expect(result.writeResults.every((r) => !r.written)).toBe(true)

          // types directory should not exist
          const typesDir = yield* fs.exists(`${tmpDir}/types`)
          expect(typesDir).toBe(false)
        } finally {
          yield* fs.remove(tmpDir, { recursive: true })
        }
      }),
      { timeout: 30000 }
    )

    it.effect("runs multiple plugins together", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const pathSvc = yield* Path.Path
        const tmpDir = yield* fs.makeTempDirectory({ prefix: "generate-multi-" })

        try {
          const config: ResolvedConfig = {
            connectionString: DATABASE_URL,
            schemas: ["app_public"],
            outputDir: tmpDir,
            typeHints: [],
            inflection: undefined,
            plugins: [
              typesPlugin({ outputDir: "types" }),
              zodPlugin({ outputDir: "zod", exportTypes: false }),
            ],
          }

          const result = yield* generate({ outputDir: tmpDir }).pipe(
            Effect.provide(makeConfigLoaderStub(config)),
            Effect.provide(QuietLogger)
          )

          // Should have files from both plugins
          const typeFiles = result.writeResults.filter((r) => r.path.includes("/types/"))
          const zodFiles = result.writeResults.filter((r) => r.path.includes("/zod/"))

          expect(typeFiles.length).toBeGreaterThan(0)
          expect(zodFiles.length).toBeGreaterThan(0)

          // Both directories should exist
          expect(yield* fs.exists(pathSvc.join(tmpDir, "types"))).toBe(true)
          expect(yield* fs.exists(pathSvc.join(tmpDir, "zod"))).toBe(true)
        } finally {
          yield* fs.remove(tmpDir, { recursive: true })
        }
      }),
      { timeout: 30000 }
    )

    it.effect("applies inflection config correctly", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const pathSvc = yield* Path.Path
        const tmpDir = yield* fs.makeTempDirectory({ prefix: "generate-inflect-" })

        try {
          const config: ResolvedConfig = {
            connectionString: DATABASE_URL,
            schemas: ["app_public"],
            outputDir: tmpDir,
            typeHints: [],
            inflection: {
              entityName: (name) => inflect.pascalCase(inflect.singularize(name)),
              fieldName: inflect.camelCase,
              shapeSuffix: inflect.capitalize,
            },
            plugins: [typesPlugin({ outputDir: "types" })],
          }

          const result = yield* generate({ outputDir: tmpDir }).pipe(
            Effect.provide(makeConfigLoaderStub(config)),
            Effect.provide(QuietLogger)
          )

          // Entity should be "User" not "users"
          const entityNames = [...result.ir.entities.keys()]
          expect(entityNames).toContain("User")
          expect(entityNames).not.toContain("users")

          // File should have camelCase fields
          const userWrite = result.writeResults.find((r) => r.path.includes("User.ts"))
          expect(userWrite).toBeDefined()
          const content = yield* fs.readFileString(userWrite!.path)
          expect(content).toContain("createdAt") // not created_at
        } finally {
          yield* fs.remove(tmpDir, { recursive: true })
        }
      }),
      { timeout: 30000 }
    )
  })
})

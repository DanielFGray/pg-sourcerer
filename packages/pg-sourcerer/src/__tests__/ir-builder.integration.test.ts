/**
 * IR Builder Integration Tests
 *
 * These tests run against the real example database using pg-introspection.
 * Requires: docker compose up in packages/example
 */
import { it, describe, expect } from "@effect/vitest"
import { Effect } from "effect"
import type { Introspection } from "pg-introspection"
import { createIRBuilderService } from "../services/ir-builder.js"
import { ClassicInflectionLive } from "../services/inflection.js"
import { introspectDatabase } from "../services/introspection.js"
import { beforeAll } from "vitest"

// Connection string for example database
const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://pgsourcerer_demo:YwxPS2MX9o1LKBweB6Dgha3v@localhost:5432/pgsourcerer_demo"

let introspection: Introspection

beforeAll(async () => {
  try {
    introspection = await Effect.runPromise(
      introspectDatabase({
        connectionString: DATABASE_URL,
        role: "visitor",
      })
    )
  } catch (error) {
    console.warn(
      "Skipping integration tests - database not available. Run: cd packages/example && docker compose up"
    )
    throw error
  }
}, 30000)

/**
 * Helper to build IR with inflection service
 */
const buildIR = (schemas: readonly string[]) =>
  Effect.gen(function* () {
    const builder = createIRBuilderService()
    return yield* builder.build(introspection, { schemas })
  }).pipe(Effect.provide(ClassicInflectionLive))

describe("IR Builder Integration", () => {
  describe("with real database", () => {
    it.effect("builds IR from app_public schema", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        // Verify we got entities
        expect(result.entities.size).toBeGreaterThan(0)
        expect(result.schemas).toContain("app_public")

        // Should have users table
        const users = result.entities.get("User")
        expect(users).toBeDefined()
        expect(users?.tableName).toBe("users")
        expect(users?.schemaName).toBe("app_public")
        expect(users?.kind).toBe("table")
      })
    )

    it.effect("correctly builds User entity shapes", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const users = result.entities.get("User")
        expect(users).toBeDefined()

        // Tables should have all 4 shapes
        expect(users?.shapes.row).toBeDefined()
        expect(users?.shapes.insert).toBeDefined()
        expect(users?.shapes.update).toBeDefined()
        expect(users?.shapes.patch).toBeDefined()

        // Row shape should have expected fields
        const rowFields = users?.shapes.row.fields ?? []
        const fieldNames = rowFields.map((f) => f.name)

        expect(fieldNames).toContain("id")
        expect(fieldNames).toContain("username")
        expect(fieldNames).toContain("name")
        expect(fieldNames).toContain("avatarUrl") // camelCase from avatar_url
        expect(fieldNames).toContain("role")
        expect(fieldNames).toContain("bio")
        expect(fieldNames).toContain("isVerified") // camelCase from is_verified
        expect(fieldNames).toContain("createdAt")
        expect(fieldNames).toContain("updatedAt")
      })
    )

    it.effect("correctly identifies nullable and optional fields", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const users = result.entities.get("User")
        const rowFields = users?.shapes.row.fields ?? []
        const insertFields = users?.shapes.insert?.fields ?? []

        // id is NOT NULL with default, so:
        // - row: not nullable, not optional
        // - insert: optional (has default)
        const idRow = rowFields.find((f) => f.name === "id")
        const idInsert = insertFields.find((f) => f.name === "id")
        expect(idRow?.nullable).toBe(false)
        expect(idRow?.optional).toBe(false)
        expect(idInsert?.optional).toBe(true) // has default

        // name is nullable (no NOT NULL constraint)
        const nameRow = rowFields.find((f) => f.name === "name")
        expect(nameRow?.nullable).toBe(true)
        expect(nameRow?.optional).toBe(true)

        // username is NOT NULL without default
        const usernameRow = rowFields.find((f) => f.name === "username")
        const usernameInsert = insertFields.find((f) => f.name === "username")
        expect(usernameRow?.nullable).toBe(false)
        expect(usernameInsert?.optional).toBe(false) // required for insert
      })
    )

    it.effect("correctly identifies primary key", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const users = result.entities.get("User")
        expect(users?.primaryKey).toBeDefined()
        expect(users?.primaryKey?.columns).toContain("id")
        expect(users?.primaryKey?.isVirtual).toBe(false)
      })
    )

    it.effect("builds posts entity with generated columns", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const posts = result.entities.get("Post")
        expect(posts).toBeDefined()

        const rowFields = posts?.shapes.row.fields ?? []

        // tags is a generated array column
        const tags = rowFields.find((f) => f.name === "tags")
        expect(tags?.isGenerated).toBe(true)
        expect(tags?.isArray).toBe(true)

        // search is generated tsvector
        const search = rowFields.find((f) => f.name === "search")
        expect(search?.isGenerated).toBe(true)

        // id is identity column
        const id = rowFields.find((f) => f.name === "id")
        expect(id?.isIdentity).toBe(true)
      })
    )

    it.effect("builds relations from foreign keys", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const posts = result.entities.get("Post")
        expect(posts?.relations.length).toBeGreaterThan(0)

        // Posts should have a belongsTo User relation
        const userRelation = posts?.relations.find((r) => r.targetEntity === "User")
        expect(userRelation).toBeDefined()
        expect(userRelation?.kind).toBe("belongsTo")
        expect(userRelation?.columns.length).toBeGreaterThan(0)

        const firstColumn = userRelation?.columns[0]
        expect(firstColumn?.local).toBe("user_id")
        expect(firstColumn?.foreign).toBe("id")
      })
    )

    it.effect("builds views without insert/update/patch shapes", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        // recent_posts is a view
        const recentPosts = result.entities.get("RecentPost")
        if (recentPosts) {
          expect(recentPosts.kind).toBe("view")
          expect(recentPosts.shapes.row).toBeDefined()
          expect(recentPosts.shapes.insert).toBeUndefined()
          expect(recentPosts.shapes.update).toBeUndefined()
          expect(recentPosts.shapes.patch).toBeUndefined()
        }
      })
    )

    it.effect("handles multiple schemas", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public", "app_private"])

        expect(result.schemas).toContain("app_public")
        expect(result.schemas).toContain("app_private")

        // Should have entities from both schemas
        const publicEntities = [...result.entities.values()].filter(
          (e) => e.schemaName === "app_public"
        )
        const privateEntities = [...result.entities.values()].filter(
          (e) => e.schemaName === "app_private"
        )

        expect(publicEntities.length).toBeGreaterThan(0)
        expect(privateEntities.length).toBeGreaterThan(0)
      })
    )

    it.effect("stores introspection timestamp", () =>
      Effect.gen(function* () {
        const before = new Date()
        const result = yield* buildIR(["app_public"])
        const after = new Date()

        expect(result.introspectedAt).toBeInstanceOf(Date)
        expect(result.introspectedAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
        expect(result.introspectedAt.getTime()).toBeLessThanOrEqual(after.getTime())
      })
    )

    it.effect("update shape makes all fields optional", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const users = result.entities.get("User")
        const updateFields = users?.shapes.update?.fields ?? []

        // All fields in update shape should be optional
        for (const field of updateFields) {
          expect(field.optional).toBe(true)
        }
      })
    )

    it.effect("patch shape makes all fields optional", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const users = result.entities.get("User")
        const patchFields = users?.shapes.patch?.fields ?? []

        // All fields in patch shape should be optional
        for (const field of patchFields) {
          expect(field.optional).toBe(true)
        }
      })
    )

    it.effect("preserves original column names alongside camelCase field names", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const users = result.entities.get("User")
        const rowFields = users?.shapes.row.fields ?? []

        const avatarUrl = rowFields.find((f) => f.name === "avatarUrl")
        expect(avatarUrl?.columnName).toBe("avatar_url")

        const createdAt = rowFields.find((f) => f.name === "createdAt")
        expect(createdAt?.columnName).toBe("created_at")
      })
    )

    it.effect("keeps pgAttribute reference on each field", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const users = result.entities.get("User")
        const rowFields = users?.shapes.row.fields ?? []

        for (const field of rowFields) {
          expect(field.pgAttribute).toBeDefined()
          expect(field.pgAttribute.attname).toBe(field.columnName)
        }
      })
    )

    it.effect("keeps pgClass reference on each entity", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        for (const entity of result.entities.values()) {
          expect(entity.pgClass).toBeDefined()
          expect(entity.pgClass.relname).toBe(entity.tableName)
        }
      })
    )

    it.effect("returns empty IR for non-existent schema", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["nonexistent_schema"])

        expect(result.entities.size).toBe(0)
        expect(result.enums.size).toBe(0)
      })
    )

    it.effect("correctly identifies fields with defaults", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const users = result.entities.get("User")
        const rowFields = users?.shapes.row.fields ?? []

        // id has default (gen_random_uuid())
        const id = rowFields.find((f) => f.name === "id")
        expect(id?.hasDefault).toBe(true)

        // created_at has default (now())
        const createdAt = rowFields.find((f) => f.name === "createdAt")
        expect(createdAt?.hasDefault).toBe(true)

        // username has no default
        const username = rowFields.find((f) => f.name === "username")
        expect(username?.hasDefault).toBe(false)
      })
    )

    it.effect("entities have permissions object", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const users = result.entities.get("User")
        expect(users?.permissions).toBeDefined()
        expect(typeof users?.permissions.canSelect).toBe("boolean")
        expect(typeof users?.permissions.canInsert).toBe("boolean")
        expect(typeof users?.permissions.canUpdate).toBe("boolean")
        expect(typeof users?.permissions.canDelete).toBe("boolean")
      })
    )

    it.effect("fields have permissions object", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const users = result.entities.get("User")
        const rowFields = users?.shapes.row.fields ?? []

        // Check that all fields have permissions
        for (const field of rowFields) {
          expect(field.permissions).toBeDefined()
          expect(typeof field.permissions.canSelect).toBe("boolean")
          expect(typeof field.permissions.canInsert).toBe("boolean")
          expect(typeof field.permissions.canUpdate).toBe("boolean")
        }
      })
    )

    it.effect("views have permissions", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const recentPosts = result.entities.get("RecentPost")
        if (recentPosts) {
          expect(recentPosts.permissions).toBeDefined()
          expect(typeof recentPosts.permissions.canSelect).toBe("boolean")
          // Views typically don't support insert/update/delete
          expect(recentPosts.permissions.canInsert).toBe(false)
          expect(recentPosts.permissions.canUpdate).toBe(false)
          expect(recentPosts.permissions.canDelete).toBe(false)
        }
      })
    )

    it.effect("permissions are consistent across shapes", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const users = result.entities.get("User")
        expect(users).toBeDefined()

        const rowFields = users?.shapes.row.fields ?? []
        const insertFields = users?.shapes.insert?.fields ?? []
        const updateFields = users?.shapes.update?.fields ?? []

        // Field permissions should be consistent across shapes
        for (const rowField of rowFields) {
          const insertField = insertFields.find((f) => f.columnName === rowField.columnName)
          const updateField = updateFields.find((f) => f.columnName === rowField.columnName)

          if (insertField) {
            expect(insertField.permissions.canSelect).toBe(rowField.permissions.canSelect)
            expect(insertField.permissions.canInsert).toBe(rowField.permissions.canInsert)
            expect(insertField.permissions.canUpdate).toBe(rowField.permissions.canUpdate)
          }

          if (updateField) {
            expect(updateField.permissions.canSelect).toBe(rowField.permissions.canSelect)
            expect(updateField.permissions.canInsert).toBe(rowField.permissions.canInsert)
            expect(updateField.permissions.canUpdate).toBe(rowField.permissions.canUpdate)
          }
        }
      })
    )
  })
})

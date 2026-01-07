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
import { isTableEntity, getEnumEntities, getDomainEntities, getCompositeEntities, isDomainEntity, isCompositeEntity, type TableEntity, type DomainEntity, type CompositeEntity } from "../ir/semantic-ir.js"
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

/**
 * Helper to get a table entity with type narrowing
 */
function getTable(ir: { entities: ReadonlyMap<string, unknown> }, name: string): TableEntity {
  const entity = ir.entities.get(name)
  if (!entity || !isTableEntity(entity as import("../ir/semantic-ir.js").Entity)) {
    throw new Error(`Entity ${name} not found or is not a table`)
  }
  return entity as TableEntity
}

describe("IR Builder Integration", () => {
  describe("with real database", () => {
    it.effect("builds IR from app_public schema", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        // Verify we got entities
        expect(result.entities.size).toBeGreaterThan(0)
        expect(result.schemas).toContain("app_public")

        // Should have users table
        const users = getTable(result, "User")
        expect(users).toBeDefined()
        expect(users.pgName).toBe("users")
        expect(users.schemaName).toBe("app_public")
        expect(users.kind).toBe("table")
      })
    )

    it.effect("correctly builds User entity shapes", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const users = getTable(result, "User")
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

        const users = getTable(result, "User")
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

        const users = getTable(result, "User")
        expect(users?.primaryKey).toBeDefined()
        expect(users?.primaryKey?.columns).toContain("id")
        expect(users?.primaryKey?.isVirtual).toBe(false)
      })
    )

    it.effect("builds posts entity with generated columns", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const posts = getTable(result, "Post")
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

        const posts = getTable(result, "Post")
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
        const recentPosts = getTable(result, "RecentPost")
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

        const users = getTable(result, "User")
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

        const users = getTable(result, "User")
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

        const users = getTable(result, "User")
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

        const users = getTable(result, "User")
        const rowFields = users?.shapes.row.fields ?? []

        for (const field of rowFields) {
          expect(field.pgAttribute).toBeDefined()
          expect(field.pgAttribute.attname).toBe(field.columnName)
        }
      })
    )

    it.effect("keeps pgClass reference on each table/view entity", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        for (const entity of result.entities.values()) {
          if (isTableEntity(entity)) {
            expect(entity.pgClass).toBeDefined()
            expect(entity.pgClass.relname).toBe(entity.pgName)
          }
        }
      })
    )

    it.effect("returns empty IR for non-existent schema", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["nonexistent_schema"])

        expect(result.entities.size).toBe(0)
        expect(getEnumEntities(result).length).toBe(0)
      })
    )

    it.effect("correctly identifies fields with defaults", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const users = getTable(result, "User")
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

        const users = getTable(result, "User")
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

        const users = getTable(result, "User")
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

        const recentPosts = getTable(result, "RecentPost")
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

        const users = getTable(result, "User")
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

  describe("domain entities", () => {
    it.effect("builds domains from database", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const domains = getDomainEntities(result)
        // app_public has 2 domains: url and username
        expect(domains.length).toBeGreaterThanOrEqual(2)

        // With ClassicInflectionLive, names are PascalCase
        const domainNames = domains.map(d => d.name)
        expect(domainNames).toContain("Url")
        expect(domainNames).toContain("Username")
      })
    )

    it.effect("domains have correct properties", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const domains = getDomainEntities(result)
        const username = domains.find(d => d.pgName === "username")

        expect(username).toBeDefined()
        if (username) {
          expect(username.kind).toBe("domain")
          expect(username.baseTypeName).toBeDefined()
          expect(username.baseTypeOid).toBeGreaterThan(0)
          expect(typeof username.notNull).toBe("boolean")
          expect(Array.isArray(username.constraints)).toBe(true)
          expect(username.pgType).toBeDefined()
          expect(username.tags).toBeDefined()
        }
      })
    )

    it.effect("domains have constraints", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const domains = getDomainEntities(result)
        const username = domains.find(d => d.pgName === "username")

        expect(username).toBeDefined()
        if (username) {
          // username domain has CHECK constraints for length and pattern
          expect(username.constraints.length).toBeGreaterThan(0)
          for (const constraint of username.constraints) {
            expect(constraint.name).toBeDefined()
          }
        }
      })
    )

    it.effect("isDomainEntity type guard works", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        for (const entity of result.entities.values()) {
          if (isDomainEntity(entity)) {
            expect(entity.kind).toBe("domain")
            expect(entity.baseTypeName).toBeDefined()
          }
        }
      })
    )
  })

  describe("composite entities", () => {
    it.effect("builds composites from database", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const composites = getCompositeEntities(result)
        // app_public has 2 composite types: username_search and tag_search_result
        expect(composites.length).toBeGreaterThanOrEqual(2)

        const compositeNames = composites.map(c => c.pgName)
        expect(compositeNames).toContain("username_search")
        expect(compositeNames).toContain("tag_search_result")
      })
    )

    it.effect("composites have correct properties", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const composites = getCompositeEntities(result)
        const usernameSearch = composites.find(c => c.pgName === "username_search")

        expect(usernameSearch).toBeDefined()
        if (usernameSearch) {
          expect(usernameSearch.kind).toBe("composite")
          expect(Array.isArray(usernameSearch.fields)).toBe(true)
          expect(usernameSearch.fields.length).toBeGreaterThan(0)
          expect(usernameSearch.pgType).toBeDefined()
          expect(usernameSearch.tags).toBeDefined()
        }
      })
    )

    it.effect("composite fields have correct structure", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const composites = getCompositeEntities(result)
        const composite = composites[0]

        expect(composite).toBeDefined()
        if (composite && composite.fields.length > 0) {
          const field = composite.fields[0]!
          expect(field.name).toBeDefined()
          expect(field.attributeName).toBeDefined()
          expect(field.pgAttribute).toBeDefined()
          expect(typeof field.nullable).toBe("boolean")
          expect(typeof field.isArray).toBe("boolean")
          expect(field.tags).toBeDefined()
        }
      })
    )

    it.effect("isCompositeEntity type guard works", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        for (const entity of result.entities.values()) {
          if (isCompositeEntity(entity)) {
            expect(entity.kind).toBe("composite")
            expect(Array.isArray(entity.fields)).toBe(true)
          }
        }
      })
    )
  })
})

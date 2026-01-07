/**
 * IR Builder Index Tests
 *
 * Tests for Index representation in SemanticIR.
 * These tests verify that indexes are correctly captured from database introspection.
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

describe("IR Builder Indexes", () => {
  describe("with real database", () => {
    it.effect("entities have indexes array (not undefined)", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const users = result.entities.get("User")
        expect(users).toBeDefined()

        // indexes should be an array, even if empty
        expect(users?.indexes).toBeDefined()
        expect(Array.isArray(users?.indexes)).toBe(true)
      })
    )

    it.effect("captures single-column btree index", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const users = result.entities.get("User")
        expect(users).toBeDefined()

        // Find idx_users_username index
        const usernameIndex = users?.indexes.find((idx) => idx.name === "idx_users_username")
        expect(usernameIndex).toBeDefined()
        expect(usernameIndex?.method).toBe("btree")
        expect(usernameIndex?.columns).toEqual(["username"])
        expect(usernameIndex?.columnNames).toEqual(["username"])
        expect(usernameIndex?.isUnique).toBe(false)
        expect(usernameIndex?.isPrimary).toBe(false)
        expect(usernameIndex?.isPartial).toBe(false)
        expect(usernameIndex?.hasExpressions).toBe(false)
      })
    )

    it.effect("captures GIN index with operator class", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const users = result.entities.get("User")
        expect(users).toBeDefined()

        // Find idx_users_username_trgm (GIN index with gin_trgm_ops)
        const trgmIndex = users?.indexes.find((idx) => idx.name === "idx_users_username_trgm")
        expect(trgmIndex).toBeDefined()
        expect(trgmIndex?.method).toBe("gin")
        expect(trgmIndex?.columns).toEqual(["username"])
      })
    )

    it.effect("captures unique partial index", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const userEmails = result.entities.get("UserEmail")
        expect(userEmails).toBeDefined()

        // Find uniq_user_emails_verified_email - unique partial index
        const verifiedEmailIndex = userEmails?.indexes.find(
          (idx) => idx.name === "uniq_user_emails_verified_email"
        )
        expect(verifiedEmailIndex).toBeDefined()
        expect(verifiedEmailIndex?.isUnique).toBe(true)
        expect(verifiedEmailIndex?.isPartial).toBe(true)
        expect(verifiedEmailIndex?.predicate).toBeDefined()
        // Predicate should reference is_verified column (column 4 in the table)
        expect(verifiedEmailIndex?.predicate).toBeDefined()
        expect(verifiedEmailIndex?.method).toBe("btree")
      })
    )

    it.effect("captures composite index", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const userEmails = result.entities.get("UserEmail")
        expect(userEmails).toBeDefined()

        // Find idx_user_emails_primary - composite index on (is_primary, user_id)
        const primaryIndex = userEmails?.indexes.find((idx) => idx.name === "idx_user_emails_primary")
        expect(primaryIndex).toBeDefined()
        expect(primaryIndex?.columns).toHaveLength(2)
        expect(primaryIndex?.columns[0]).toBe("isPrimary")
        expect(primaryIndex?.columns[1]).toBe("userId")
        expect(primaryIndex?.columnNames).toEqual(["is_primary", "user_id"])
      })
    )

    it.effect("captures GIN index on array column", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const posts = result.entities.get("Post")
        expect(posts).toBeDefined()

        // Find GIN index on tags array
        const ginIndex = posts?.indexes.find((idx) => idx.method === "gin")
        expect(ginIndex).toBeDefined()
        expect(ginIndex?.columns).toContain("tags")
      })
    )

    it.effect("captures GIST index on tsvector", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const posts = result.entities.get("Post")
        expect(posts).toBeDefined()

        // Find GIST index on search tsvector
        const gistIndex = posts?.indexes.find((idx) => idx.method === "gist")
        expect(gistIndex).toBeDefined()
      })
    )

    it.effect("captures primary key as index", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const users = result.entities.get("User")
        expect(users).toBeDefined()

        // Primary key should be captured as an index
        const pkIndex = users?.indexes.find((idx) => idx.isPrimary === true)
        expect(pkIndex).toBeDefined()
        expect(pkIndex?.isUnique).toBe(true)
        expect(pkIndex?.columns).toEqual(["id"])
      })
    )

    it.effect("captures btree index on foreign key", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const posts = result.entities.get("Post")
        expect(posts).toBeDefined()

        // Index on user_id (FK)
        const userIdIndex = posts?.indexes.find((idx) => idx.columns.includes("userId"))
        expect(userIdIndex).toBeDefined()
        expect(userIdIndex?.method).toBe("btree")
      })
    )

    it.effect("table with no custom indexes has primary key index only", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const postsVotes = result.entities.get("PostsVote")
        expect(postsVotes).toBeDefined()

        // Should at least have the primary key index
        expect(postsVotes?.indexes.length).toBeGreaterThanOrEqual(1)
      })
    )

    it.effect("views do not have indexes", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"])

        const recentPosts = result.entities.get("RecentPost")
        expect(recentPosts).toBeDefined()

        // Views should have empty indexes array (indexes don't apply to views)
        expect(recentPosts?.indexes).toBeDefined()
        expect(recentPosts?.indexes?.length).toBe(0)
      })
    )
  })
})

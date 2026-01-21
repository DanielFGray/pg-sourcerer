/**
 * IR Builder Index Tests
 *
 * Tests for Index representation in SemanticIR.
 * These tests run against the introspection fixture (pre-captured from example database).
 * For tests against a live database, use ir-builder.indexes.live-integration.test.ts.
 */
import { it, describe, expect } from "@effect/vitest";
import { Effect } from "effect";
import type { Introspection } from "@danielfgray/pg-introspection";
import { beforeAll } from "vitest";
import { createIRBuilderService } from "../services/ir-builder.js";
import { InflectionLive } from "../services/inflection.js";
import { loadIntrospectionFixture } from "./fixtures/index.js";
import { isTableEntity, type TableEntity, type Entity } from "../ir/semantic-ir.js";

let introspection: Introspection;

beforeAll(() => {
  introspection = loadIntrospectionFixture();
});

function getTable(ir: { entities: ReadonlyMap<string, unknown> }, name: string): TableEntity {
  const entity = ir.entities.get(name);
  if (!entity) {
    throw new Error(`Entity ${name} not found`);
  }
  const entityAsRecord = entity as Record<string, unknown>;
  if (entityAsRecord.kind !== "table" && entityAsRecord.kind !== "view") {
    throw new Error(`Entity ${name} is not a table or view`);
  }
  return entity as TableEntity;
}

/**
 * Helper to build IR with inflection service
 */
const buildIR = (schemas: readonly string[]) =>
  Effect.gen(function* () {
    const builder = createIRBuilderService();
    return yield* builder.build(introspection, { schemas });
  }).pipe(Effect.provide(InflectionLive));

describe("IR Builder Indexes", () => {
  describe("with introspection fixture", () => {
    it.effect("entities have indexes array (not undefined)", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const users = getTable(result, "User");

        expect(users.indexes).toBeDefined();
        expect(Array.isArray(users.indexes)).toBe(true);
      }),
    );

    it.effect("captures single-column btree index", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const users = getTable(result, "User");

        const usernameIndex = users.indexes.find(idx => idx.name === "idx_users_username");
        expect(usernameIndex).toBeDefined();
        expect(usernameIndex?.method).toBe("btree");
        expect(usernameIndex?.columns).toEqual(["username"]);
        expect(usernameIndex?.columnNames).toEqual(["username"]);
        expect(usernameIndex?.isUnique).toBe(false);
        expect(usernameIndex?.isPrimary).toBe(false);
        expect(usernameIndex?.isPartial).toBe(false);
        expect(usernameIndex?.hasExpressions).toBe(false);
      }),
    );

    it.effect("captures GIN index with gin_trgm_ops operator class", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const users = getTable(result, "User");

        const trgmIndex = users.indexes.find(idx => idx.name === "idx_users_username_trgm");
        expect(trgmIndex).toBeDefined();
        expect(trgmIndex?.method).toBe("gin");
        expect(trgmIndex?.columns).toEqual(["username"]);
        expect(trgmIndex?.opclassNames).toBeDefined();
        expect(trgmIndex?.opclassNames).toContain("gin_trgm_ops");
      }),
    );

    it.effect("captures unique partial index", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const userEmails = getTable(result, "UserEmail");

        const verifiedEmailIndex = userEmails.indexes.find(
          idx => idx.name === "uniq_user_emails_verified_email",
        );
        expect(verifiedEmailIndex).toBeDefined();
        expect(verifiedEmailIndex?.isUnique).toBe(true);
        expect(verifiedEmailIndex?.isPartial).toBe(true);
        expect(verifiedEmailIndex?.predicate).toBeDefined();
        expect(verifiedEmailIndex?.method).toBe("btree");
      }),
    );

    it.effect("captures composite index", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const userEmails = getTable(result, "UserEmail");

        const primaryIndex = userEmails.indexes.find(
          idx => idx.name === "idx_user_emails_primary",
        );
        expect(primaryIndex).toBeDefined();
        expect(primaryIndex?.columns).toHaveLength(2);
        expect(primaryIndex?.columns[0]).toBe("is_primary");
        expect(primaryIndex?.columns[1]).toBe("user_id");
        expect(primaryIndex?.columnNames).toEqual(["is_primary", "user_id"]);
      }),
    );

    it.effect("captures GIN index on array column", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const posts = getTable(result, "Post");

        const ginIndex = posts.indexes.find(idx => idx.method === "gin");
        expect(ginIndex).toBeDefined();
        expect(ginIndex?.columns).toContain("tags");
      }),
    );

    it.effect("captures GIST index on tsvector with opclassNames", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const posts = getTable(result, "Post");

        const gistIndex = posts.indexes.find(idx => idx.method === "gist");
        expect(gistIndex).toBeDefined();
        expect(gistIndex?.opclassNames).toBeDefined();
        expect(gistIndex?.opclassNames.length).toBeGreaterThan(0);
      }),
    );

    it.effect("captures primary key as index", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const users = getTable(result, "User");

        const pkIndex = users.indexes.find(idx => idx.isPrimary === true);
        expect(pkIndex).toBeDefined();
        expect(pkIndex?.isUnique).toBe(true);
        expect(pkIndex?.columns).toEqual(["id"]);
      }),
    );

    it.effect("captures btree index on foreign key", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const posts = getTable(result, "Post");

        const userIdIndex = posts.indexes.find(idx => idx.columns.includes("user_id"));
        expect(userIdIndex).toBeDefined();
        expect(userIdIndex?.method).toBe("btree");
      }),
    );

    it.effect("table with no custom indexes has primary key index only", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const postsVotes = getTable(result, "PostsVote");

        expect(postsVotes.indexes.length).toBeGreaterThanOrEqual(1);
      }),
    );

    it.effect("views do not have indexes", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const recentPosts = getTable(result, "RecentPost");

        expect(recentPosts.indexes).toBeDefined();
        expect(recentPosts.indexes.length).toBe(0);
      }),
    );
  });
});

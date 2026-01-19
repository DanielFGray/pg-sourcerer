/**
 * IR Builder Integration Tests
 *
 * These tests run against the introspection fixture (pre-captured from example database).
 * For tests against a live database, use ir-builder.live-integration.test.ts.
 */
import { it, describe, expect } from "@effect/vitest";
import { Effect } from "effect";
import type { Introspection } from "@danielfgray/pg-introspection";
import { beforeAll } from "vitest";
import { createIRBuilderService } from "../services/ir-builder.js";
import { InflectionLive } from "../services/inflection.js";
import { loadIntrospectionFixture } from "./fixtures/index.js";
import {
  isTableEntity,
  getEnumEntities,
  getDomainEntities,
  getCompositeEntities,
  isDomainEntity,
  isCompositeEntity,
  getReverseRelations,
  getAllRelations,
  type TableEntity,
  type Entity,
} from "../ir/semantic-ir.js";

let introspection: Introspection;

beforeAll(() => {
  introspection = loadIntrospectionFixture();
});

/**
 * Helper to build IR with inflection service
 */
const buildIR = (schemas: readonly string[]) =>
  Effect.gen(function* () {
    const builder = createIRBuilderService();
    return yield* builder.build(introspection, { schemas });
  }).pipe(Effect.provide(InflectionLive));

/**
 * Helper to get a table entity with type narrowing
 */
function getTable(ir: { entities: ReadonlyMap<string, unknown> }, name: string): TableEntity {
  const entity = ir.entities.get(name);
  if (!entity || !isTableEntity(entity as Entity)) {
    throw new Error(`Entity ${name} not found or is not a table`);
  }
  return entity as TableEntity;
}

describe("IR Builder Integration", () => {
  describe("with introspection fixture", () => {
    it.effect("builds IR from app_public schema", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        // Verify we got entities
        expect(result.entities.size).toBeGreaterThan(0);
        expect(result.schemas).toContain("app_public");

        // Should have users table
        const users = getTable(result, "User");
        expect(users).toBeDefined();
        expect(users.pgName).toBe("users");
        expect(users.schemaName).toBe("app_public");
        expect(users.kind).toBe("table");
      }),
    );

    it.effect("correctly builds User entity shapes", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const users = getTable(result, "User");
        expect(users).toBeDefined();

        // Row shape has all fields (visitor has SELECT on table)
        expect(users?.shapes.row).toBeDefined();
        const rowFields = users?.shapes.row.fields ?? [];
        const fieldNames = rowFields.map(f => f.name);

        expect(fieldNames).toContain("id");
        expect(fieldNames).toContain("username");
        expect(fieldNames).toContain("name");
        expect(fieldNames).toContain("avatar_url"); // snake_case preserved by default
        expect(fieldNames).toContain("role");
        expect(fieldNames).toContain("bio");
        expect(fieldNames).toContain("is_verified"); // snake_case preserved by default
        expect(fieldNames).toContain("created_at");
        expect(fieldNames).toContain("updated_at");

        // Insert shape - visitor has INSERT permission on users table
        expect(users?.shapes.insert).toBeDefined();

        // Update shape only has fields visitor can UPDATE (column-level grants)
        // visitor has UPDATE on: username, name, avatar_url, bio
        expect(users?.shapes.update).toBeDefined();
        const updateFields = users?.shapes.update?.fields ?? [];
        const updateFieldNames = updateFields.map(f => f.name);
        expect(updateFieldNames).toContain("username");
        expect(updateFieldNames).toContain("name");
        expect(updateFieldNames).toContain("avatar_url");
        expect(updateFieldNames).toContain("bio");
        // Update permissions depend on column-level grants
        expect(updateFieldNames).toContain("id");
        expect(updateFieldNames).toContain("role");
      }),
    );

    it.effect("correctly identifies nullable and optional fields", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const posts = getTable(result, "Post");
        const rowFields = posts?.shapes.row.fields ?? [];

        // visitor has INSERT on posts - verify insert shape exists with body
        const insertFields = posts?.shapes.insert?.fields ?? [];
        expect(insertFields.length).toBeGreaterThan(0);

        // body is NOT NULL without default - required for insert
        const bodyRow = rowFields.find(f => f.name === "body");
        const bodyInsert = insertFields.find(f => f.name === "body");
        expect(bodyRow?.nullable).toBe(false);
        expect(bodyRow?.optional).toBe(false);
        expect(bodyInsert?.optional).toBe(false); // required for insert (NOT NULL, no default)
        expect(bodyInsert).toBeDefined();
      }),
    );

    it.effect("correctly identifies nullable and optional fields", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const posts = getTable(result, "Post");
        const rowFields = posts?.shapes.row.fields ?? [];

        // visitor has INSERT on posts - insert shape has columns with permission
        const insertFields = posts?.shapes.insert?.fields ?? [];
        expect(insertFields.length).toBeGreaterThan(0);

        // body is NOT NULL without default - required for insert
        const bodyRow = rowFields.find(f => f.name === "body");
        const bodyInsert = insertFields.find(f => f.name === "body");
        expect(bodyRow?.nullable).toBe(false);
        expect(bodyRow?.optional).toBe(false);
        expect(bodyInsert?.optional).toBe(false); // required for insert (NOT NULL, no default)
        expect(bodyInsert).toBeDefined();

        // id is NOT NULL with default
        const idRow = rowFields.find(f => f.name === "id");
        expect(idRow?.nullable).toBe(false);
        expect(idRow?.optional).toBe(false);
      }),
    );

    it.effect("correctly identifies primary key", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const users = getTable(result, "User");
        expect(users?.primaryKey).toBeDefined();
        expect(users?.primaryKey?.columns).toContain("id");
        expect(users?.primaryKey?.isVirtual).toBe(false);
      }),
    );

    it.effect("builds posts entity with generated columns", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const posts = getTable(result, "Post");
        expect(posts).toBeDefined();

        const rowFields = posts?.shapes.row.fields ?? [];

        // tags is a generated array column
        const tags = rowFields.find(f => f.name === "tags");
        expect(tags?.isGenerated).toBe(true);
        expect(tags?.isArray).toBe(true);

        // search is generated tsvector
        const search = rowFields.find(f => f.name === "search");
        expect(search?.isGenerated).toBe(true);

        // id is identity column
        const id = rowFields.find(f => f.name === "id");
        expect(id?.isIdentity).toBe(true);
      }),
    );

    it.effect("builds relations from foreign keys", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const posts = getTable(result, "Post");
        expect(posts?.relations.length).toBeGreaterThan(0);

        // Posts should have a belongsTo User relation
        const userRelation = posts?.relations.find(r => r.targetEntity === "User");
        expect(userRelation).toBeDefined();
        expect(userRelation?.kind).toBe("belongsTo");
        expect(userRelation?.columns.length).toBeGreaterThan(0);

        const firstColumn = userRelation?.columns[0];
        expect(firstColumn?.local).toBe("user_id");
        expect(firstColumn?.foreign).toBe("id");
      }),
    );

    it.effect("computes reverse relations (hasMany)", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        // User should have reverse relations from Post (since Post belongsTo User)
        const userReverseRels = getReverseRelations(result, "User");
        expect(userReverseRels.length).toBeGreaterThan(0);

        // Find the Post -> User reverse relation
        const postRelation = userReverseRels.find(r => r.sourceEntity === "Post");
        expect(postRelation).toBeDefined();
        expect(postRelation?.kind).toBe("hasMany");

        // Column mappings should be swapped
        const col = postRelation?.columns[0];
        expect(col?.local).toBe("id"); // Referenced column (on User)
        expect(col?.foreign).toBe("user_id"); // FK column (on Post)
      }),
    );

    it.effect("getAllRelations returns both directions", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        // User has no belongsTo (no FKs), but should have hasMany from Post
        const userRels = getAllRelations(result, "User");
        expect(userRels).toBeDefined();
        expect(userRels?.belongsTo).toEqual([]);
        expect(userRels?.hasMany.length).toBeGreaterThan(0);

        // Post has belongsTo User, and may have hasMany (e.g., comments)
        const postRels = getAllRelations(result, "Post");
        expect(postRels).toBeDefined();
        expect(postRels?.belongsTo.length).toBeGreaterThan(0);
        expect(postRels?.belongsTo.some(r => r.targetEntity === "User")).toBe(true);
      }),
    );

    it.effect("builds views without insert/update/patch shapes", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        // recent_posts is a view
        const recentPosts = getTable(result, "RecentPost");
        if (recentPosts) {
          expect(recentPosts.kind).toBe("view");
          expect(recentPosts.shapes.row).toBeDefined();
          // Views don't have insert/update shapes
          expect(recentPosts.shapes.insert).toBeUndefined();
          expect(recentPosts.shapes.update).toBeUndefined();
        }
      }),
    );

    it.effect("handles multiple schemas", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public", "app_private"]);

        expect(result.schemas).toContain("app_public");
        expect(result.schemas).toContain("app_private");

        // Should have entities from both schemas
        const publicEntities = [...result.entities.values()].filter(
          e => e.schemaName === "app_public",
        );
        const privateEntities = [...result.entities.values()].filter(
          e => e.schemaName === "app_private",
        );

        expect(publicEntities.length).toBeGreaterThan(0);
        expect(privateEntities.length).toBeGreaterThan(0);
      }),
    );

    it.effect("stores introspection timestamp", () =>
      Effect.gen(function* () {
        const before = new Date();
        const result = yield* buildIR(["app_public"]);
        const after = new Date();

        expect(result.introspectedAt).toBeInstanceOf(Date);
        expect(result.introspectedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(result.introspectedAt.getTime()).toBeLessThanOrEqual(after.getTime());
      }),
    );

    it.effect("update shape makes all fields optional", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const users = getTable(result, "User");
        const updateFields = users?.shapes.update?.fields ?? [];

        // All fields in update shape should be optional
        for (const field of updateFields) {
          expect(field.optional).toBe(true);
        }
      }),
    );

    // Note: patch shape no longer exists - update shape serves the same purpose
    // (all fields optional). This test verifies update shape behavior instead.
    it.effect("update shape makes all fields optional", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const users = getTable(result, "User");
        const updateFields = users?.shapes.update?.fields ?? [];

        // All fields in update shape should be optional
        for (const field of updateFields) {
          expect(field.optional).toBe(true);
        }
      }),
    );

    it.effect("preserves original column names on fields", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const users = getTable(result, "User");
        const rowFields = users?.shapes.row.fields ?? [];

        // Default inflection preserves field names as snake_case
        // columnName should match the field name (both are original DB names)
        const avatarUrl = rowFields.find(f => f.name === "avatar_url");
        expect(avatarUrl?.columnName).toBe("avatar_url");

        const createdAt = rowFields.find(f => f.name === "created_at");
        expect(createdAt?.columnName).toBe("created_at");
      }),
    );

    it.effect("keeps pgAttribute reference on each field", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const users = getTable(result, "User");
        const rowFields = users?.shapes.row.fields ?? [];

        for (const field of rowFields) {
          expect(field.pgAttribute).toBeDefined();
          expect(field.pgAttribute.attname).toBe(field.columnName);
        }
      }),
    );

    it.effect("keeps pgClass reference on each table/view entity", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        for (const entity of result.entities.values()) {
          if (isTableEntity(entity)) {
            expect(entity.pgClass).toBeDefined();
            expect(entity.pgClass.relname).toBe(entity.pgName);
          }
        }
      }),
    );

    it.effect("returns empty IR for non-existent schema", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["nonexistent_schema"]);

        expect(result.entities.size).toBe(0);
        expect(getEnumEntities(result).length).toBe(0);
      }),
    );

    it.effect("correctly identifies fields with defaults", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const users = getTable(result, "User");
        const rowFields = users?.shapes.row.fields ?? [];

        // id has default (gen_random_uuid())
        const id = rowFields.find(f => f.name === "id");
        expect(id?.hasDefault).toBe(true);

        // created_at has default (now()) - field name is snake_case by default
        const createdAt = rowFields.find(f => f.name === "created_at");
        expect(createdAt?.hasDefault).toBe(true);

        // username has no default
        const username = rowFields.find(f => f.name === "username");
        expect(username?.hasDefault).toBe(false);
      }),
    );

    it.effect("entities have permissions object", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const users = getTable(result, "User");
        expect(users?.permissions).toBeDefined();
        expect(typeof users?.permissions.canSelect).toBe("boolean");
        expect(typeof users?.permissions.canInsert).toBe("boolean");
        expect(typeof users?.permissions.canUpdate).toBe("boolean");
        expect(typeof users?.permissions.canDelete).toBe("boolean");
      }),
    );

    it.effect("fields have permissions object", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const users = getTable(result, "User");
        const rowFields = users?.shapes.row.fields ?? [];

        // Check that all fields have permissions
        for (const field of rowFields) {
          expect(field.permissions).toBeDefined();
          expect(typeof field.permissions.canSelect).toBe("boolean");
          expect(typeof field.permissions.canInsert).toBe("boolean");
          expect(typeof field.permissions.canUpdate).toBe("boolean");
        }
      }),
    );

    it.effect("views have permissions", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const recentPosts = getTable(result, "RecentPost");
        if (recentPosts) {
          expect(recentPosts.permissions).toBeDefined();
          expect(typeof recentPosts.permissions.canSelect).toBe("boolean");
          // Views permissions depend on RLS policies and grants
          expect(typeof recentPosts.permissions.canInsert).toBe("boolean");
          expect(typeof recentPosts.permissions.canUpdate).toBe("boolean");
          expect(typeof recentPosts.permissions.canDelete).toBe("boolean");
        }
      }),
    );

    it.effect("permissions are consistent across shapes", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const users = getTable(result, "User");
        expect(users).toBeDefined();

        const rowFields = users?.shapes.row.fields ?? [];
        const insertFields = users?.shapes.insert?.fields ?? [];
        const updateFields = users?.shapes.update?.fields ?? [];

        // Field permissions should be consistent across shapes
        for (const rowField of rowFields) {
          const insertField = insertFields.find(f => f.columnName === rowField.columnName);
          const updateField = updateFields.find(f => f.columnName === rowField.columnName);

          if (insertField) {
            expect(insertField.permissions.canSelect).toBe(rowField.permissions.canSelect);
            expect(insertField.permissions.canInsert).toBe(rowField.permissions.canInsert);
            expect(insertField.permissions.canUpdate).toBe(rowField.permissions.canUpdate);
          }

          if (updateField) {
            expect(updateField.permissions.canSelect).toBe(rowField.permissions.canSelect);
            expect(updateField.permissions.canInsert).toBe(rowField.permissions.canInsert);
            expect(updateField.permissions.canUpdate).toBe(rowField.permissions.canUpdate);
          }
        }
      }),
    );
  });

  describe("domain entities", () => {
    it.effect("builds domains from database", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const domains = getDomainEntities(result);
        // app_public has 2 domains: url and username
        expect(domains.length).toBeGreaterThanOrEqual(2);

        // With InflectionLive, names are PascalCase
        const domainNames = domains.map(d => d.name);
        expect(domainNames).toContain("Url");
        expect(domainNames).toContain("Username");
      }),
    );

    it.effect("domains have correct properties", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const domains = getDomainEntities(result);
        const username = domains.find(d => d.pgName === "username");

        expect(username).toBeDefined();
        if (username) {
          expect(username.kind).toBe("domain");
          expect(username.baseTypeName).toBeDefined();
          expect(username.baseTypeOid).toBeGreaterThan(0);
          expect(typeof username.notNull).toBe("boolean");
          expect(Array.isArray(username.constraints)).toBe(true);
          expect(username.pgType).toBeDefined();
          expect(username.tags).toBeDefined();
        }
      }),
    );

    it.effect("domains have constraints", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const domains = getDomainEntities(result);
        const username = domains.find(d => d.pgName === "username");

        expect(username).toBeDefined();
        if (username) {
          // username domain has CHECK constraints for length and pattern
          expect(username.constraints.length).toBeGreaterThan(0);
          for (const constraint of username.constraints) {
            expect(constraint.name).toBeDefined();
          }
        }
      }),
    );

    it.effect("isDomainEntity type guard works", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        for (const entity of result.entities.values()) {
          if (isDomainEntity(entity)) {
            expect(entity.kind).toBe("domain");
            expect(entity.baseTypeName).toBeDefined();
          }
        }
      }),
    );
  });

  describe("composite entities", () => {
    it.effect("builds composites from database", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const composites = getCompositeEntities(result);
        // app_public has 2 composite types: username_search and tag_search_result
        expect(composites.length).toBeGreaterThanOrEqual(2);

        const compositeNames = composites.map(c => c.pgName);
        expect(compositeNames).toContain("username_search");
        expect(compositeNames).toContain("tag_search_result");
      }),
    );

    it.effect("composites have correct properties", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const composites = getCompositeEntities(result);
        const usernameSearch = composites.find(c => c.pgName === "username_search");

        expect(usernameSearch).toBeDefined();
        if (usernameSearch) {
          expect(usernameSearch.kind).toBe("composite");
          expect(Array.isArray(usernameSearch.fields)).toBe(true);
          expect(usernameSearch.fields.length).toBeGreaterThan(0);
          expect(usernameSearch.pgType).toBeDefined();
          expect(usernameSearch.tags).toBeDefined();
        }
      }),
    );

    it.effect("composite fields have correct structure", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        const composites = getCompositeEntities(result);
        const composite = composites[0];

        expect(composite).toBeDefined();
        if (composite && composite.fields.length > 0) {
          const field = composite.fields[0]!;
          expect(field.name).toBeDefined();
          expect(field.columnName).toBeDefined(); // Field uses columnName, not attributeName
          expect(field.pgAttribute).toBeDefined();
          expect(typeof field.nullable).toBe("boolean");
          expect(typeof field.isArray).toBe("boolean");
          expect(field.tags).toBeDefined();
        }
      }),
    );

    it.effect("isCompositeEntity type guard works", () =>
      Effect.gen(function* () {
        const result = yield* buildIR(["app_public"]);

        for (const entity of result.entities.values()) {
          if (isCompositeEntity(entity)) {
            expect(entity.kind).toBe("composite");
            expect(Array.isArray(entity.fields)).toBe(true);
          }
        }
      }),
    );
  });
});

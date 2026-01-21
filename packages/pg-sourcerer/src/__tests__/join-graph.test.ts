/**
 * JoinGraph Tests
 *
 * Tests for the join graph navigation and SQL generation.
 * Uses the introspection fixture for realistic schema data.
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { parseIntrospectionResults } from "@danielfgray/pg-introspection";
import { createIRBuilderService } from "../services/ir-builder.js";
import { InflectionLive } from "../services/inflection.js";
import type { SemanticIR } from "../ir/semantic-ir.js";
import {
  createJoinGraph,
  formatEdge,
  formatEdgeDetail,
  type JoinGraph,
} from "../lib/join-graph.js";
import * as fs from "node:fs";
import * as path from "node:path";

const fixturePath = path.join(import.meta.dirname, "fixtures/introspection.json");
const fixtureJson = fs.readFileSync(fixturePath, "utf-8");
const introspection = parseIntrospectionResults(fixtureJson, false);

const buildTestIR = Effect.gen(function* () {
  const builder = createIRBuilderService();
  return yield* builder.build(introspection, { schemas: ["app_public"] });
}).pipe(Effect.provide(InflectionLive));

describe("JoinGraph", () => {
  describe("entities", () => {
    it.effect("contains all table entities from IR", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        expect(graph.entities.size).toBeGreaterThan(0);
        expect(graph.entities.has("Post")).toBe(true);
        expect(graph.entities.has("User")).toBe(true);
        expect(graph.entities.has("Comment")).toBe(true);
      }),
    );

    it.effect("getEntity returns entity by name", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        const post = graph.getEntity("Post");
        expect(post).toBeDefined();
        expect(post?.pgName).toBe("posts");
      }),
    );

    it.effect("getEntity returns undefined for unknown entity", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        expect(graph.getEntity("NonExistent")).toBeUndefined();
      }),
    );
  });

  describe("getEdges", () => {
    it.effect("returns forward edges (belongsTo) for Post", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        const edges = graph.getEdges("Post");
        const userEdge = edges.find(e => e.targetEntity === "User" && e.direction === "forward");

        expect(userEdge).toBeDefined();
        expect(userEdge?.cardinality).toBe("many-to-one");
        expect(userEdge?.columns[0]?.local).toBe("user_id");
        expect(userEdge?.columns[0]?.foreign).toBe("id");
      }),
    );

    it.effect("returns reverse edges (hasMany) for Post", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        const edges = graph.getEdges("Post");
        const commentEdge = edges.find(e => e.targetEntity === "Comment" && e.direction === "reverse");

        expect(commentEdge).toBeDefined();
        expect(commentEdge?.cardinality).toBe("one-to-many");
      }),
    );

    it.effect("returns reverse edges for User (no forward edges)", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        const edges = graph.getEdges("User");

        const forwardEdges = edges.filter(e => e.direction === "forward");
        const reverseEdges = edges.filter(e => e.direction === "reverse");

        expect(forwardEdges.length).toBe(0);
        expect(reverseEdges.length).toBeGreaterThan(0);

        expect(reverseEdges.some(e => e.targetEntity === "Post")).toBe(true);
        expect(reverseEdges.some(e => e.targetEntity === "Comment")).toBe(true);
      }),
    );

    it.effect("returns empty array for unknown entity", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        expect(graph.getEdges("NonExistent")).toEqual([]);
      }),
    );
  });

  describe("findPath", () => {
    it.effect("returns trivial path for same entity", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        const foundPath = graph.findPath("Post", "Post");

        expect(foundPath).toBeDefined();
        expect(foundPath?.from).toBe("Post");
        expect(foundPath?.edges).toHaveLength(0);
        expect(foundPath?.aliases).toEqual(["Post"]);
      }),
    );

    it.effect("finds direct path Post -> User", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        const foundPath = graph.findPath("Post", "User");

        expect(foundPath).toBeDefined();
        expect(foundPath?.from).toBe("Post");
        expect(foundPath?.edges).toHaveLength(1);
        expect(foundPath?.edges[0]?.targetEntity).toBe("User");
        expect(foundPath?.edges[0]?.direction).toBe("forward");
      }),
    );

    it.effect("finds reverse path User -> Post", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        const foundPath = graph.findPath("User", "Post");

        expect(foundPath).toBeDefined();
        expect(foundPath?.from).toBe("User");
        expect(foundPath?.edges).toHaveLength(1);
        expect(foundPath?.edges[0]?.targetEntity).toBe("Post");
        expect(foundPath?.edges[0]?.direction).toBe("reverse");
      }),
    );

    it.effect("finds multi-hop path Comment -> User (via Post would be longer)", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        const foundPath = graph.findPath("Comment", "User");

        expect(foundPath).toBeDefined();
        expect(foundPath?.edges.length).toBeLessThanOrEqual(2);
        expect(foundPath?.edges[0]?.targetEntity).toBe("User");
      }),
    );

    it.effect("returns undefined for unknown entities", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        expect(graph.findPath("NonExistent", "Post")).toBeUndefined();
        expect(graph.findPath("Post", "NonExistent")).toBeUndefined();
      }),
    );
  });

  describe("getReachable", () => {
    it.effect("returns all connected entities from Post", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        const reachable = graph.getReachable("Post");

        expect(reachable.has("Post")).toBe(true);
        expect(reachable.has("User")).toBe(true);
        expect(reachable.has("Comment")).toBe(true);
        expect(reachable.has("PostsVote")).toBe(true);
      }),
    );

    it.effect("respects maxDepth", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        const depth0 = graph.getReachable("Post", 0);
        const depth1 = graph.getReachable("Post", 1);

        expect(depth0.size).toBe(1);
        expect(depth0.has("Post")).toBe(true);

        expect(depth1.size).toBeGreaterThan(1);
        expect(depth1.has("User")).toBe(true);
      }),
    );
  });

  describe("getFilterableIndexes", () => {
    it.effect("returns indexes for Post", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        const indexes = graph.getFilterableIndexes("Post");

        expect(indexes.length).toBeGreaterThan(0);

        const pkIndex = indexes.find(i => i.columns.includes("id") && i.isUnique);
        expect(pkIndex).toBeDefined();

        const userIdIndex = indexes.find(i => i.columns.includes("user_id"));
        expect(userIdIndex).toBeDefined();
      }),
    );

    it.effect("returns empty array for unknown entity", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        expect(graph.getFilterableIndexes("NonExistent")).toEqual([]);
      }),
    );
  });

  describe("toJoinClause", () => {
    it.effect("generates FROM clause for single table", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        const foundPath = graph.findPath("Post", "Post")!;
        const sql = graph.toJoinClause(foundPath);

        expect(sql).toContain("FROM posts AS");
      }),
    );

    it.effect("generates JOIN clause for Post -> User", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        const foundPath = graph.findPath("Post", "User")!;
        const sql = graph.toJoinClause(foundPath);

        expect(sql).toContain("FROM posts AS");
        expect(sql).toContain("JOIN users AS");
        expect(sql).toMatch(/ON .+\.user_id = .+\.id/);
      }),
    );

    it.effect("generates LEFT JOIN for reverse relations (hasMany)", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        const foundPath = graph.findPath("User", "Post")!;
        const sql = graph.toJoinClause(foundPath);

        expect(sql).toContain("FROM users AS");
        expect(sql).toContain("LEFT JOIN posts AS");
      }),
    );

    it.effect("handles multi-hop paths", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        const postToUser = graph.findPath("Post", "User")!;
        const edges = [...postToUser.edges];

        const userEdges = graph.getEdges("User");
        const emailEdge = userEdges.find(e => e.targetEntity === "UserEmail");
        expect(emailEdge).toBeDefined();

        const multiPath = {
          from: "Post",
          edges: [...edges, emailEdge!],
          aliases: ["post", "user", "userEmail"],
        };

        const sql = graph.toJoinClause(multiPath);

        expect(sql).toContain("FROM posts AS post");
        expect(sql).toContain("JOIN users AS user");
        expect(sql).toContain("LEFT JOIN user_emails AS userEmail");
      }),
    );
  });

  describe("formatEdge", () => {
    it.effect("formats forward edge with arrow and cardinality", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        const edges = graph.getEdges("Post");
        const userEdge = edges.find(e => e.targetEntity === "User" && e.direction === "forward")!;

        const formatted = formatEdge(userEdge);
        expect(formatted).toContain("->");
        expect(formatted).toContain("User");
        expect(formatted).toContain("[1]");
      }),
    );

    it.effect("formats reverse edge with arrow and cardinality", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        const edges = graph.getEdges("Post");
        const commentEdge = edges.find(e => e.targetEntity === "Comment" && e.direction === "reverse")!;

        const formatted = formatEdge(commentEdge);
        expect(formatted).toContain("<-");
        expect(formatted).toContain("Comment");
        expect(formatted).toContain("[*]");
      }),
    );
  });

  describe("formatEdgeDetail", () => {
    it.effect("includes constraint name and columns", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = createJoinGraph(ir);

        const edges = graph.getEdges("Post");
        const userEdge = edges.find(e => e.targetEntity === "User")!;

        const detail = formatEdgeDetail(userEdge);
        expect(detail).toContain("via");
        expect(detail).toContain("fkey");
        expect(detail).toContain("user_id");
        expect(detail).toContain("id");
      }),
    );
  });
});

describe("Query Generation Integration", () => {
  it.effect("generates complete SELECT query with joins and filters", () =>
    Effect.gen(function* () {
      const ir = yield* buildTestIR;
      const graph = createJoinGraph(ir);

      const foundPath = graph.findPath("Post", "User")!;

      const fromJoin = graph.toJoinClause(foundPath);
      const selectedColumns = ["post.id", "post.body", "user.username"];
      const filters = [{ column: "post.user_id", op: "=", param: "$1" }];

      const sql = [
        `SELECT ${selectedColumns.join(", ")}`,
        fromJoin,
        `WHERE ${filters.map(f => `${f.column} ${f.op} ${f.param}`).join(" AND ")}`,
      ].join("\n");

      expect(sql).toContain("SELECT post.id, post.body, user.username");
      expect(sql).toContain("FROM posts AS");
      expect(sql).toContain("JOIN users AS");
      expect(sql).toContain("WHERE post.user_id = $1");
    }),
  );

  it.effect("generates query with multiple joins", () =>
    Effect.gen(function* () {
      const ir = yield* buildTestIR;
      const graph = createJoinGraph(ir);

      const postToUser = graph.findPath("Post", "User")!;
      const commentEdge = graph.getEdges("Post").find(e => e.targetEntity === "Comment")!;

      const multiPath = {
        from: "Post",
        edges: [...postToUser.edges, commentEdge],
        aliases: ["p", "u", "c"],
      };

      const sql = graph.toJoinClause(multiPath);

      expect(sql).toContain("FROM posts AS p");
      expect(sql).toContain("JOIN users AS u");
      expect(sql).toContain("LEFT JOIN comments AS c");
    }),
  );

  it.effect("indexes inform efficient filter selection", () =>
    Effect.gen(function* () {
      const ir = yield* buildTestIR;
      const graph = createJoinGraph(ir);

      const postIndexes = graph.getFilterableIndexes("Post");
      const userIndexes = graph.getFilterableIndexes("User");

      const efficientPostFilters = postIndexes.map(i => i.columns[0]);
      const efficientUserFilters = userIndexes.map(i => i.columns[0]);

      expect(efficientPostFilters).toContain("id");
      expect(efficientPostFilters).toContain("user_id");
      expect(efficientPostFilters).toContain("created_at");

      expect(efficientUserFilters).toContain("id");
      expect(efficientUserFilters).toContain("username");
    }),
  );
});

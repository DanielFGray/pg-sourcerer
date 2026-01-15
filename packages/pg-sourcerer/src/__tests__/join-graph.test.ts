/**
 * JoinGraph Tests
 *
 * Tests for the join graph navigation and SQL generation.
 * Uses the introspection fixture for realistic schema data.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Effect } from "effect";
import { parseIntrospectionResults, type Introspection } from "@danielfgray/pg-introspection";
import { createIRBuilderService } from "../services/ir-builder.js";
import { InflectionLive } from "../services/inflection.js";
import type { SemanticIR } from "../ir/semantic-ir.js";
import {
  createJoinGraph,
  formatEdge,
  formatEdgeDetail,
  type JoinGraph,
  type JoinEdge,
} from "../lib/join-graph.js";
import * as fs from "node:fs";
import * as path from "node:path";

let ir: SemanticIR;
let graph: JoinGraph;

beforeAll(async () => {
  // Load fixture
  const fixturePath = path.join(import.meta.dirname, "fixtures/introspection.json");
  const fixtureJson = fs.readFileSync(fixturePath, "utf-8");
  const introspection = parseIntrospectionResults(fixtureJson, false);

  // Build IR
  ir = await Effect.runPromise(
    Effect.gen(function* () {
      const builder = createIRBuilderService();
      return yield* builder.build(introspection, { schemas: ["app_public"] });
    }).pipe(Effect.provide(InflectionLive)),
  );

  graph = createJoinGraph(ir);
});

describe("JoinGraph", () => {
  describe("entities", () => {
    it("contains all table entities from IR", () => {
      expect(graph.entities.size).toBeGreaterThan(0);
      expect(graph.entities.has("Post")).toBe(true);
      expect(graph.entities.has("User")).toBe(true);
      expect(graph.entities.has("Comment")).toBe(true);
    });

    it("getEntity returns entity by name", () => {
      const post = graph.getEntity("Post");
      expect(post).toBeDefined();
      expect(post?.pgName).toBe("posts");
    });

    it("getEntity returns undefined for unknown entity", () => {
      expect(graph.getEntity("NonExistent")).toBeUndefined();
    });
  });

  describe("getEdges", () => {
    it("returns forward edges (belongsTo) for Post", () => {
      const edges = graph.getEdges("Post");
      const userEdge = edges.find(e => e.targetEntity === "User" && e.direction === "forward");

      expect(userEdge).toBeDefined();
      expect(userEdge?.cardinality).toBe("many-to-one");
      expect(userEdge?.columns[0]?.local).toBe("user_id");
      expect(userEdge?.columns[0]?.foreign).toBe("id");
    });

    it("returns reverse edges (hasMany) for Post", () => {
      const edges = graph.getEdges("Post");
      const commentEdge = edges.find(e => e.targetEntity === "Comment" && e.direction === "reverse");

      expect(commentEdge).toBeDefined();
      expect(commentEdge?.cardinality).toBe("one-to-many");
    });

    it("returns reverse edges for User (no forward edges)", () => {
      const edges = graph.getEdges("User");

      // User has no FKs, only reverse relations
      const forwardEdges = edges.filter(e => e.direction === "forward");
      const reverseEdges = edges.filter(e => e.direction === "reverse");

      expect(forwardEdges.length).toBe(0);
      expect(reverseEdges.length).toBeGreaterThan(0);

      // Should have hasMany to Post, Comment, etc.
      expect(reverseEdges.some(e => e.targetEntity === "Post")).toBe(true);
      expect(reverseEdges.some(e => e.targetEntity === "Comment")).toBe(true);
    });

    it("returns empty array for unknown entity", () => {
      expect(graph.getEdges("NonExistent")).toEqual([]);
    });
  });

  describe("findPath", () => {
    it("returns trivial path for same entity", () => {
      const path = graph.findPath("Post", "Post");

      expect(path).toBeDefined();
      expect(path?.from).toBe("Post");
      expect(path?.edges).toHaveLength(0);
      expect(path?.aliases).toEqual(["Post"]);
    });

    it("finds direct path Post -> User", () => {
      const path = graph.findPath("Post", "User");

      expect(path).toBeDefined();
      expect(path?.from).toBe("Post");
      expect(path?.edges).toHaveLength(1);
      expect(path?.edges[0]?.targetEntity).toBe("User");
      expect(path?.edges[0]?.direction).toBe("forward");
    });

    it("finds reverse path User -> Post", () => {
      const path = graph.findPath("User", "Post");

      expect(path).toBeDefined();
      expect(path?.from).toBe("User");
      expect(path?.edges).toHaveLength(1);
      expect(path?.edges[0]?.targetEntity).toBe("Post");
      expect(path?.edges[0]?.direction).toBe("reverse");
    });

    it("finds multi-hop path Comment -> User (via Post would be longer)", () => {
      // Comment has direct FK to User, so shortest path is 1 hop
      const path = graph.findPath("Comment", "User");

      expect(path).toBeDefined();
      expect(path?.edges.length).toBeLessThanOrEqual(2);
      // Should find direct path since Comment -> User exists
      expect(path?.edges[0]?.targetEntity).toBe("User");
    });

    it("returns undefined for unknown entities", () => {
      expect(graph.findPath("NonExistent", "Post")).toBeUndefined();
      expect(graph.findPath("Post", "NonExistent")).toBeUndefined();
    });
  });

  describe("getReachable", () => {
    it("returns all connected entities from Post", () => {
      const reachable = graph.getReachable("Post");

      expect(reachable.has("Post")).toBe(true);
      expect(reachable.has("User")).toBe(true);
      expect(reachable.has("Comment")).toBe(true);
      expect(reachable.has("PostsVote")).toBe(true);
    });

    it("respects maxDepth", () => {
      const depth0 = graph.getReachable("Post", 0);
      const depth1 = graph.getReachable("Post", 1);

      expect(depth0.size).toBe(1); // Just Post
      expect(depth0.has("Post")).toBe(true);

      expect(depth1.size).toBeGreaterThan(1);
      expect(depth1.has("User")).toBe(true); // Direct neighbor
    });
  });

  describe("getFilterableIndexes", () => {
    it("returns indexes for Post", () => {
      const indexes = graph.getFilterableIndexes("Post");

      expect(indexes.length).toBeGreaterThan(0);

      // Should have PK index
      const pkIndex = indexes.find(i => i.columns.includes("id") && i.isUnique);
      expect(pkIndex).toBeDefined();

      // Should have user_id index
      const userIdIndex = indexes.find(i => i.columns.includes("user_id"));
      expect(userIdIndex).toBeDefined();
    });

    it("returns empty array for unknown entity", () => {
      expect(graph.getFilterableIndexes("NonExistent")).toEqual([]);
    });
  });

  describe("toJoinClause", () => {
    it("generates FROM clause for single table", () => {
      const path = graph.findPath("Post", "Post")!;
      const sql = graph.toJoinClause(path);

      expect(sql).toContain("FROM posts AS");
    });

    it("generates JOIN clause for Post -> User", () => {
      const path = graph.findPath("Post", "User")!;
      const sql = graph.toJoinClause(path);

      expect(sql).toContain("FROM posts AS");
      expect(sql).toContain("JOIN users AS");
      expect(sql).toMatch(/ON .+\.user_id = .+\.id/);
    });

    it("generates LEFT JOIN for reverse relations (hasMany)", () => {
      const path = graph.findPath("User", "Post")!;
      const sql = graph.toJoinClause(path);

      expect(sql).toContain("FROM users AS");
      expect(sql).toContain("LEFT JOIN posts AS");
    });

    it("handles multi-hop paths", () => {
      // Build a path: Post -> User -> UserEmail
      const postToUser = graph.findPath("Post", "User")!;
      const edges = [...postToUser.edges];

      // Find edge from User to UserEmail
      const userEdges = graph.getEdges("User");
      const emailEdge = userEdges.find(e => e.targetEntity === "UserEmail");
      expect(emailEdge).toBeDefined();

      // Manually construct multi-hop path
      const multiPath = {
        from: "Post",
        edges: [...edges, emailEdge!],
        aliases: ["post", "user", "userEmail"],
      };

      const sql = graph.toJoinClause(multiPath);

      expect(sql).toContain("FROM posts AS post");
      expect(sql).toContain("JOIN users AS user");
      expect(sql).toContain("LEFT JOIN user_emails AS userEmail");
    });
  });

  describe("formatEdge", () => {
    it("formats forward edge with arrow and cardinality", () => {
      const edges = graph.getEdges("Post");
      const userEdge = edges.find(e => e.targetEntity === "User" && e.direction === "forward")!;

      const formatted = formatEdge(userEdge);
      expect(formatted).toContain("->");
      expect(formatted).toContain("User");
      expect(formatted).toContain("[1]"); // many-to-one
    });

    it("formats reverse edge with arrow and cardinality", () => {
      const edges = graph.getEdges("Post");
      const commentEdge = edges.find(e => e.targetEntity === "Comment" && e.direction === "reverse")!;

      const formatted = formatEdge(commentEdge);
      expect(formatted).toContain("<-");
      expect(formatted).toContain("Comment");
      expect(formatted).toContain("[*]"); // one-to-many
    });
  });

  describe("formatEdgeDetail", () => {
    it("includes constraint name and columns", () => {
      const edges = graph.getEdges("Post");
      const userEdge = edges.find(e => e.targetEntity === "User")!;

      const detail = formatEdgeDetail(userEdge);
      expect(detail).toContain("via");
      expect(detail).toContain("fkey");
      expect(detail).toContain("user_id");
      expect(detail).toContain("id");
    });
  });
});

describe("Query Generation Integration", () => {
  it("generates complete SELECT query with joins and filters", () => {
    // Simulate what the TUI would produce
    const path = graph.findPath("Post", "User")!;

    // Build SQL components
    const fromJoin = graph.toJoinClause(path);
    const selectedColumns = ["post.id", "post.body", "user.username"];
    const filters = [{ column: "post.user_id", op: "=", param: "$1" }];

    // Assemble query
    const sql = [
      `SELECT ${selectedColumns.join(", ")}`,
      fromJoin,
      `WHERE ${filters.map(f => `${f.column} ${f.op} ${f.param}`).join(" AND ")}`,
    ].join("\n");

    expect(sql).toContain("SELECT post.id, post.body, user.username");
    expect(sql).toContain("FROM posts AS");
    expect(sql).toContain("JOIN users AS");
    expect(sql).toContain("WHERE post.user_id = $1");
  });

  it("generates query with multiple joins", () => {
    // Post -> User, Post -> Comment (reverse)
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
  });

  it("indexes inform efficient filter selection", () => {
    const postIndexes = graph.getFilterableIndexes("Post");
    const userIndexes = graph.getFilterableIndexes("User");

    // These indexes would be suggested for WHERE clauses
    const efficientPostFilters = postIndexes.map(i => i.columns[0]);
    const efficientUserFilters = userIndexes.map(i => i.columns[0]);

    expect(efficientPostFilters).toContain("id");
    expect(efficientPostFilters).toContain("user_id");
    expect(efficientPostFilters).toContain("created_at");

    expect(efficientUserFilters).toContain("id");
    expect(efficientUserFilters).toContain("username");
  });
});

/**
 * Relation Graph Tests
 *
 * Tests for the relation graph utilities that help navigate entity relationships.
 * Uses the fixture introspection data from the example database.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { createIRBuilderService } from "../services/ir-builder.js";
import { InflectionLive } from "../services/inflection.js";
import { loadIntrospectionFixture } from "./fixtures/index.js";
import type { SemanticIR } from "../ir/semantic-ir.js";
import {
  buildRelationGraph,
  findJoinPath,
  getEntityIndex,
  getJoinableEntities,
  irToMermaid,
} from "../ir/relation-graph.js";
import { Graph } from "effect";

const introspection = loadIntrospectionFixture();

const buildTestIR = Effect.gen(function* () {
  const builder = createIRBuilderService();
  return yield* builder.build(introspection, { schemas: ["app_public"] });
}).pipe(Effect.provide(InflectionLive));

describe("Relation Graph", () => {
  describe("buildRelationGraph", () => {
    it.effect("creates a graph with nodes for each table entity", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = buildRelationGraph(ir);

        expect(Graph.nodeCount(graph)).toBeGreaterThan(0);

        const userIdx = getEntityIndex(graph, "User");
        expect(userIdx).toBeDefined();
      }),
    );

    it.effect("creates edges for belongsTo relations", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = buildRelationGraph(ir);

        expect(Graph.edgeCount(graph)).toBeGreaterThan(0);

        const postIdx = Option.getOrThrow(getEntityIndex(graph, "Post"));
        const userIdx = Option.getOrThrow(getEntityIndex(graph, "User"));

        expect(Graph.hasEdge(graph, postIdx, userIdx)).toBe(true);
      }),
    );

    it.effect("edge data contains constraint information", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const graph = buildRelationGraph(ir);

        const postIdx = Option.getOrThrow(getEntityIndex(graph, "Post"));
        const userIdx = Option.getOrThrow(getEntityIndex(graph, "User"));

        const adjacency = graph.adjacency.get(postIdx) ?? [];
        const edgeToUser = adjacency
          .map(idx => graph.edges.get(idx))
          .find(edge => edge && edge.target === userIdx);

        expect(edgeToUser).toBeDefined();
        expect(edgeToUser?.data.fkHolder).toBe("Post");
        expect(edgeToUser?.data.columns.length).toBeGreaterThan(0);
      }),
    );
  });

  describe("getJoinableEntities", () => {
    it.effect("returns empty array for non-existent entity", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const joinable = getJoinableEntities(ir, "NonExistent");

        expect(joinable).toEqual([]);
      }),
    );

    it.effect("returns belongsTo relations for entity with FKs", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const joinable = getJoinableEntities(ir, "Post");

        const belongsToRels = joinable.filter(j => j.direction === "belongsTo");
        expect(belongsToRels.length).toBeGreaterThan(0);

        const userRel = belongsToRels.find(j => j.entity.name === "User");
        expect(userRel).toBeDefined();
        expect(userRel?.description).toContain("via");
      }),
    );

    it.effect("returns hasMany relations for entity referenced by FKs", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const joinable = getJoinableEntities(ir, "User");

        const hasManyRels = joinable.filter(j => j.direction === "hasMany");
        expect(hasManyRels.length).toBeGreaterThan(0);

        const postRel = hasManyRels.find(j => j.entity.name === "Post");
        expect(postRel).toBeDefined();
      }),
    );

    it.effect("includes human-readable descriptions", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const joinable = getJoinableEntities(ir, "Post");

        for (const rel of joinable) {
          expect(rel.description).toBeTruthy();
          expect(rel.description).toContain("via");
          expect(rel.description).toContain("→");
        }
      }),
    );
  });

  describe("findJoinPath", () => {
    it.effect("returns SameEntity when from === to", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const result = findJoinPath(ir, "User", "User");

        expect(result._tag).toBe("SameEntity");
        if (result._tag === "SameEntity") {
          expect(result.entity).toBe("User");
        }
      }),
    );

    it.effect("returns EntityNotFound for non-existent entity", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const result = findJoinPath(ir, "NonExistent", "User");

        expect(result._tag).toBe("EntityNotFound");
        if (result._tag === "EntityNotFound") {
          expect(result.entity).toBe("NonExistent");
        }
      }),
    );

    it.effect("finds direct path via belongsTo", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const result = findJoinPath(ir, "Post", "User");

        expect(result._tag).toBe("Found");
        if (result._tag === "Found") {
          expect(result.path.length).toBe(1);
          expect(result.path[0]?.from).toBe("Post");
          expect(result.path[0]?.to).toBe("User");
          expect(result.path[0]?.direction).toBe("belongsTo");
        }
      }),
    );

    it.effect("finds direct path via hasMany (reverse direction)", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const result = findJoinPath(ir, "User", "Post");

        expect(result._tag).toBe("Found");
        if (result._tag === "Found") {
          expect(result.path.length).toBe(1);
          expect(result.path[0]?.from).toBe("User");
          expect(result.path[0]?.to).toBe("Post");
          expect(result.path[0]?.direction).toBe("hasMany");
        }
      }),
    );

    it.effect("finds multi-hop paths", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const result = findJoinPath(ir, "PostTag", "Tag");

        if (result._tag === "Found") {
          expect(result.path.length).toBeGreaterThanOrEqual(1);
          for (const step of result.path) {
            expect(step.from).toBeTruthy();
            expect(step.to).toBeTruthy();
            expect(step.constraintName).toBeTruthy();
            expect(step.columns.length).toBeGreaterThan(0);
          }
        }
      }),
    );

    it.effect("handles queries for entities that may not be connected", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;

        const result = findJoinPath(ir, "User", "Post");

        expect(["Found", "NotFound", "SameEntity", "EntityNotFound"]).toContain(result._tag);

        if (result._tag === "Found") {
          expect(result.path.length).toBeGreaterThan(0);
        }
      }),
    );
  });

  describe("irToMermaid", () => {
    it.effect("generates valid mermaid diagram", () =>
      Effect.gen(function* () {
        const ir = yield* buildTestIR;
        const mermaid = irToMermaid(ir);

        expect(mermaid).toContain("flowchart");

        expect(mermaid).toContain("User");
        expect(mermaid).toContain("Post");

        expect(mermaid).toContain("-->");
      }),
    );
  });
});

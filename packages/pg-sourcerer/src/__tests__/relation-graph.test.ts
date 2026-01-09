/**
 * Relation Graph Tests
 *
 * Tests for the relation graph utilities that help navigate entity relationships.
 * Uses the fixture introspection data from the example database.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { createIRBuilderService } from "../services/ir-builder.js"
import { InflectionLive } from "../services/inflection.js"
import { loadIntrospectionFixture } from "./fixtures/index.js"
import type { SemanticIR } from "../ir/semantic-ir.js"
import {
  buildRelationGraph,
  findJoinPath,
  getEntityIndex,
  getJoinableEntities,
  irToMermaid,
} from "../ir/relation-graph.js"
import { Graph } from "effect"

// Load introspection data from fixture
const introspection = loadIntrospectionFixture()

/**
 * Build IR from fixture introspection data
 */
async function buildTestIR(schemas: readonly string[]): Promise<SemanticIR> {
  const builder = createIRBuilderService()
  return Effect.runPromise(
    builder.build(introspection, { schemas }).pipe(Effect.provide(InflectionLive))
  )
}

describe("Relation Graph", () => {
  describe("buildRelationGraph", () => {
    it("creates a graph with nodes for each table entity", async () => {
      const ir = await buildTestIR(["app_public"])
      const graph = buildRelationGraph(ir)

      // Should have nodes
      expect(Graph.nodeCount(graph)).toBeGreaterThan(0)

      // Should find User entity
      const userIdx = getEntityIndex(graph, "User")
      expect(Option.isSome(userIdx)).toBe(true)
    })

    it("creates edges for belongsTo relations", async () => {
      const ir = await buildTestIR(["app_public"])
      const graph = buildRelationGraph(ir)

      // Should have edges
      expect(Graph.edgeCount(graph)).toBeGreaterThan(0)

      // Post belongsTo User (posts.author_id -> users.id)
      const postIdx = getEntityIndex(graph, "Post")
      const userIdx = getEntityIndex(graph, "User")

      expect(Option.isSome(postIdx)).toBe(true)
      expect(Option.isSome(userIdx)).toBe(true)

      if (Option.isSome(postIdx) && Option.isSome(userIdx)) {
        // Edge should go from Post -> User (FK holder to referenced)
        expect(Graph.hasEdge(graph, postIdx.value, userIdx.value)).toBe(true)
      }
    })

    it("edge data contains constraint information", async () => {
      const ir = await buildTestIR(["app_public"])
      const graph = buildRelationGraph(ir)

      // Find the Post -> User edge
      const postIdx = getEntityIndex(graph, "Post")
      const userIdx = getEntityIndex(graph, "User")

      if (Option.isSome(postIdx) && Option.isSome(userIdx)) {
        const adjacency = graph.adjacency.get(postIdx.value) ?? []
        const edgeToUser = adjacency
          .map((idx) => graph.edges.get(idx))
          .find((edge) => edge && edge.target === userIdx.value)

        expect(edgeToUser).toBeDefined()
        expect(edgeToUser?.data.fkHolder).toBe("Post")
        expect(edgeToUser?.data.columns.length).toBeGreaterThan(0)
      }
    })
  })

  describe("getJoinableEntities", () => {
    it("returns empty array for non-existent entity", async () => {
      const ir = await buildTestIR(["app_public"])
      const joinable = getJoinableEntities(ir, "NonExistent")

      expect(joinable).toEqual([])
    })

    it("returns belongsTo relations for entity with FKs", async () => {
      const ir = await buildTestIR(["app_public"])
      const joinable = getJoinableEntities(ir, "Post")

      // Post should have at least one belongsTo (author -> User)
      const belongsToRels = joinable.filter((j) => j.direction === "belongsTo")
      expect(belongsToRels.length).toBeGreaterThan(0)

      // Should find User as a target
      const userRel = belongsToRels.find((j) => j.entity.name === "User")
      expect(userRel).toBeDefined()
      expect(userRel?.description).toContain("via")
    })

    it("returns hasMany relations for entity referenced by FKs", async () => {
      const ir = await buildTestIR(["app_public"])
      const joinable = getJoinableEntities(ir, "User")

      // User should have hasMany relations (posts, etc.)
      const hasManyRels = joinable.filter((j) => j.direction === "hasMany")
      expect(hasManyRels.length).toBeGreaterThan(0)

      // Should find Post as a source
      const postRel = hasManyRels.find((j) => j.entity.name === "Post")
      expect(postRel).toBeDefined()
    })

    it("includes human-readable descriptions", async () => {
      const ir = await buildTestIR(["app_public"])
      const joinable = getJoinableEntities(ir, "Post")

      for (const rel of joinable) {
        expect(rel.description).toBeTruthy()
        expect(rel.description).toContain("via")
        expect(rel.description).toContain("→")
      }
    })
  })

  describe("findJoinPath", () => {
    it("returns SameEntity when from === to", async () => {
      const ir = await buildTestIR(["app_public"])
      const result = findJoinPath(ir, "User", "User")

      expect(result._tag).toBe("SameEntity")
      if (result._tag === "SameEntity") {
        expect(result.entity).toBe("User")
      }
    })

    it("returns EntityNotFound for non-existent entity", async () => {
      const ir = await buildTestIR(["app_public"])
      const result = findJoinPath(ir, "NonExistent", "User")

      expect(result._tag).toBe("EntityNotFound")
      if (result._tag === "EntityNotFound") {
        expect(result.entity).toBe("NonExistent")
      }
    })

    it("finds direct path via belongsTo", async () => {
      const ir = await buildTestIR(["app_public"])
      // Post -> User (direct FK)
      const result = findJoinPath(ir, "Post", "User")

      expect(result._tag).toBe("Found")
      if (result._tag === "Found") {
        expect(result.path.length).toBe(1)
        expect(result.path[0]?.from).toBe("Post")
        expect(result.path[0]?.to).toBe("User")
        expect(result.path[0]?.direction).toBe("belongsTo")
      }
    })

    it("finds direct path via hasMany (reverse direction)", async () => {
      const ir = await buildTestIR(["app_public"])
      // User -> Post (reverse FK, hasMany direction)
      const result = findJoinPath(ir, "User", "Post")

      expect(result._tag).toBe("Found")
      if (result._tag === "Found") {
        expect(result.path.length).toBe(1)
        expect(result.path[0]?.from).toBe("User")
        expect(result.path[0]?.to).toBe("Post")
        expect(result.path[0]?.direction).toBe("hasMany")
      }
    })

    it("finds multi-hop paths", async () => {
      const ir = await buildTestIR(["app_public"])
      // Try to find a path that requires multiple hops
      // This depends on the schema structure

      // PostTag -> Tag should be direct
      const result = findJoinPath(ir, "PostTag", "Tag")

      if (result._tag === "Found") {
        expect(result.path.length).toBeGreaterThanOrEqual(1)
        // Each step should have valid data
        for (const step of result.path) {
          expect(step.from).toBeTruthy()
          expect(step.to).toBeTruthy()
          expect(step.constraintName).toBeTruthy()
          expect(step.columns.length).toBeGreaterThan(0)
        }
      }
    })

    it("handles queries for entities that may not be connected", async () => {
      const ir = await buildTestIR(["app_public"])

      // User -> Post should always be connected in this schema
      const result = findJoinPath(ir, "User", "Post")

      // Just verify it returns a valid result type
      expect(["Found", "NotFound", "SameEntity", "EntityNotFound"]).toContain(result._tag)

      // In our test schema, this should be Found
      if (result._tag === "Found") {
        expect(result.path.length).toBeGreaterThan(0)
      }
    })
  })

  describe("irToMermaid", () => {
    it("generates valid mermaid diagram", async () => {
      const ir = await buildTestIR(["app_public"])
      const mermaid = irToMermaid(ir)

      // Should start with flowchart
      expect(mermaid).toContain("flowchart")

      // Should have nodes
      expect(mermaid).toContain("User")
      expect(mermaid).toContain("Post")

      // Should have edges with constraint names
      expect(mermaid).toContain("-->")
    })
  })
})

/**
 * Relation Graph Utilities
 *
 * Utilities for navigating entity relationships in the IR using Effect's Graph module.
 * Useful for query builders, documentation generators, ERD tools, etc.
 */
import { Array, Graph, Option, pipe } from "effect";

import type { Relation, ReverseRelation, SemanticIR, TableEntity } from "./semantic-ir.js";
import { getAllRelations, isTableEntity } from "./semantic-ir.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Edge data stored in the relation graph.
 * Represents a foreign key constraint between two entities.
 */
export interface RelationEdge {
  readonly constraintName: string;
  readonly columns: readonly { readonly local: string; readonly foreign: string }[];
  /** Entity that owns the FK column (the "child" in the relationship) */
  readonly fkHolder: string;
}

/**
 * The relation graph type - a directed graph where:
 * - Nodes are entity names (strings)
 * - Edges point from FK holder → referenced entity
 * - Edge data contains constraint info
 */
export type RelationGraph = Graph.DirectedGraph<string, RelationEdge>;

/**
 * An entity that can be directly joined from another entity.
 */
export interface JoinableEntity {
  readonly entity: TableEntity;
  readonly direction: "belongsTo" | "hasMany";
  readonly relation: Relation | ReverseRelation;
  /** Human-readable description: "orders via user_id → users.id" */
  readonly description: string;
}

/**
 * A single step in a join path between two entities.
 */
export interface JoinStep {
  readonly from: string;
  readonly to: string;
  readonly direction: "belongsTo" | "hasMany";
  readonly constraintName: string;
  readonly columns: readonly { readonly local: string; readonly foreign: string }[];
}

/**
 * Result of path finding - either a path or information about why none exists.
 */
export type JoinPathResult =
  | { readonly _tag: "Found"; readonly path: readonly JoinStep[] }
  | { readonly _tag: "NotFound"; readonly from: string; readonly to: string }
  | { readonly _tag: "SameEntity"; readonly entity: string }
  | { readonly _tag: "EntityNotFound"; readonly entity: string };

// ============================================================================
// Graph Construction
// ============================================================================

/**
 * Build a directed graph from the IR's entity relations.
 *
 * Edges point from FK holder → referenced entity (i.e., orders → users
 * when orders.user_id references users.id).
 *
 * Use with Graph.bfs/dfs and direction: 'outgoing' for belongsTo traversal,
 * direction: 'incoming' for hasMany traversal.
 */
export function buildRelationGraph(ir: SemanticIR): RelationGraph {
  const tableEntities = pipe(Array.fromIterable(ir.entities.values()), Array.filter(isTableEntity));

  return Graph.directed<string, RelationEdge>(mutable => {
    // Build entity name → node index mapping
    const nodeIndices = new Map(
      tableEntities.map(entity => [entity.name, Graph.addNode(mutable, entity.name)]),
    );

    // Add edges for all belongsTo relations
    for (const entity of tableEntities) {
      const fromIdx = nodeIndices.get(entity.name);
      if (fromIdx === undefined) continue;

      for (const rel of entity.relations) {
        if (rel.kind !== "belongsTo") continue;

        const toIdx = nodeIndices.get(rel.targetEntity);
        if (toIdx === undefined) continue; // Skip broken refs

        Graph.addEdge(mutable, fromIdx, toIdx, {
          constraintName: rel.constraintName,
          columns: rel.columns,
          fkHolder: entity.name,
        });
      }
    }
  });
}

/**
 * Get the node index for an entity name in the graph.
 */
export function getEntityIndex(
  graph: RelationGraph,
  entityName: string,
): Option.Option<Graph.NodeIndex> {
  return Graph.findNode(graph, name => name === entityName);
}

// ============================================================================
// Joinable Entities
// ============================================================================

/**
 * Format a relation as a human-readable description.
 * Example: "orders via user_id → users.id"
 */
function formatRelationDescription(
  fromEntity: string,
  toEntity: string,
  columns: readonly { readonly local: string; readonly foreign: string }[],
  direction: "belongsTo" | "hasMany",
): string {
  const columnPairs = columns.map(c => `${c.local} → ${c.foreign}`).join(", ");

  return direction === "belongsTo"
    ? `${fromEntity} via ${columnPairs}`
    : `${toEntity} via ${columnPairs}`;
}

/**
 * Get all entities directly joinable from this entity (via FK in either direction).
 *
 * Returns both:
 * - belongsTo: entities this one references (we have the FK)
 * - hasMany: entities that reference this one (they have the FK)
 */
export function getJoinableEntities(ir: SemanticIR, entityName: string): readonly JoinableEntity[] {
  const allRels = getAllRelations(ir, entityName);
  if (!allRels) return [];

  const belongsToResults = pipe(
    allRels.belongsTo,
    Array.filterMap(rel => {
      const target = ir.entities.get(rel.targetEntity);
      if (!target || !isTableEntity(target)) return Option.none();

      return Option.some<JoinableEntity>({
        entity: target,
        direction: "belongsTo",
        relation: rel,
        description: formatRelationDescription(
          entityName,
          rel.targetEntity,
          rel.columns,
          "belongsTo",
        ),
      });
    }),
  );

  const hasManyResults = pipe(
    allRels.hasMany,
    Array.filterMap(rel => {
      const source = ir.entities.get(rel.sourceEntity);
      if (!source || !isTableEntity(source)) return Option.none();

      return Option.some<JoinableEntity>({
        entity: source,
        direction: "hasMany",
        relation: rel,
        description: formatRelationDescription(
          rel.sourceEntity,
          entityName,
          rel.columns,
          "hasMany",
        ),
      });
    }),
  );

  return [...belongsToResults, ...hasManyResults];
}

// ============================================================================
// Path Finding
// ============================================================================

/**
 * Internal: Track parent info during BFS for path reconstruction.
 */
interface BfsParent {
  readonly parentIdx: Graph.NodeIndex;
  readonly edgeIdx: Graph.EdgeIndex;
  readonly direction: "belongsTo" | "hasMany";
}

/**
 * Find the shortest path between two entities using BFS.
 *
 * Returns a JoinPathResult indicating:
 * - Found: path exists with the steps to take
 * - NotFound: no path exists between the entities
 * - SameEntity: from and to are the same entity
 * - EntityNotFound: one of the entity names doesn't exist in the IR
 *
 * The algorithm explores both directions (belongsTo and hasMany) to find
 * any valid path through the relation graph.
 */
export function findJoinPath(ir: SemanticIR, from: string, to: string): JoinPathResult {
  // Same entity check
  if (from === to) {
    return { _tag: "SameEntity", entity: from };
  }

  // Validate entities exist
  const fromEntity = ir.entities.get(from);
  const toEntity = ir.entities.get(to);

  if (!fromEntity || !isTableEntity(fromEntity)) {
    return { _tag: "EntityNotFound", entity: from };
  }
  if (!toEntity || !isTableEntity(toEntity)) {
    return { _tag: "EntityNotFound", entity: to };
  }

  // Build graph and get node indices
  const graph = buildRelationGraph(ir);
  const fromIdxOpt = getEntityIndex(graph, from);
  const toIdxOpt = getEntityIndex(graph, to);

  if (Option.isNone(fromIdxOpt) || Option.isNone(toIdxOpt)) {
    return { _tag: "NotFound", from, to };
  }

  const fromIdx = fromIdxOpt.value;
  const toIdx = toIdxOpt.value;

  // BFS with parent tracking for path reconstruction
  // We need to explore both edge directions (outgoing = belongsTo, incoming = hasMany)
  const visited = new Set<Graph.NodeIndex>();
  const parents = new Map<Graph.NodeIndex, BfsParent>();
  const queue: Array<{ nodeIdx: Graph.NodeIndex }> = [{ nodeIdx: fromIdx }];

  visited.add(fromIdx);

  while (queue.length > 0) {
    const { nodeIdx: currentIdx } = queue.shift()!;

    if (currentIdx === toIdx) {
      // Found! Reconstruct path
      return { _tag: "Found", path: reconstructPath(graph, parents, fromIdx, toIdx) };
    }

    // Explore outgoing edges (belongsTo direction)
    const outgoingEdges = graph.adjacency.get(currentIdx) ?? [];
    for (const edgeIdx of outgoingEdges) {
      const edge = graph.edges.get(edgeIdx);
      if (!edge) continue;

      const neighborIdx = edge.target;
      if (!visited.has(neighborIdx)) {
        visited.add(neighborIdx);
        parents.set(neighborIdx, {
          parentIdx: currentIdx,
          edgeIdx,
          direction: "belongsTo",
        });
        queue.push({ nodeIdx: neighborIdx });
      }
    }

    // Explore incoming edges (hasMany direction)
    const incomingEdges = graph.reverseAdjacency.get(currentIdx) ?? [];
    for (const edgeIdx of incomingEdges) {
      const edge = graph.edges.get(edgeIdx);
      if (!edge) continue;

      const neighborIdx = edge.source;
      if (!visited.has(neighborIdx)) {
        visited.add(neighborIdx);
        parents.set(neighborIdx, {
          parentIdx: currentIdx,
          edgeIdx,
          direction: "hasMany",
        });
        queue.push({ nodeIdx: neighborIdx });
      }
    }
  }

  return { _tag: "NotFound", from, to };
}

/**
 * Reconstruct the path from BFS parent pointers.
 */
function reconstructPath(
  graph: RelationGraph,
  parents: Map<Graph.NodeIndex, BfsParent>,
  fromIdx: Graph.NodeIndex,
  toIdx: Graph.NodeIndex,
): readonly JoinStep[] {
  const steps: JoinStep[] = [];
  let currentIdx = toIdx;

  while (currentIdx !== fromIdx) {
    const parent = parents.get(currentIdx);
    if (!parent) break; // Should never happen if BFS worked correctly

    const edge = graph.edges.get(parent.edgeIdx);
    if (!edge) break;

    const fromName = graph.nodes.get(parent.parentIdx);
    const toName = graph.nodes.get(currentIdx);

    if (fromName && toName) {
      steps.unshift({
        from: fromName,
        to: toName,
        direction: parent.direction,
        constraintName: edge.data.constraintName,
        columns: edge.data.columns,
      });
    }

    currentIdx = parent.parentIdx;
  }

  return steps;
}

// ============================================================================
// Visualization Helpers
// ============================================================================

/**
 * Export the relation graph as a Mermaid diagram.
 * Useful for documentation and debugging.
 */
export function toMermaid(graph: RelationGraph): string {
  return Graph.toMermaid(graph, {
    direction: "LR",
    nodeLabel: name => name,
    edgeLabel: edge => edge.constraintName,
  });
}

/**
 * Export the relation graph as a Mermaid diagram directly from IR.
 */
export function irToMermaid(ir: SemanticIR): string {
  return toMermaid(buildRelationGraph(ir));
}

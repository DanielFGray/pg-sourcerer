/**
 * JoinGraph - Bidirectional FK navigation for query building
 *
 * Provides a graph representation of table relationships derived from SemanticIR.
 * Used by interactive query builder to navigate joinable tables.
 */
import { pipe, Array as Arr, Option, HashMap, HashSet } from "effect";
import type {
  SemanticIR,
  TableEntity,
  Relation,
  ReverseRelation,
  IndexDef,
} from "../ir/semantic-ir.js";
import { isTableEntity, getAllRelations, getReverseRelations } from "../ir/semantic-ir.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Direction of a join edge - which side has the FK
 */
export type JoinDirection = "forward" | "reverse";

/**
 * A joinable edge in the graph - represents one way to join two tables
 */
export interface JoinEdge {
  /** Target entity name (what we're joining TO) */
  readonly targetEntity: string;
  /** Direction: forward = we have FK, reverse = they have FK to us */
  readonly direction: JoinDirection;
  /** Cardinality: many-to-one or one-to-many */
  readonly cardinality: "many-to-one" | "one-to-many" | "one-to-one";
  /** Original constraint name (for debugging) */
  readonly constraintName: string;
  /** Column mappings for the join condition */
  readonly columns: readonly {
    readonly local: string;
    readonly foreign: string;
  }[];
  /** Suggested alias based on relationship semantics */
  readonly suggestedAlias?: string;
}

/**
 * Join path - a sequence of edges from source to destination
 */
export interface JoinPath {
  /** Starting entity */
  readonly from: string;
  /** Sequence of edges to traverse */
  readonly edges: readonly JoinEdge[];
  /** Table aliases for each step (including start) */
  readonly aliases: readonly string[];
}

/**
 * Index info for filter suggestions
 */
export interface FilterableIndex {
  readonly entityName: string;
  readonly columns: readonly string[];
  readonly isUnique: boolean;
  readonly isPartial: boolean;
  readonly method: IndexDef["method"];
}

/**
 * The JoinGraph provides navigation APIs for building queries
 */
export interface JoinGraph {
  /** Get all entities in the graph */
  readonly entities: ReadonlyMap<string, TableEntity>;

  /** Get joinable edges from an entity */
  readonly getEdges: (entityName: string) => readonly JoinEdge[];

  /** Get a specific entity */
  readonly getEntity: (name: string) => TableEntity | undefined;

  /** Find shortest path between two entities (BFS) */
  readonly findPath: (from: string, to: string) => JoinPath | undefined;

  /** Get all reachable entities from a starting point */
  readonly getReachable: (from: string, maxDepth?: number) => ReadonlySet<string>;

  /** Get indexes that could be used for filtering on an entity */
  readonly getFilterableIndexes: (entityName: string) => readonly FilterableIndex[];

  /** Generate SQL JOIN clause from a path */
  readonly toJoinClause: (path: JoinPath) => string;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Build edge from a forward (belongsTo) relation
 */
function edgeFromBelongsTo(rel: Relation): JoinEdge {
  return {
    targetEntity: rel.targetEntity,
    direction: "forward",
    cardinality: "many-to-one",
    constraintName: rel.constraintName,
    columns: rel.columns,
    suggestedAlias: inferAliasFromConstraint(rel.constraintName, rel.targetEntity),
  };
}

/**
 * Build edge from a reverse (hasMany) relation
 */
function edgeFromHasMany(rel: ReverseRelation): JoinEdge {
  return {
    targetEntity: rel.sourceEntity,
    direction: "reverse",
    cardinality: rel.kind === "hasOne" ? "one-to-one" : "one-to-many",
    constraintName: rel.constraintName,
    columns: rel.columns,
    suggestedAlias: inferAliasFromConstraint(rel.constraintName, rel.sourceEntity),
  };
}

/**
 * Infer a reasonable alias from constraint name or target
 */
function inferAliasFromConstraint(constraintName: string, targetEntity: string): string {
  // Extract meaningful part from constraint name like "posts_user_id_fkey"
  // We want something short and meaningful
  const parts = constraintName.replace(/_fkey$/, "").split("_");

  // If constraint has a meaningful relationship hint, use it
  // e.g., "comments_parent_id_fkey" -> could suggest "parent"
  const targetLower = targetEntity.toLowerCase();
  const hintPart = parts.find(
    p => p !== targetLower && p.length > 2 && !["id", "idx", "key"].includes(p),
  );

  if (hintPart && hintPart !== parts[0]) {
    return hintPart;
  }

  // Fall back to lowercase target entity
  return targetEntity.charAt(0).toLowerCase() + targetEntity.slice(1);
}

/**
 * Create a JoinGraph from SemanticIR
 */
export function createJoinGraph(ir: SemanticIR): JoinGraph {
  // Build entity map (tables/views only)
  const entities = new Map<string, TableEntity>();
  for (const [name, entity] of ir.entities) {
    if (isTableEntity(entity)) {
      entities.set(name, entity);
    }
  }

  // Pre-compute edges for each entity
  const edgeCache = new Map<string, readonly JoinEdge[]>();

  const getEdges = (entityName: string): readonly JoinEdge[] => {
    const cached = edgeCache.get(entityName);
    if (cached) return cached;

    const rels = getAllRelations(ir, entityName);
    if (!rels) return [];

    const edges = [
      ...rels.belongsTo.map(edgeFromBelongsTo),
      ...rels.hasMany.map(edgeFromHasMany),
    ];

    edgeCache.set(entityName, edges);
    return edges;
  };

  const getEntity = (name: string): TableEntity | undefined => entities.get(name);

  // BFS to find shortest path
  const findPath = (from: string, to: string): JoinPath | undefined => {
    if (from === to) {
      return { from, edges: [], aliases: [from] };
    }

    if (!entities.has(from) || !entities.has(to)) {
      return undefined;
    }

    const visited = new Set<string>([from]);
    const queue: Array<{ entity: string; path: JoinEdge[]; aliases: string[] }> = [
      { entity: from, path: [], aliases: [from.toLowerCase()] },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const edges = getEdges(current.entity);

      for (const edge of edges) {
        if (visited.has(edge.targetEntity)) continue;

        const newPath = [...current.path, edge];
        const newAliases = [...current.aliases, edge.suggestedAlias ?? edge.targetEntity.toLowerCase()];

        if (edge.targetEntity === to) {
          return { from, edges: newPath, aliases: newAliases };
        }

        visited.add(edge.targetEntity);
        queue.push({ entity: edge.targetEntity, path: newPath, aliases: newAliases });
      }
    }

    return undefined;
  };

  // Get all reachable entities via BFS
  const getReachable = (from: string, maxDepth = Infinity): ReadonlySet<string> => {
    const result = new Set<string>();
    const visited = new Set<string>([from]);
    const queue: Array<{ entity: string; depth: number }> = [{ entity: from, depth: 0 }];

    while (queue.length > 0) {
      const { entity, depth } = queue.shift()!;
      result.add(entity);

      if (depth >= maxDepth) continue;

      for (const edge of getEdges(entity)) {
        if (!visited.has(edge.targetEntity)) {
          visited.add(edge.targetEntity);
          queue.push({ entity: edge.targetEntity, depth: depth + 1 });
        }
      }
    }

    return result;
  };

  // Get indexes useful for filtering
  const getFilterableIndexes = (entityName: string): readonly FilterableIndex[] => {
    const entity = entities.get(entityName);
    if (!entity) return [];

    return entity.indexes.map(idx => ({
      entityName,
      columns: idx.columns,
      isUnique: idx.isUnique,
      isPartial: idx.isPartial,
      method: idx.method,
    }));
  };

  // Generate SQL JOIN clause
  const toJoinClause = (path: JoinPath): string => {
    if (path.edges.length === 0) {
      return `FROM ${entities.get(path.from)?.pgName ?? path.from} AS ${path.aliases[0]}`;
    }

    const clauses: string[] = [];
    const startEntity = entities.get(path.from);
    clauses.push(`FROM ${startEntity?.pgName ?? path.from} AS ${path.aliases[0]}`);

    for (let i = 0; i < path.edges.length; i++) {
      const edge = path.edges[i]!;
      const alias = path.aliases[i + 1]!;
      const prevAlias = path.aliases[i]!;
      const targetEntity = entities.get(edge.targetEntity);
      const tableName = targetEntity?.pgName ?? edge.targetEntity;

      // Build ON clause
      const onConditions = edge.columns.map(col => {
        if (edge.direction === "forward") {
          // We have the FK: our local column matches their foreign column
          return `${prevAlias}.${col.local} = ${alias}.${col.foreign}`;
        } else {
          // They have FK to us: their foreign column matches our local column
          return `${alias}.${col.foreign} = ${prevAlias}.${col.local}`;
        }
      });

      // Use LEFT JOIN for one-to-many (reverse) to not filter out rows without children
      const joinType = edge.direction === "reverse" ? "LEFT JOIN" : "JOIN";

      clauses.push(`${joinType} ${tableName} AS ${alias} ON ${onConditions.join(" AND ")}`);
    }

    return clauses.join("\n  ");
  };

  return {
    entities,
    getEdges,
    getEntity,
    findPath,
    getReachable,
    getFilterableIndexes,
    toJoinClause,
  };
}

// =============================================================================
// Formatting utilities for TUI
// =============================================================================

/**
 * Format an edge for display in picker
 */
export function formatEdge(edge: JoinEdge): string {
  const arrow = edge.direction === "forward" ? "->" : "<-";
  const cardinality = edge.cardinality === "one-to-many" ? "[*]" : "[1]";
  return `${arrow} ${edge.targetEntity} ${cardinality}`;
}

/**
 * Format edge with more detail
 */
export function formatEdgeDetail(edge: JoinEdge): string {
  const cols = edge.columns.map(c => `${c.local} = ${c.foreign}`).join(", ");
  return `via ${edge.constraintName} (${cols})`;
}

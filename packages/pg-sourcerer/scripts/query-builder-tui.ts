#!/usr/bin/env bun
/**
 * Query Builder TUI Prototype
 *
 * Interactive prototype for ep-902a2b: building multi-table queries
 * by navigating FK relationships.
 *
 * Usage: bun scripts/query-builder-tui.ts
 */
import { Effect, Console, Schema } from "effect";
import { createIRBuilderService } from "../src/services/ir-builder.js";
import { InflectionLive } from "../src/services/inflection.js";
import {
  createJoinGraph,
  formatEdge,
  formatEdgeDetail,
  type JoinGraph,
  type JoinEdge,
  type JoinPath,
  type FilterableIndex,
} from "../src/lib/join-graph.js";
import { picker } from "../src/lib/picker.js";
import { loadIntrospectionFixture } from "../src/__tests__/fixtures/index.js";

// =============================================================================
// Query Builder State
// =============================================================================

interface QueryState {
  /** Join path (includes base table) */
  joinPath: JoinPath | null;
  /** Selected columns (alias.column) - empty means SELECT * */
  selectedColumns: string[];
  /** Filter conditions */
  filters: FilterCondition[];
}

interface FilterCondition {
  column: string; // alias.columnName
  op: string;
  paramName: string;
}

// =============================================================================
// SQL Preview Generation
// =============================================================================

/**
 * Generate SQL preview at any stage of the builder.
 * Uses placeholders for incomplete parts.
 */
function generateSQLPreview(
  graph: JoinGraph,
  state: Partial<QueryState>,
  options: {
    /** Highlight a specific part being edited */
    highlight?: "select" | "from" | "where";
    /** Preview columns (before confirmed) */
    previewColumns?: string[];
    /** Preview filters (before confirmed) */
    previewFilters?: FilterCondition[];
  } = {},
): string {
  const lines: string[] = [];
  const { highlight, previewColumns, previewFilters } = options;

  // SELECT clause
  const columns = previewColumns ?? state.selectedColumns ?? [];
  const selectPart = columns.length > 0 ? columns.join(", ") : "*";
  const selectLine = `select ${selectPart}`;
  lines.push(highlight === "select" ? `► ${selectLine}` : selectLine);

  // FROM/JOIN clause
  if (state.joinPath) {
    const fromLines = graph.toJoinClause(state.joinPath).split("\n");
    if (highlight === "from") {
      lines.push(...fromLines.map(l => `► ${l}`));
    } else {
      lines.push(...fromLines);
    }
  } else {
    const placeholder = "from <table> <alias>";
    lines.push(highlight === "from" ? `► ${placeholder}` : placeholder);
  }

  // WHERE clause
  const filters = previewFilters ?? state.filters ?? [];
  if (filters.length > 0) {
    const whereClauses = filters.map((f, i) => `${f.column} ${f.op} $${i + 1}`);
    const whereLine = `where ${whereClauses.join(" and ")}`;
    lines.push(highlight === "where" ? `► ${whereLine}` : whereLine);
  } else if (highlight === "where") {
    lines.push("► where <condition>");
  }

  return lines.join("\n");
}

// =============================================================================
// Picker Row Helpers
// =============================================================================

function columnToRow(entityName: string, alias: string, colName: string) {
  return {
    id: `${alias}.${colName}`,
    label: colName,
    description: `from ${entityName} as ${alias}`,
  };
}

function indexToRow(idx: FilterableIndex) {
  const attrs = [idx.isUnique ? "UNIQUE" : null, idx.isPartial ? "PARTIAL" : null]
    .filter(Boolean)
    .join(", ");
  return {
    id: `${idx.entityName}:${idx.columns.join(",")}`,
    label: idx.columns.join(", "),
    description: `${idx.method}${attrs ? ` (${attrs})` : ""}`,
    index: idx,
  };
}

// =============================================================================
// TUI Flow - Each step shows evolving SQL preview
// =============================================================================

async function pickTable(graph: JoinGraph): Promise<JoinPath | null> {
  const rows = [...graph.entities.values()].map(entity => ({
    id: entity.name,
    label: entity.name,
    description: `${entity.schemaName}.${entity.pgName} (${entity.shapes.row.fields.length} cols)`,
  }));

  const result = await picker(rows, {
    filterPlaceholder: "Select starting table...",
    preview: {
      position: "right",
      width: "50%",
      title: "Query Preview",
      onPreview: row => {
        const entity = graph.getEntity(row.id as string);
        if (!entity) return "Select a table to start";

        // Show what the query would look like with this table
        const previewPath: JoinPath = {
          from: entity.name,
          edges: [],
          aliases: [entity.name.toLowerCase()],
        };

        return generateSQLPreview(graph, { joinPath: previewPath }, { highlight: "from" });
      },
    },
  });

  if (!result || result.length === 0) return null;

  const entityName = result[0]!.id as string;
  return {
    from: entityName,
    edges: [],
    aliases: [entityName.toLowerCase()],
  };
}

async function pickJoins(graph: JoinGraph, initialPath: JoinPath): Promise<JoinPath> {
  let currentPath = initialPath;

  while (true) {
    const currentEntity =
      currentPath.edges.length > 0
        ? currentPath.edges[currentPath.edges.length - 1]!.targetEntity
        : currentPath.from;

    const edges = graph.getEdges(currentEntity);

    // Filter out already-visited entities to prevent cycles
    const visitedEntities = new Set([
      currentPath.from,
      ...currentPath.edges.map(e => e.targetEntity),
    ]);
    const availableEdges = edges.filter(e => !visitedEntities.has(e.targetEntity));

    const rows = [
      {
        id: "__done__",
        label: "[Done - no more joins]",
        description: "Proceed to column selection",
        edge: null,
      },
      ...availableEdges.map(edge => ({
        id: `${currentEntity}->${edge.targetEntity}:${edge.constraintName}`,
        label: formatEdge(edge),
        description: formatEdgeDetail(edge),
        edge,
      })),
    ];

    const result = await picker(rows, {
      filterPlaceholder: `Add join from ${currentEntity}? (${currentPath.edges.length} joins)`,
      preview: {
        position: "right",
        width: "50%",
        title: "Query Preview",
        onPreview: row => {
          if (row.id === "__done__") {
            return generateSQLPreview(graph, { joinPath: currentPath });
          }

          const edge = row.edge;
          if (!edge) return "";

          // Preview with this join added
          const previewPath = {
            from: currentPath.from,
            edges: [...currentPath.edges, edge],
            aliases: [
              ...currentPath.aliases,
              edge.suggestedAlias ?? edge.targetEntity.toLowerCase(),
            ],
          };

          return generateSQLPreview(graph, { joinPath: previewPath }, { highlight: "from" });
        },
      },
    });

    if (!result || result.length === 0 || result[0]!.id === "__done__") {
      break;
    }

    const selectedEdge = result[0]?.edge;
    if (selectedEdge) {
      currentPath = {
        from: currentPath.from,
        edges: [...currentPath.edges, selectedEdge],
        aliases: [
          ...currentPath.aliases,
          selectedEdge.suggestedAlias ?? selectedEdge.targetEntity.toLowerCase(),
        ],
      };
    }
  }

  return currentPath;
}

async function pickColumns(graph: JoinGraph, path: JoinPath): Promise<string[]> {
  // Add base table columns
  const baseEntity = graph.getEntity(path.from);
  const rows = baseEntity
    ? baseEntity.shapes.row.fields.map(field =>
        columnToRow(path.from, path.aliases[0]!, field.columnName),
      )
    : [];

  // Add columns from joined tables
  rows.push(
    ...path.edges.flatMap((edge, i) => {
      const alias = path.aliases[i + 1]!;
      const entity = graph.getEntity(edge.targetEntity);
      return entity
        ? entity.shapes.row.fields.map(field =>
            columnToRow(edge.targetEntity, alias, field.columnName),
          )
        : [];
    }),
  );

  const result = await picker(rows, {
    filterPlaceholder: "Select columns (Tab to toggle, Enter to confirm)...",
    preview: {
      position: "right",
      width: "50%",
      title: "Query Preview",
      onPreview: (row, selectedRows) => {
        const selectedIds = selectedRows.map(r => r.id);
        const hoveredId = row.id;
        const previewCols = selectedIds.includes(hoveredId)
          ? selectedIds
          : [...selectedIds, hoveredId];

        return generateSQLPreview(
          graph,
          { joinPath: path },
          { highlight: "select", previewColumns: previewCols },
        );
      },
    },
  });

  if (!result) return [];
  return result.map(r => r.id);
}

async function pickFilters(
  graph: JoinGraph,
  path: JoinPath,
  selectedColumns: string[],
): Promise<FilterCondition[]> {
  // Collect indexes from all tables in path
  const rows = [
    {
      id: "__done__",
      label: "[Done - no filters]",
      description: "Complete query without WHERE clause",
      index: null,
    },
    ...graph
      .getFilterableIndexes(path.from)
      .map(idx => indexToRow({ ...idx, entityName: path.aliases[0]! })),
    ...path.edges.flatMap((edge, i) => {
      const alias = path.aliases[i + 1]!;
      return graph
        .getFilterableIndexes(edge.targetEntity)
        .map(idx => indexToRow({ ...idx, entityName: alias }));
    }),
  ];

  const result = await picker(rows, {
    filterPlaceholder: "Select index-backed filters (Tab to toggle)...",
    preview: {
      position: "right",
      width: "50%",
      title: "Query Preview",
      onPreview: row => {
        if (row.id === "__done__") {
          return generateSQLPreview(graph, {
            joinPath: path,
            selectedColumns,
          });
        }

        const idx = row.index;
        if (!idx) return "";

        // Preview with this filter
        const previewFilter: FilterCondition = {
          column: `${idx.entityName}.${idx.columns[0]}`,
          op: "=",
          paramName: idx.columns[0]!.replace(/[^a-z0-9]/gi, "_"),
        };

        return generateSQLPreview(
          graph,
          { joinPath: path, selectedColumns },
          { highlight: "where", previewFilters: [previewFilter] },
        );
      },
    },
  });

  if (!result?.[0]) return [];

  // Convert selections to filter conditions
  return result.flatMap(row => {
    const idx = row.index;
    if (!idx) return [];

    return {
      column: `${idx.entityName}.${idx.columns[0]}`,
      op: "=" as const,
      paramName: idx.columns[0]!.replace(/[^a-z0-9]/gi, "_"),
    };
  });
}

async function runPickers(graph: JoinGraph) {
  // Step 1: Pick base table
  const base = await pickTable(graph);
  if (!base) {
    throw new Error("Cancelled");
  }

  // Step 2: Pick joins
  const joinPath = await pickJoins(graph, base);

  // Step 3: Pick columns
  const selectedColumns = await pickColumns(graph, joinPath);

  // Step 4: Pick filters
  const filters = await pickFilters(graph, joinPath, selectedColumns);

  const params = filters.map(f => f.paramName);
  return { joinPath, selectedColumns, filters, params };
}

const Cancelled = class Cancelled extends Schema.TaggedError<Cancelled>("Cancelled")(
  "Cancelled",
  {},
) {};

// =============================================================================
// Main
// =============================================================================

const main = Effect.gen(function* () {
  Console.log("Loading schema...");
  const introspection = loadIntrospectionFixture();
  const builder = createIRBuilderService();
  const ir = yield* builder
    .build(introspection, { schemas: ["app_public"] })
    .pipe(Effect.provide(InflectionLive));
  const graph = createJoinGraph(ir);

  const { joinPath, selectedColumns, filters, params } = yield* Effect.tryPromise({
    try: () => runPickers(graph),
    catch: () => Cancelled,
  });

  // Generate final SQL
  const finalSQL = generateSQLPreview(graph, {
    joinPath,
    selectedColumns,
    filters,
  });

  yield* Console.log("\n" + "=".repeat(60));
  yield* Console.log("GENERATED QUERY");
  yield* Console.log("=".repeat(60));
  yield* Console.log(finalSQL);
  if (params.length > 0) {
    yield* Console.log("\nParameters:");
    yield* Effect.forEach(params, (p, i) => Console.log(`  $${i + 1}: ${p}`));
  }
  yield* Console.log("=".repeat(60));
}).pipe(Effect.catchAll(error => Console.error(`Error: ${error._tag}`)));
Effect.runFork(main);

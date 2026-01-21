# Query Pattern Heuristics Plan

## Problem Statement

The system needs a centralized way to map PostgreSQL index characteristics to recommended query patterns. For example:
- GIN indexes on array columns → suggest `@>` and `&&` operators
- B-tree indexes on timestamps → suggest range queries and ORDER BY optimization
- Foreign key indexes → suggest JOIN patterns

This knowledge should be available to plugins that generate queries (sql-queries, kysely-queries) to produce more optimal, idiomatic code.

## Current State

**Available Index Data** (via `entity.indexes: IndexDef[]`):
- `method`: btree | gin | gist | hash | brin | spgist
- `columns`: inflected column names
- `opclassNames`: operator class names
- `isUnique`, `isPartial`, `predicate`, `hasExpressions`

**Gap**: No mapping from these characteristics to recommended query patterns.

## Proposed Architecture

```
src/lib/query-patterns/
├── heuristics.ts        # Pure functions: Index → Pattern[]
├── index.ts             # Public exports
└── patterns.ts          # QueryPattern types

# Optional plugin (if patterns should be artifacts)
src/plugins/query-patterns.ts   # Analyzes IR, produces pattern artifacts
```

### Module 1: Pattern Types (`patterns.ts`)

```typescript
export type IndexMethod = "btree" | "gin" | "gist" | "hash" | "brin" | "spgist";

export interface QueryPattern {
  /** Human-readable description */
  description: string;
  /** SQL operator/pattern */
  operator: string;
  /** Example usage */
  example: string;
  /** Whether this is the recommended primary pattern */
  recommended?: boolean;
  /** Pattern category */
  category: "where" | "order_by" | "join" | "full_text" | "array";
}

export interface IndexHeuristic {
  /** Which index methods this applies to */
  methods: IndexMethod[];
  /** Predicate to check column types/characteristics */
  predicate: (index: IndexDef, columns: Field[]) => boolean;
  /** Patterns to suggest */
  patterns: QueryPattern[];
}

export interface ColumnHeuristic {
  /** Column types this applies to (element types for arrays) */
  types: string[];
  /** Patterns specific to this column type */
  patterns: QueryPattern[];
}
```

### Module 2: Heuristics Engine (`heuristics.ts`)

```typescript
import type { IndexDef, Field } from "../ir/semantic-ir.js";
import type { QueryPattern, IndexHeuristic, ColumnHeuristic } from "./patterns.js";

export function suggestPatterns(index: IndexDef, columns: Field[]): QueryPattern[] {
  const patterns: QueryPattern[] = [];

  for (const heuristic of INDEX_HEURISTICS) {
    if (
      heuristic.methods.includes(index.method) &&
      heuristic.predicate(index, columns)
    ) {
      patterns.push(...heuristic.patterns);
    }
  }

  // Add column-type specific patterns
  for (const col of columns) {
    for (const heuristic of COLUMN_HEURISTICS) {
      if (heuristic.types.includes(col.typeName) || heuristic.types.includes(col.elementTypeName)) {
        patterns.push(...heuristic.patterns);
      }
    }
  }

  return patterns;
}

export function suggestForTable(entity: TableEntity): Map<string, QueryPattern[]> {
  const result = new Map<string, QueryPattern[]>();

  for (const index of entity.indexes) {
    const columns = entity.shapes.row.fields.filter(f =>
      index.columns.includes(f.columnName)
    );
    result.set(index.name, suggestPatterns(index, columns));
  }

  return result;
}
```

### Heuristics Registry

```typescript
const INDEX_HEURISTICS: IndexHeuristic[] = [
  {
    methods: ["gin"],
    predicate: (idx, cols) => cols.some(c => c.isArray),
    patterns: [
      {
        description: "Array containment check",
        operator: "@>",
        example: "WHERE column @> $1",
        recommended: true,
        category: "where",
      },
      {
        description: "Array overlap check",
        operator: "&&",
        example: "WHERE column && $1",
        category: "where",
      },
    ],
  },
  {
    methods: ["gin"],
    predicate: (idx, cols) =>
      cols.some(c => c.typeName === "tsvector" || c.typeName === "text"),
    patterns: [
      {
        description: "Full-text search",
        operator: "@@",
        example: "WHERE column @@ to_tsquery($1)",
        recommended: true,
        category: "full_text",
      },
      {
        description: "Full-text rank ordering",
        operator: "ORDER BY ts_rank",
        example: "ORDER BY ts_rank(column, to_tsquery($1))",
        category: "order_by",
      },
    ],
  },
  {
    methods: ["btree"],
    predicate: (idx, cols) => cols.some(c =>
      c.typeName === "date" ||
      c.typeName === "timestamp" ||
      c.typeName === "timestamptz"
    ),
    patterns: [
      {
        description: "Range query",
        operator: "BETWEEN",
        example: "WHERE column BETWEEN $1 AND $2",
        recommended: true,
        category: "where",
      },
      {
        description: "Date truncation for grouping",
        operator: "DATE_TRUNC",
        example: "WHERE DATE_TRUNC('day', column) = $1",
        category: "where",
      },
      {
        description: "Index-optimized sorting",
        operator: "ORDER BY",
        example: "ORDER BY column ASC/DESC",
        recommended: true,
        category: "order_by",
      },
    ],
  },
  {
    methods: ["btree"],
    predicate: (idx, cols) => cols.length === 1 && cols[0]!.isUnique,
    patterns: [
      {
        description: "Exact lookup",
        operator: "=",
        example: "WHERE column = $1",
        recommended: true,
        category: "where",
      },
      {
        description: "Inequality queries",
        operator: "< / > / <=",
        example: "WHERE column < $1",
        category: "where",
      },
      {
        description: "IS NULL check",
        operator: "IS NULL",
        example: "WHERE column IS NULL",
        category: "where",
      },
    ],
  },
  {
    methods: ["gist"],
    predicate: (idx, cols) => cols.some(c => c.typeName === "geometry" || c.typeName === "geography"),
    patterns: [
      {
        description: "Spatial containment",
        operator: "&&",
        example: "WHERE column && ST_MakeEnvelope($1, $2, $3, $4)",
        category: "where",
      },
      {
        description: "Nearest neighbor",
        operator: "<->",
        example: "ORDER BY column <-> ST_MakePoint($1, $2) LIMIT 1",
        recommended: true,
        category: "order_by",
      },
    ],
  },
  {
    methods: ["brin"],
    predicate: (idx, cols) => cols.some(c =>
      c.typeName === "bigint" ||
      c.typeName === "serial8" ||
      c.typeName === "bigserial"
    ),
    patterns: [
      {
        description: "Append-only log queries",
        operator: "BETWEEN",
        example: "WHERE id BETWEEN $1 AND $2",
        recommended: true,
        category: "where",
      },
      {
        description: "Recent records",
        operator: "> (descending)",
        example: "ORDER BY id DESC LIMIT N",
        category: "order_by",
      },
    ],
  },
];

const COLUMN_HEURISTICS: ColumnHeuristic[] = [
  {
    types: ["text"],
    patterns: [
      {
        description: "Case-insensitive match",
        operator: "ILIKE",
        example: "WHERE column ILIKE $1",
        category: "where",
      },
      {
        description: "Prefix search",
        operator: "LIKE",
        example: "WHERE column LIKE $1 || '%'",
        category: "where",
      },
    ],
  },
  {
    types: ["jsonb"],
    patterns: [
      {
        description: "JSON containment",
        operator: "@>",
        example: "WHERE column @> $1::jsonb",
        recommended: true,
        category: "where",
      },
      {
        description: "JSON existence",
        operator: "?",
        example: "WHERE column ? $1",
        category: "where",
      },
    ],
  },
  {
    types: ["uuid"],
    patterns: [
      {
        description: "Exact match",
        operator: "=",
        example: "WHERE column = $1::uuid",
        recommended: true,
        category: "where",
      },
    ],
  },
];
```

## Implementation Phases

### Phase 1: Core Library
1. Create `src/lib/query-patterns/` directory
2. Implement `patterns.ts` with types
3. Implement `heuristics.ts` with the registry above
4. Export `suggestPatterns(index, columns)` function
5. Add tests for each heuristic category

### Phase 2: Integration
1. Add `suggestForTable(entity)` convenience function
2. Export from `src/lib/index.ts`
3. Update `sql-queries` and `kysely-queries` to use patterns
4. Pass pattern suggestions to query builders

### Phase 3: Plugin (Optional)
1. Create `src/plugins/query-patterns.ts` if artifacts are needed
2. Plugin produces `queryPattern:EntityName:*` artifacts
3. Other plugins consume these artifacts

## Open Questions

### Q1: Scope - Foreign Key Joins?
Should heuristics also cover foreign key → join pattern recommendations?

**Current FK data available:**
- `relation.kind`: hasMany, hasOne, belongsTo
- `relation.columns`: local → foreign mapping

**Options:**
- **Yes**: Add join patterns based on FK (e.g., "this FK is hasMany, expect multiple rows")
- **No**: Keep focused on WHERE/ORDER BY patterns; FK joins are obvious from schema

### Q2: Output Format - Artifacts or Library?
Should patterns be:
- **Artifacts** (`artifacts: Map<CapabilityKey, Artifact>`) that plugins consume?
- **Library functions** that plugins call directly?

**Arguments for Artifacts:**
- Plugin system already has capability registry
- Clear dependency graph
- Can be cached/computed once per IR

**Arguments for Library:**
- Simpler - no new plugin infrastructure
- Can be called ad-hoc
- Patterns may depend on query context (not just schema)

### Q3: Cardinality Hints?
Should we include cardinality estimates? (e.g., "this FK returns many rows")

**Current IR lacks:**
- Row count estimates
- Null percentage
- Value distribution

**Options:**
- **Yes**: Extend IR to include basic stats, suggest "one-to-many" vs "one-to-one"
- **No**: Cardinality requires fresh statistics, too volatile for generated code
- **Later**: Plan for v2

### Q4: Extensibility?
Should plugins be able to add custom heuristics?

**Options:**
- **No**: Hardcode PostgreSQL standard patterns only
- **Yes**: Export heuristic registry, allow `registerHeuristic()` calls
- **Yes, via plugin**: Plugin adds patterns to the artifact store

### Q5: Operator Class Awareness?
Should we use `opclassNames` for more specific recommendations?

Examples:
- `gin_trgm_ops` → trigram similarity search
- `bpchar_pattern_ops` → pattern matching on char columns

**Current data available:** `index.opclassNames: string[]`

**Options:**
- **Yes**: Add opclass-specific patterns
- **No**: Keep heuristics at method level (GIN → arrays/text)
- **Maybe later**: Requires opclass → pattern mapping table

## Suggested Answers (For Discussion)

1. **FK Joins**: No for now - obvious from schema structure
2. **Output Format**: Library first, plugin optional if artifacts needed
3. **Cardinality**: No - too volatile
4. **Extensibility**: Export registry, allow plugin registration
5. **Opclass**: Yes, include basic ones (gin_trgm_ops, bpchar_pattern_ops)

## File Locations

```
src/lib/query-patterns/
├── index.ts              # Re-exports
├── patterns.ts           # QueryPattern, IndexHeuristic types
├── heuristics.ts         # suggestPatterns, suggestForTable, registry
└── test/
    ├── heuristics.test.ts
    └── fixtures/
        └── table-with-indexes.json
```

## Dependencies

- `src/ir/semantic-ir.ts`: IndexDef, TableEntity, Field types
- No new external dependencies

## Testing Strategy

```typescript
describe("query-patterns heuristics", () => {
  describe("GIN array indexes", () => {
    it("suggests @> for array containment", () => {
      const index = makeIndex({ method: "gin", columns: ["tags"] });
      const columns = [makeField({ name: "tags", isArray: true })];
      const patterns = suggestPatterns(index, columns);
      expect(patterns).toContainPattern({ operator: "@>" });
    });
  });

  describe("B-tree timestamp indexes", () => {
    it("suggests range queries and ORDER BY", () => {
      const index = makeIndex({ method: "btree", columns: ["createdAt"] });
      const columns = [makeField({ name: "createdAt", typeName: "timestamp" })];
      const patterns = suggestPatterns(index, columns);
      expect(patterns).toContainPattern({ operator: "BETWEEN" });
      expect(patterns).toContainPattern({ operator: "ORDER BY" });
    });
  });
});
```

## References

- PostgreSQL index methods: https://www.postgresql.org/docs/current/indexes-types.html
- GIN operator classes: https://www.postgresql.org/docs/current/gin-intro.html
- B-tree use cases: https://www.postgresql.org/docs/current/indexes-types.html#INDEXES-TYPES-BTREE

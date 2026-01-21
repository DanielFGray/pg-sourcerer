# Interactive Migration Generator TUI

## Overview

Build an interactive terminal UI for generating PostgreSQL migrations, leveraging existing patterns from `query-builder-tui.ts` and extending the `hex` SQL builder with DDL support.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Migration Generator TUI                   │
├─────────────────────────────────────────────────────────────┤
│  scripts/migration-generator-tui.ts                         │
│                                                             │
│  Flow:                                                      │
│  1. Pick operation: [Create Table] [Add Column] [Create Index] [Add FK] │
│  2. Collect details with live SQL preview                   │
│  3. Output migration file or pipe to psql                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Hex DDL Extension                       │
├─────────────────────────────────────────────────────────────┤
│  src/hex/ddl.ts (NEW)                                       │
│  src/hex/types.ts (EXTEND)                                  │
│                                                             │
│  - createTable() → CREATE TABLE                             │
│  - addColumn() → ALTER TABLE ADD COLUMN                     │
│  - createIndex() → CREATE INDEX                             │
│  - addForeignKey() → ALTER TABLE ADD CONSTRAINT             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Existing Infrastructure                   │
├─────────────────────────────────────────────────────────────┤
│  src/lib/picker.ts          @opentui/core TUI primitives    │
│  src/lib/join-graph.ts      FK detection/navigation         │
│  src/services/pg-types.ts   Type mapping utilities          │
│  src/hex/builder.ts         DML builders (reference)        │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Phases

### Phase 1: Hex DDL Extension (3-4 hrs)

**New types in `src/hex/types.ts`:**

```typescript
// Column definition
export interface ColumnSpec {
  name: string;
  pgType: string;
  nullable?: boolean;
  hasDefault?: boolean;
  isArray?: boolean;
  isIdentity?: boolean;
}

// Primary key definition
export interface PrimaryKeySpec {
  columns: string[];
  name?: string;
}

// Table constraint (PK, UK, EXCLUDE)
export interface TableConstraintSpec {
  kind: "primaryKey" | "unique" | "exclude";
  columns: string[];
  name?: string;
}

// Index definition
export interface IndexSpec {
  name: string;
  columns: string[];
  method: IndexMethod;
  unique?: boolean;
  where?: string;
  isPrimaryKey?: boolean;
}

// Foreign key definition
export interface ForeignKeySpec {
  columns: string[];
  targetTable: string;
  targetColumns: string[];
  onDelete?: "cascade" | "restrict" | "set null" | "set default";
  onUpdate?: "cascade" | "restrict" | "set null" | "set default";
  name?: string;
}

// Create table specification
export interface CreateTableSpec {
  table: string;
  schema?: string;
  columns: ColumnSpec[];
  primaryKey?: PrimaryKeySpec;
  constraints?: TableConstraintSpec[];
  indexes?: IndexSpec[];
  foreignKeys?: ForeignKeySpec[];
  ifNotExists?: boolean;
}

// Alter table specification
export interface AlterTableSpec {
  table: string;
  schema?: string;
  actions: AlterAction[];
}

export type AlterAction =
  | { kind: "addColumn"; column: ColumnSpec }
  | { kind: "dropColumn"; column: string }
  | { kind: "alterColumn"; column: string; setDefault: string | null }
  | { kind: "addConstraint"; constraint: TableConstraintSpec }
  | { kind: "dropConstraint"; constraint: string }
  | { kind: "renameTo"; newName: string }
  | { kind: "renameColumn"; from: string; to: string };
```

**New module `src/hex/ddl.ts`:**

```typescript
import type { SemanticIR } from "../ir/semantic-ir.js";
import type { 
  CreateTableSpec, 
  AlterTableSpec, 
  IndexSpec, 
  ForeignKeySpec,
  BuilderState 
} from "./types.js";
import { createBuilderState } from "./types.js";

export function createTable(ir: SemanticIR, spec: CreateTableSpec): string {
  const state = createBuilderState(ir);
  // Build CREATE TABLE statement
}

export function alterTable(ir: SemanticIR, spec: AlterTableSpec): string {
  const state = createBuilderState(ir);
  // Build ALTER TABLE statements
}

export function createIndex(ir: SemanticIR, spec: IndexSpec): string {
  // Build CREATE INDEX statement
}

export function dropIndex(name: string, ifExists?: boolean): string {
  return `DROP INDEX${ifExists ? " IF EXISTS" : ""} ${name}`;
}
```

### Phase 2: FK Detection Utility (1-2 hrs)

Extend `src/lib/join-graph.ts`:

```typescript
export interface ForeignKeySuggestion {
  column: string;
  targetTable: string;
  targetColumn: string;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface JoinGraph {
  // ... existing methods ...
  
  /** Suggest foreign keys based on column naming and type patterns */
  readonly suggestForeignKeys: (
    tableName: string,
  ) => readonly ForeignKeySuggestion[];
}
```

**Confidence heuristics:**
- **High**: Column name matches `{targetTable}_id` AND types match
- **Medium**: Column name ends in `_id` but no clear target, OR types differ
- **Low**: Column name similar but not exact match

### Phase 3: Migration TUI Script (3-4 hrs)

**`scripts/migration-generator-tui.ts`:**

```typescript
async function pickOperation() {
  const rows = [
    { id: "create_table", label: "Create Table", description: "Create a new table" },
    { id: "add_column", label: "Add Column", description: "Add columns to existing table" },
    { id: "create_index", label: "Create Index", description: "Create a new index" },
    { id: "add_fk", label: "Add Foreign Key", description: "Add FK constraint" },
    { id: "drop_fk", label: "Drop Foreign Key", description: "Remove FK constraint" },
  ];
  // ... use picker() ...
}

async function runCreateTableWizard(graph: JoinGraph) {
  // 1. Input table name
  // 2. Pick columns (with type picker)
  // 3. Suggest FKs based on column names
  // 4. Pick indexes
  // 5. Live SQL preview
  // 6. Output
}
```

### Phase 4: Output Integration (1-2 hrs)

**Output options:**
1. **Migration file**: `migrations/current/XXXX-description.sql`
2. **Stdout**: Copy to clipboard / pipe to psql
3. **Graphile-migrate format**: Timestamp + hash in filename

## Key Design Decisions

### 1. Migration File Format

**Option A: Graphile-migrate style**
```
migrations/current/
  0001-initial.sql
  0002-add-user-profiles.sql
```
- ✓ Industry standard, supports Graphile workflows
- ✓ Automatic ordering
- ✗ Less flexible

**Option B: Timestamp-based**
```
migrations/
  20240115_143022_create_users.sql
  20240115_143118_add_posts.sql
```
- ✓ Universally understood
- ✓ Self-ordering
- ✗ Long filenames

**Recommendation**: Option B with configurable folder

### 2. ID Generation Defaults

Prompt for or default to:
- `BIGSERIAL` for simple cases
- `UUID DEFAULT gen_random_uuid()` for distributed systems
- Configurable pattern per project

### 3. Timestamp Columns

Offer to add standard audit columns:
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ`
- `deleted_at TIMESTAMPTZ` (for soft deletes)

### 4. Transaction Wrapping

Each migration wraps in `BEGIN; ... COMMIT;` by default, with option to disable.

## Dependencies

- `@opentui/core` - Already used in `query-builder-tui.ts`
- `hex` module - Extending with DDL
- `join-graph.ts` - FK suggestions

## Non-Goals

- Drop operations (handled separately)
- Data migration (only schema)
- Migration ordering/reordering
- Rollback generation

## Future Enhancements (Post-MVP)

- Soft-delete column detection
- Updated_at trigger generation
- Graphile-migrate integration
- Multi-schema support
- Custom type templates

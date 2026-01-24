/**
 * Schema Builder State Types
 *
 * State management for the interactive schema builder TUI.
 * Maps directly to hex/types.ts DDL specifications.
 */
import type {
  ColumnSpec,
  PrimaryKeySpec,
  ForeignKeySpec,
  IndexSpec,
  TableConstraintSpec,
  CreateTableSpec,
  IndexMethod,
} from "../hex/types.js";

// Re-export types that pickers need
export type { ColumnSpec, PrimaryKeySpec, ForeignKeySpec, IndexSpec, TableConstraintSpec, IndexMethod };

/**
 * Complete state for the schema builder TUI.
 */
export interface SchemaBuilderState {
  /** Table name (without schema prefix) */
  tableName: string;
  /** Schema name (e.g., "public", "app_public") */
  schema: string;
  /** Column definitions */
  columns: ColumnSpec[];
  /** Primary key (can be single or composite) */
  primaryKey: PrimaryKeySpec | null;
  /** Foreign key constraints */
  foreignKeys: ForeignKeySpec[];
  /** Index definitions */
  indexes: IndexSpec[];
  /** Other constraints (unique, check, exclude) */
  constraints: TableConstraintSpec[];
}

/**
 * Create an empty initial state.
 */
export function createInitialState(defaults?: Partial<SchemaBuilderState>): SchemaBuilderState {
  return {
    tableName: "",
    schema: "public",
    columns: [],
    primaryKey: null,
    foreignKeys: [],
    indexes: [],
    constraints: [],
    ...defaults,
  };
}

/**
 * Convert builder state to CreateTableSpec for DDL generation.
 */
export function stateToCreateTableSpec(state: SchemaBuilderState): CreateTableSpec {
  return {
    table: state.tableName,
    schema: state.schema || undefined,
    columns: state.columns,
    primaryKey: state.primaryKey ?? undefined,
    foreignKeys: state.foreignKeys.length > 0 ? state.foreignKeys : undefined,
    indexes: state.indexes.length > 0 ? state.indexes : undefined,
    constraints: state.constraints.length > 0 ? state.constraints : undefined,
  };
}

/**
 * Common PostgreSQL types for the type picker.
 *
 * Following best practices from https://wiki.postgresql.org/wiki/Don't_Do_This:
 * - No serial/bigserial (use identity columns instead)
 * - No timestamp without timezone (use timestamptz)
 * - No varchar(n) by default (use text)
 * - No char(n) (use text)
 * - No money (use numeric)
 */
export const COMMON_PG_TYPES = [
  // Identifiers
  { type: "uuid", description: "UUID - 128-bit identifier" },
  { type: "integer GENERATED ALWAYS AS IDENTITY", description: "Auto-increment 32-bit" },
  { type: "bigint GENERATED ALWAYS AS IDENTITY", description: "Auto-increment 64-bit" },

  // Text
  { type: "text", description: "Variable-length string" },
  { type: "citext", description: "Case-insensitive text" },

  // Numbers
  { type: "integer", description: "32-bit signed integer" },
  { type: "bigint", description: "64-bit signed integer" },
  { type: "numeric", description: "Arbitrary precision number" },
  { type: "real", description: "32-bit floating point" },
  { type: "double precision", description: "64-bit floating point" },

  // Boolean
  { type: "boolean", description: "true/false" },

  // Date/Time
  { type: "timestamptz", description: "Timestamp with timezone" },
  { type: "date", description: "Date (no time)" },
  { type: "time", description: "Time of day" },
  { type: "interval", description: "Time interval" },

  // JSON
  { type: "jsonb", description: "Binary JSON (indexable)" },
  { type: "json", description: "Text JSON" },

  // Binary
  { type: "bytea", description: "Binary data" },

  // Network
  { type: "inet", description: "IPv4 or IPv6 address" },
  { type: "macaddr", description: "MAC address" },

  // Geometric
  { type: "point", description: "2D point" },

  // Other
  { type: "tsquery", description: "Text search query" },
  { type: "tsvector", description: "Text search document" },
] as const;

/**
 * Common default value expressions.
 */
export const COMMON_DEFAULTS = [
  { value: "gen_random_uuid()", description: "Generate random UUID" },
  { value: "now()", description: "Current timestamp" },
  { value: "true", description: "Boolean true" },
  { value: "false", description: "Boolean false" },
  { value: "0", description: "Zero" },
  { value: "''", description: "Empty string" },
  { value: "'{}'", description: "Empty JSON object" },
  { value: "'[]'", description: "Empty JSON array" },
] as const;

/**
 * FK action options.
 */
export const FK_ACTIONS = [
  { value: "cascade", description: "Delete/update child rows" },
  { value: "restrict", description: "Prevent if children exist" },
  { value: "set null", description: "Set child FK to NULL" },
  { value: "set default", description: "Set child FK to default" },
] as const;

/**
 * Index method options.
 */
export const INDEX_METHODS: { value: IndexMethod; description: string }[] = [
  { value: "btree", description: "B-tree (default, comparison operators)" },
  { value: "hash", description: "Hash (equality only)" },
  { value: "gin", description: "GIN (arrays, JSONB, full-text)" },
  { value: "gist", description: "GiST (geometric, full-text)" },
  { value: "brin", description: "BRIN (large sorted tables)" },
  { value: "spgist", description: "SP-GiST (non-balanced structures)" },
];

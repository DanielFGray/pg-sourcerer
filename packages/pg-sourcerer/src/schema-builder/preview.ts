/**
 * DDL Preview Generation
 *
 * Generates SQL DDL preview from SchemaBuilderState.
 * Uses hex/ddl.ts functions for SQL generation.
 */
import type { SchemaBuilderState } from "./state.js";
import { stateToCreateTableSpec } from "./state.js";
import { createTable, createIndex } from "../hex/ddl.js";

/**
 * Generate CREATE TABLE DDL from state.
 * Uses hex/ddl.ts for consistent SQL generation.
 */
export function generateCreateTableDDL(state: SchemaBuilderState): string {
  if (!state.tableName) {
    return "-- Enter a table name to see preview";
  }

  const spec = stateToCreateTableSpec(state);
  const lines: string[] = [];

  // Main CREATE TABLE statement
  lines.push(createTable(spec));

  // Indexes are separate CREATE INDEX statements
  const tableName = state.schema
    ? `${state.schema}.${state.tableName}`
    : state.tableName;

  for (const idx of state.indexes) {
    lines.push("");
    lines.push(createIndex(tableName, idx, { schema: state.schema }) + ";");
  }

  return lines.join("\n");
}

/**
 * Generate a short summary of the current state for display.
 */
export function generateStateSummary(state: SchemaBuilderState): string {
  const parts: string[] = [];

  if (state.tableName) {
    const fullName = state.schema ? `${state.schema}.${state.tableName}` : state.tableName;
    parts.push(`Table: ${fullName}`);
  }

  parts.push(`Columns: ${state.columns.length}`);

  if (state.primaryKey) {
    parts.push(`PK: ${state.primaryKey.columns.join(", ")}`);
  }

  if (state.foreignKeys.length > 0) {
    parts.push(`FKs: ${state.foreignKeys.length}`);
  }

  if (state.indexes.length > 0) {
    parts.push(`Indexes: ${state.indexes.length}`);
  }

  return parts.join(" | ");
}

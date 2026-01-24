/**
 * Schema Builder Module
 *
 * Interactive TUI for building database table definitions.
 */
export {
  runSchemaBuilder,
  type SchemaBuilderOptions,
  type SchemaBuilderResult,
  type DatabaseClient,
  type UuidFunctionInfo,
} from "./tui.js";
export {
  type SchemaBuilderState,
  type ColumnSpec,
  type PrimaryKeySpec,
  type ForeignKeySpec,
  type IndexSpec,
  type TableConstraintSpec,
  createInitialState,
  stateToCreateTableSpec,
  COMMON_PG_TYPES,
  COMMON_DEFAULTS,
  FK_ACTIONS,
  INDEX_METHODS,
} from "./state.js";
export { generateCreateTableDDL, generateStateSummary } from "./preview.js";
export {
  tableEntityToState,
  computeDiff,
  computeIndexDiff,
  generateMigrationDDL,
  hasChanges,
} from "./diff.js";
export { runSchemaAlter, type SchemaAlterOptions, type SchemaAlterResult } from "./alter-tui.js";

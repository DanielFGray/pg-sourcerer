/**
 * Hex - SQL Query Builder
 *
 * IR-aware declarative query builder that integrates with SemanticIR
 * for automatic type resolution and validation.
 *
 * Also provides template-based primitives for advanced use cases.
 *
 * Design principles:
 * - Specify WHAT, not HOW - plugins declare intent, builder constructs SQL
 * - IR integration for automatic type resolution (reduces plugin overhead)
 * - Full PostgreSQL feature support (LATERAL, CTEs, subqueries, etc.)
 * - Validation against schema at build time
 *
 * @example
 * ```typescript
 * import { hex } from "./index.js"
 *
 * // Declarative API (recommended)
 * const query = hex.select(ir, {
 *   selects: [{ kind: "column", from: "x", column: "c1" }],
 *   from: { kind: "table", table: "x" },
 *   where: [{ kind: "equals", column: "x.id", value: { name: "id", pgType: "int4" } }],
 * })
 *
 * // Template-based API (for advanced/custom queries)
 * const descriptor = hex.toDescriptor(
 *   "findUserById",
 *   "User",
 *   "select",
 *   { templateParts: ["SELECT * FROM users WHERE id = ", ""] },
 *   { mode: "oneOrNone", fields: userFields },
 *   [{ name: "id", tsType: "string", pgType: "uuid", nullable: false }]
 * )
 * ```
 */

// Re-export all public APIs
export * from "./types.js";
export * from "./builder.js";
export * from "./primitives.js";
export * from "./query.js";
export * from "./ddl.js";

// Re-export Query class and factory
export { Query, createQuery } from "./query.js";

// Main hex object
import type { SemanticIR } from "../ir/semantic-ir.js";
import type { SelectSpec, MutationSpec, ParamSpec, CreateTableSpec, AlterTableSpec, IndexSpec, ForeignKeySpec, DropSpec } from "./types.js";
import { select, mutate, call } from "./builder.js";
import { toQueryDescriptor, buildReturnDescriptor, buildParamDescriptor, buildFieldDescriptor } from "./primitives.js";
import { createQuery } from "./query.js";
import { createTable, createIndex, createPrimaryKeyIndex, addForeignKey, dropForeignKey, dropIndex, dropTable, alterTable, drop, renameTable, renameColumn, renameConstraint, setSchema } from "./ddl.js";

export const hex = {
  // Declarative API (returns Query objects)
  select: (ir: SemanticIR, spec: SelectSpec) => createQuery(select(ir, spec)),
  mutate: (ir: SemanticIR, spec: MutationSpec) => createQuery(mutate(ir, spec)),
  call: (ir: SemanticIR, funcName: string, args: ParamSpec[]) => createQuery(call(ir, funcName, args)),

  // Create Query from descriptor (for custom descriptors)
  createQuery,

  // Template-based API (legacy - returns raw QueryDescriptor)
  toDescriptor: toQueryDescriptor,
  buildReturn: buildReturnDescriptor,
  buildParam: buildParamDescriptor,
  buildField: buildFieldDescriptor,

  // Direct access to descriptor builders (for when you need raw descriptors)
  rawSelect: select,
  rawMutate: mutate,
  rawCall: call,

  // DDL builders
  createTable: (ir: SemanticIR, spec: CreateTableSpec) => createTable(ir, spec),
  createIndex: (ir: SemanticIR, tableName: string, index: IndexSpec, options?: { concurrently?: boolean; ifNotExists?: boolean; schema?: string }) => createIndex(ir, tableName, index, options),
  createPrimaryKeyIndex: (ir: SemanticIR, tableName: string, columns: string[], indexName: string, options?: { concurrently?: boolean; schema?: string }) => createPrimaryKeyIndex(ir, tableName, columns, indexName, options),
  addForeignKey: (ir: SemanticIR, tableName: string, foreignKey: ForeignKeySpec, options?: { schema?: string }) => addForeignKey(ir, tableName, foreignKey, options),
  dropForeignKey: (ir: SemanticIR, tableName: string, constraintName: string, options?: { schema?: string; ifExists?: boolean; cascade?: boolean }) => dropForeignKey(ir, tableName, constraintName, options),
  dropIndex: (indexName: string, options?: { ifExists?: boolean; cascade?: boolean; concurrently?: boolean }) => dropIndex(indexName, options),
  dropTable: (tableName: string, options?: { schema?: string; ifExists?: boolean; cascade?: boolean }) => dropTable(tableName, options),
  alterTable: (ir: SemanticIR, spec: AlterTableSpec) => alterTable(ir, spec),
  drop: (spec: DropSpec) => drop(spec),
  renameTable: (oldName: string, newName: string, options?: { schema?: string }) => renameTable(oldName, newName, options),
  renameColumn: (tableName: string, oldColumn: string, newColumn: string, options?: { schema?: string }) => renameColumn(tableName, oldColumn, newColumn, options),
  renameConstraint: (tableName: string, oldConstraint: string, newConstraint: string, options?: { schema?: string }) => renameConstraint(tableName, oldConstraint, newConstraint, options),
  setSchema: (objectName: string, newSchema: string, options?: { schema?: string; cascade?: boolean }) => setSchema(objectName, newSchema, options),
} as const;

export default hex;

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

// Re-export Query class and factory
export { Query, createQuery } from "./query.js";

// Main hex object
import type { SemanticIR } from "../ir/semantic-ir.js";
import type { SelectSpec, MutationSpec, ParamSpec } from "./types.js";
import { select, mutate, call } from "./builder.js";
import { toQueryDescriptor, buildReturnDescriptor, buildParamDescriptor, buildFieldDescriptor } from "./primitives.js";
import { createQuery } from "./query.js";

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
} as const;

export default hex;

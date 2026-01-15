/**
 * Query descriptor types for SQL code generation
 *
 * These types describe SQL queries in a way that plugins can consume
 * to generate typed function wrappers. They are produced by `hex` (the SQL
 * template builder) and consumed by query plugins.
 */

// =============================================================================
// Core query descriptor
// =============================================================================

/**
 * Complete description of a generated query.
 *
 * This is the primary type that `hex.build()` produces and query plugins consume.
 */
export interface QueryDescriptor {
  /** Function name, e.g., "findUserById", "insertUser" */
  readonly name: string;

  /** Entity this query operates on, e.g., "User" */
  readonly entityName: string;

  /** SQL operation type */
  readonly operation: QueryOperation;

  /** Lookup variant, e.g., "byId", "byEmail" (for distinguishing similar queries) */
  readonly variant?: string;

  /** SQL template with positional parameters ($1, $2, etc.) */
  readonly sql: string;

  /** Input parameters */
  readonly params: readonly ParamDescriptor[];

  /** Return type description */
  readonly returns: ReturnDescriptor;

  /** Optional metadata for advanced use cases */
  readonly meta?: QueryMetadata;
}

// =============================================================================
// Parameter and return descriptors
// =============================================================================

/**
 * Describes a single query parameter.
 */
export interface ParamDescriptor {
  /** Parameter name, e.g., "id", "email" */
  readonly name: string;

  /** TypeScript type string, e.g., "string", "number", "string | null" */
  readonly tsType: string;

  /** PostgreSQL type, e.g., "uuid", "text", "integer" */
  readonly pgType: string;

  /** Whether the parameter accepts null */
  readonly nullable: boolean;

  /** Whether the parameter has a default value (can be omitted) */
  readonly hasDefault?: boolean;
}

/**
 * Describes the return type of a query.
 */
export interface ReturnDescriptor {
  /** How many rows are expected */
  readonly mode: ReturnMode;

  /** Fields in the return type (empty for 'affected' or 'void') */
  readonly fields: readonly FieldDescriptor[];
}

/**
 * Describes a field in the query return type.
 */
export interface FieldDescriptor {
  /** Column name or alias */
  readonly name: string;

  /** TypeScript type string */
  readonly tsType: string;

  /** PostgreSQL type */
  readonly pgType: string;

  /** Whether the field can be null */
  readonly nullable: boolean;

  /** Whether this is an array type */
  readonly isArray?: boolean;
}

/**
 * Optional metadata for advanced query use cases.
 */
export interface QueryMetadata {
  /** Fully qualified table name (schema.table) */
  readonly table: string;

  /** Indexes used by this query */
  readonly indexes?: readonly string[];

  /** Generated from table/column comments */
  readonly comment?: string;
}

// =============================================================================
// Helper types
// =============================================================================

/**
 * SQL operation categories.
 */
export type QueryOperation = "select" | "insert" | "update" | "delete" | "upsert";

/**
 * Query return cardinality modes.
 *
 * - `one`: Exactly one row expected (throws if 0 or >1)
 * - `oneOrNone`: Zero or one row (returns T | null)
 * - `many`: Zero or more rows (returns T[])
 * - `affected`: Returns affected row count (number)
 * - `void`: Returns nothing
 */
export type ReturnMode = "one" | "oneOrNone" | "many" | "affected" | "void";

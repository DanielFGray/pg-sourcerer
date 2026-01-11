/**
 * Query Extension Schema
 *
 * Defines the abstract contract between query providers and consumers.
 * Core understands that "queries" exist as a concept without knowing
 * how they're implemented (SQL tags, Kysely, Drizzle, etc.).
 *
 * Query providers (sql-queries, kysely-queries) register method symbols.
 * HTTP providers (http-elysia, http-trpc) consume them to generate routes.
 *
 * Communication happens through the SymbolRegistry:
 * - Query providers call ctx.symbols.registerEntityMethods(...)
 * - HTTP providers call ctx.symbols.getEntityMethods(...)
 */
import { Schema as S } from "effect"

// ============================================================================
// Parameter Source
// ============================================================================

/**
 * Where a parameter value comes from in the HTTP request.
 * Used by HTTP providers to map query params to request parts.
 */
export const ParamSource = S.Union(
  S.Literal("pk"),         // Primary key - typically from URL path
  S.Literal("fk"),         // Foreign key - from URL path or query string
  S.Literal("lookup"),     // Lookup field - from query string
  S.Literal("body"),       // Request body (for create/update)
  S.Literal("pagination"), // Pagination params (limit, offset)
)
export type ParamSource = S.Schema.Type<typeof ParamSource>

// ============================================================================
// Query Method
// ============================================================================

/**
 * The kind of operation a query method performs.
 * Used by HTTP providers to determine HTTP method and route structure.
 */
export const QueryMethodKind = S.Union(
  S.Literal("read"),    // GET single resource by ID
  S.Literal("list"),    // GET collection with pagination
  S.Literal("create"),  // POST to create new resource
  S.Literal("update"),  // PUT/PATCH to modify existing
  S.Literal("delete"),  // DELETE resource by ID
  S.Literal("lookup"),  // GET by non-PK field (unique or list)
  S.Literal("function"), // Database function call
)
export type QueryMethodKind = S.Schema.Type<typeof QueryMethodKind>

/**
 * A parameter to a query method.
 */
export const QueryMethodParam = S.Struct({
  /** Parameter name in the generated function */
  name: S.String,
  /** TypeScript type as string (e.g., "string", "number", "User") */
  type: S.String,
  /** Whether the parameter is required */
  required: S.Boolean,
  /** Original column name (if applicable) */
  columnName: S.optional(S.String),
  /** Where this param should come from in HTTP request */
  source: S.optional(ParamSource),
})
export type QueryMethodParam = S.Schema.Type<typeof QueryMethodParam>

/**
 * Return type information for a query method.
 */
export const QueryMethodReturn = S.Struct({
  /** TypeScript type as string */
  type: S.String,
  /** Whether the result can be null/undefined */
  nullable: S.Boolean,
  /** Whether the result is an array */
  isArray: S.Boolean,
})
export type QueryMethodReturn = S.Schema.Type<typeof QueryMethodReturn>

/**
 * How to call a query function.
 * Used by HTTP providers to generate correct function invocations.
 */
export const CallSignature = S.Struct({
  /** "named" = fn({ a, b }), "positional" = fn(a, b) */
  style: S.Union(S.Literal("named"), S.Literal("positional")),
  /** For named + body: "property" = { data: body }, "spread" = { field1, field2 } */
  bodyStyle: S.optional(S.Union(S.Literal("property"), S.Literal("spread"))),
})
export type CallSignature = S.Schema.Type<typeof CallSignature>

/**
 * A query method for an entity.
 *
 * This is the core abstraction that HTTP providers consume.
 * It describes what the method does without revealing implementation.
 */
export const QueryMethod = S.Struct({
  /** Export name in the generated file (e.g., "findUserById") */
  name: S.String,
  /** What kind of operation this performs */
  kind: QueryMethodKind,
  /** Parameters the method accepts */
  params: S.Array(QueryMethodParam),
  /** Return type information */
  returns: QueryMethodReturn,
  /** For lookup methods: the field being looked up */
  lookupField: S.optional(S.String),
  /** For lookup methods: whether it returns a single result or array */
  isUniqueLookup: S.optional(S.Boolean),
  /** How to invoke this method */
  callSignature: S.optional(CallSignature),
})
export type QueryMethod = S.Schema.Type<typeof QueryMethod>

// ============================================================================
// Entity Queries Extension
// ============================================================================

/**
 * Query extension data for an entity.
 *
 * This is the shape registered via ctx.symbols.registerEntityMethods().
 * HTTP providers read via ctx.symbols.getEntityMethods(entityName).
 */
export const EntityQueriesExtension = S.Struct({
  /** Available query methods for this entity */
  methods: S.Array(QueryMethod),
  /** Import path for the generated query file (relative to output root) */
  importPath: S.String,
  /** Primary key type (for routing) */
  pkType: S.optional(S.String),
  /** Whether entity has composite primary key */
  hasCompositePk: S.optional(S.Boolean),
})
export type EntityQueriesExtension = S.Schema.Type<typeof EntityQueriesExtension>

// ============================================================================
// Standalone Functions Extension
// ============================================================================

/**
 * A standalone database function (not tied to an entity).
 */
export const StandaloneFunction = S.Struct({
  /** PostgreSQL function name */
  functionName: S.String,
  /** Export name in generated code */
  exportName: S.String,
  /** Schema name */
  schemaName: S.String,
  /** Function volatility */
  volatility: S.Union(S.Literal("immutable"), S.Literal("stable"), S.Literal("volatile")),
  /** Parameters */
  params: S.Array(QueryMethodParam),
  /** Return type */
  returns: QueryMethodReturn,
  /** How to invoke */
  callSignature: S.optional(CallSignature),
  /** Import path */
  importPath: S.String,
})
export type StandaloneFunction = S.Schema.Type<typeof StandaloneFunction>

/**
 * Global functions extension.
 *
 * For standalone database functions not tied to entities.
 * Can be registered via ctx.symbols with a special entity key.
 */
export const FunctionsExtension = S.Struct({
  /** Standalone functions not tied to entities */
  functions: S.Array(StandaloneFunction),
})
export type FunctionsExtension = S.Schema.Type<typeof FunctionsExtension>

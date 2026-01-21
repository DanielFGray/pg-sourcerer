# Plugin Architecture Redesign

## Overview

A ground-up redesign of the plugin system based on first principles. Plugins become pure-ish functions that declare symbols and render bodies in two distinct phases.

**Scope**: Postgres-first, full-stack from query to UI. We leverage rich introspection (types, indexes, constraints, RLS) as a feature, while maintaining abstractions that enable other data sources. See [Data Source Agnosticism](./DATA_SOURCE_AGNOSTICISM.md) for the capability-based approach.

**Vision**: An ecosystem of composable plugins that scaffold a complete web application from database introspection—queries, schemas, HTTP routes, client SDKs, and eventually UI components.

**Branch**: `feature/symbols-conjure-redesign`
**Exploration branch** (for reference): `explore/conjure-registry-v1`

## Core Principles

1. **Effect for organization** - Plugins are Effects that access services and return immutable data. Use `Effect.fn` for automatic tracing.
2. **Two-phase execution** - Declare what exists, then render bodies. Enables validation and cross-plugin references.
3. **Symbols are the real output** - Files are just serialization of symbols.
4. **Config controls file layout** - Plugins don't hardcode paths.
5. **Postgres-focused** - Leverage PG-specific features (types, indexes, JSONB, arrays) rather than abstracting them away.
6. **Static + Dynamic** - Static capability declarations (provides/consumes) for ordering and validation; dynamic requests for on-demand parameterized generation.
7. **Simple authoring experience** - Plugin authors should find the API delightful, not ceremonious. A dash of whimsy.

## The Plugin Ecosystem

The goal is plugins for every layer of the web stack, composing to scaffold complete applications:

```
Introspection (tables, RLS, indexes, relations)
        │
        ▼
┌─────────────────────────────────────────────┐
│  Query Ideation Plugin                      │
│  - Analyzes schema, indexes, RLS policies   │
│  - Proposes query patterns (not final SQL)  │
│  - Outputs QueryIdea[]                      │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│  Query Materialization Plugin               │
│  - Takes ideas, produces QueryDescriptor[]  │
│  - Coordinates with schema plugins          │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌──────────────────────────────────────────────────────────┐
│  Parallel consumers:                                     │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐  │
│  │ SQL Files    │ │ Schema Gen   │ │ HTTP Routes      │  │
│  │ Plugin       │ │ (Zod/Effect) │ │ Plugin           │  │
│  └──────────────┘ └──────────────┘ └──────────────────┘  │
│                          │                               │
│                          ▼                               │
│                 ┌──────────────────┐                     │
│                 │ Client SDK       │                     │
│                 │ Plugin           │                     │
│                 └──────────────────┘                     │
│                          │                               │
│                          ▼                               │
│                 ┌──────────────────┐                     │
│                 │ UI Scaffold      │                     │
│                 │ Plugin           │                     │
│                 └──────────────────┘                     │
└──────────────────────────────────────────────────────────┘
```

### Query Ideas: Intent Before Implementation

A key insight: there's a layer *before* `QueryDescriptor`. A "query idea" captures intent without committing to SQL:

```typescript
interface QueryIdea {
  entity: string
  operation: "findOne" | "findMany" | "create" | "update" | "delete" | "upsert"
  lookupFields?: string[]      // ["id"] or ["email"] - indexes suggest these
  includeRelations?: string[]  // eager load related data
  pagination?: boolean         // needs limit/offset
  rlsContext?: string          // which RLS policy applies
  rationale?: string           // "unique index on email suggests lookup"
}
```

This separation enables:
- **Different ideation strategies** (conservative, aggressive, custom)
- **Schema-aware materialization** (knows about shapes, types)
- **Downstream inspection of intent** (HTTP plugin can see operation type, not just SQL)

## Architecture Layers

```
PostgreSQL Schema
       │
       ▼
┌─────────────────┐
│  Introspection  │  PG types, indexes, constraints, RLS, comments
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   SemanticIR    │  Entities, fields, relations, enums, indexes
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│      hex        │  Query building + AST rendering
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│     Plugins     │  Declare symbols, render bodies
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│      Emit       │  TypeScript/SQL files with correct imports
└─────────────────┘
```

### Layer Responsibilities

| Layer             | Owns                                  | Produces                                      |
| ----------------- | ------------------------------------- | --------------------------------------------- |
| **Introspection** | Database connection, pg-introspection | Raw PG metadata                               |
| **SemanticIR**    | Schema interpretation                 | Entities, fields, relations, enums, indexes   |
| **hex**           | Query building + rendering            | `Query` objects (descriptor + AST methods)    |
| **conjure**       | Generic AST building                  | TypeScript AST nodes, symbol tracking         |
| **Plugins**       | Business logic                        | Symbol declarations + rendered bodies         |
| **Emit**          | File writing                          | TypeScript/SQL source files                   |

## hex: The Query Expert

hex is the single entry point for query building. It uses conjure internally for AST generation but plugin authors don't need to know that.

### Design Philosophy

**Declarative specs over fluent chains.** Specs are easier to generate programmatically:

```typescript
// Clean mapping, easy to understand
const spec = {
  selects: fields.map(f => ({ kind: "column", from: entity.name, column: f.name })),
  from: { kind: "table", table: entity.tableName },
  where: pkFields.map(f => ({ kind: "equals", column: f.name, value: paramFromField(f) })),
}
const query = hex.select(ir, spec)
```

vs fluent (awkward for dynamic generation):
```typescript
// Awkward reduce, harder to debug
const query = fields.reduce(
  (q, f) => q.select(f.name),
  pkFields.reduce(
    (q, f) => q.where(f.name, "=", param(f.name)),
    hex.from(entity.tableName)
  )
)
```

### The Query Object

`hex.select()` and `hex.mutate()` return a `Query` object that provides multiple output formats:

```typescript
const query = hex.select(ir, {
  selects: [{ kind: "star", from: "users" }],
  from: { kind: "table", table: "users" },
  where: [{ kind: "equals", column: "users.id", value: { name: "id", pgType: "uuid" } }],
})

// Access what you need:

query.sql           // "SELECT users.* FROM users WHERE users.id = $1"
query.descriptor    // Full QueryDescriptor with metadata
query.templateParts // { parts: ["SELECT ... WHERE id = ", ""], paramNames: ["id"] }

// Render to AST:

query.toTaggedTemplate("sql", {
  typeParam: ts.ref("User"),
  // params auto-resolve to identifiers by default
})
// → sql<User>`SELECT users.* FROM users WHERE users.id = ${id}`

query.toParameterizedCall("pool", "query", {
  typeParam: ts.ref("User"),
})
// → pool.query<User>("SELECT ... WHERE users.id = $1", [id])

// For raw SQL files:
query.toAnnotatedSql({
  name: "findUserById",
  annotations: "sqlc",  // or custom format
})
// → "-- name: findUserById :one\nSELECT ..."
```

### Param Expression Binding

When generating tagged templates, params need to become expressions:

```typescript
// Default: param "id" → identifier `id`
query.toTaggedTemplate("sql")
// → sql`SELECT ... ${id}`

// Override for different binding:
query.toTaggedTemplate("sql", {
  paramExpr: (name) => conjure.id("params").prop(name).build()
})
// → sql`SELECT ... ${params.id}`
```

### From Ideas to Queries

For plugins that work with `QueryIdea`, hex provides a convenience layer:

```typescript
// Convert idea to query
const query = hex.fromIdea(ir, {
  entity: "User",
  operation: "findOne",
  lookupFields: ["id"],
})

// Equivalent to building the spec manually
const query = hex.select(ir, {
  selects: [{ kind: "star", from: "users" }],
  from: { kind: "table", table: "users" },
  where: [{ kind: "equals", column: "id", value: { name: "id", pgType: "uuid" } }],
  limit: 1,
})
```

### Smart Query Generation

With hex knowing about IR, queries are intelligent:

1. **Index-aware** - Generate queries that use available indexes
2. **Type-safe params** - Params carry PG type info for downstream use
3. **Return shape inference** - `SELECT *` → all columns, subset → subset type
4. **Aggregate awareness** - `COUNT(*)` returns `bigint`, not row type
5. **Multiple output formats** - Same query → tagged template, parameterized call, or raw SQL

## conjure: The AST Expert

conjure provides generic AST building primitives. hex uses it internally; plugin authors use it for non-query code (schemas, types, custom logic).

### What conjure provides

```typescript
import { conjure } from "pg-sourcerer"

// Chain builders
conjure.id("z").method("string").method("uuid").build()

// Object/array literals  
conjure.obj().prop("name", conjure.str("value")).build()
conjure.arr(expr1, expr2).build()

// Functions
conjure.fn().param("id", ts.string()).body(stmt.return(...)).build()

// TypeScript types
conjure.ts.ref("User")
conjure.ts.array(conjure.ts.ref("User"))
conjure.ts.union(conjure.ts.string(), conjure.ts.null())

// Statements
conjure.stmt.const("x", expr)
conjure.stmt.return(expr)

// Template literals (generic, not SQL-specific)
conjure.template(["hello ", "!"], nameExpr)
conjure.taggedTemplate("sql", parts, exprs, typeParam?)

// Symbol tracking for exports
conjure.exp.interface("User", ctx, properties)
conjure.exp.const("findUser", ctx, fnExpr)
```

### hex uses conjure internally

hex's `.toTaggedTemplate()` method uses conjure's generic template building:

```typescript
// Inside hex (implementation detail)
toTaggedTemplate(tag, opts) {
  const parts = this.templateParts
  const exprs = parts.paramNames.map(name => 
    opts?.paramExpr?.(name) ?? conjure.id(name).build()
  )
  return conjure.taggedTemplate(tag, parts.parts, exprs, opts?.typeParam)
}
```

Plugin authors don't need to understand this split—they just call `query.toTaggedTemplate()`.

## Shared Types

### QueryIdea

Captures intent before SQL generation:

```typescript
interface QueryIdea {
  entity: string
  operation: "findOne" | "findMany" | "create" | "update" | "delete" | "upsert"
  lookupFields?: string[]      // Which fields to query by
  includeRelations?: string[]  // Relations to eager-load
  pagination?: boolean         // Needs limit/offset params
  rlsContext?: string          // RLS policy context
  rationale?: string           // Why this query was suggested
}
```

### QueryDescriptor

Complete query metadata:

```typescript
interface QueryDescriptor {
  name: string                    // "findUserById"
  entityName: string              // "User"
  operation: QueryOperation       // "select" | "insert" | ...
  variant?: string                // "byId" | "byEmail" | ...
  sql: string                     // "SELECT ... WHERE id = $1"
  params: ParamDescriptor[]       // Input parameter metadata
  returns: ReturnDescriptor       // Return type metadata
  meta?: QueryMetadata            // Table, indexes, comments
}

interface ParamDescriptor {
  name: string
  tsType: string
  pgType: string
  nullable: boolean
  hasDefault?: boolean
}

interface ReturnDescriptor {
  mode: "one" | "oneOrNone" | "many" | "affected" | "void"
  fields: FieldDescriptor[]
}
```

### Query (hex output)

The `Query` object returned by `hex.select()` / `hex.mutate()`:

```typescript
interface Query {
  // Data access
  readonly sql: string
  readonly descriptor: QueryDescriptor
  readonly templateParts: { parts: readonly string[]; paramNames: readonly string[] }
  
  // For symbol declarations
  toSignature(): SignatureDef
  
  // AST rendering
  toTaggedTemplate(tag: string, opts?: {
    typeParam?: n.TSType
    paramExpr?: (name: string) => n.Expression
  }): n.TaggedTemplateExpression
  
  toParameterizedCall(obj: string, method: string, opts?: {
    typeParam?: n.TSType
    paramExpr?: (name: string) => n.Expression
  }): n.CallExpression
  
  toAnnotatedSql(opts?: {
    name?: string
    style?: "sqlc" | "pgtyped" | "custom"
    annotations?: (descriptor: QueryDescriptor) => string[]
  }): string
}
```

## Constraints (What Forced These Decisions)

| Constraint                                    | Implication                                        |
| --------------------------------------------- | -------------------------------------------------- |
| Plugins depend on other plugins' output       | Ordered execution, capability system               |
| Generated code must type-check                | Import resolution mandatory, AST over strings      |
| Users control output structure                | Config decides file paths, not plugins             |
| Validation after all plugins                  | Need complete symbol graph before rendering        |
| Plugins generate queries dynamically          | Declarative specs over fluent chains               |
| Multiple output formats from same query       | Query object with render methods, not raw SQL      |
| Plugin authors shouldn't juggle two libraries | hex is primary interface, uses conjure internally  |
| Downstream plugins need intent, not just SQL  | QueryIdea layer before QueryDescriptor             |

## Execution Flow

```
1. BOOTSTRAP
   - Load config
   - Introspect database
   - Build SemanticIR

2. SORT
   - Topological sort plugins by capabilities (provides/consumes)

3. DECLARE PHASE (ordered)
   For each plugin:
     Input:  { ir, config, deps }
     Output: SymbolDeclaration[]

   Runtime collects all declarations into registry.

4. VALIDATION
   - All consumed capabilities have providers?
   - No (name, capability) collisions?
   - Dependency graph acyclic?

5. FILE ASSIGNMENT
   - Apply config rules to assign symbols → files
   - Produces FileAssignments map

6. RENDER PHASE (ordered)
   For each plugin:
     Input:  { ir, config, deps, symbols, files, own }
     Output: RenderedSymbol[]

   Symbol handles track cross-references via .ref()/.call()

7. EMIT
   - Group symbols by file
   - Generate imports from tracked references + external imports
   - Write files to disk
```

## Plugin Interface

Plugins are Effect-based, using services for context and `Effect.fn` for automatic tracing/logging.

```typescript
interface Plugin<Config = unknown> {
  name: string;
  provides: Capability[];
  consumes?: Capability[];        // Hard requirement - won't run without
  enhancedBy?: Capability[];      // Soft - uses if available, degrades gracefully
  configSchema?: Schema<Config>;

  // Phase 1: Declare what symbols exist (Effect with services)
  declare: Effect<SymbolDeclaration[], PluginError, PluginServices>;

  // Phase 2: Render symbol bodies (Effect with services + registry)
  render: Effect<RenderedSymbol[], PluginError, PluginServices | SymbolRegistry>;
}

// Services available to plugins via Effect context
type PluginServices = IR | Inflection | TypeHints | PluginConfig;

// Example using Effect.fn for automatic tracing
const typesPlugin: Plugin = {
  name: "types",
  provides: ["types"],

  declare: Effect.fn("types.declare")(function* () {
    const ir = yield* IR;
    const inflection = yield* Inflection;

    return ir.entities.map(entity => ({
      name: inflection.entityName(entity),
      capability: `type:${entity.name}`,
      kind: "type" as const,
      entity: entity.name,
    }));
  }),

  render: Effect.fn("types.render")(function* () {
    const ir = yield* IR;
    const registry = yield* SymbolRegistry;
    // ... generate AST
    return renderedSymbols;
  }),
};
```

### Effect Services

| Service          | Purpose                                        | Depends On            |
| ---------------- | ---------------------------------------------- | --------------------- |
| `IR`             | SemanticIR access                              | Introspection         |
| `Capabilities`   | Query available introspection capabilities     | Introspection         |
| `Inflection`     | Naming transforms (entity names, field names)  | Config                |
| `TypeHints`      | User type overrides                            | Config                |
| `PluginConfig`   | This plugin's parsed configuration             | Config, configSchema  |
| `SymbolRegistry` | Resolve/import symbols (render phase only)     | Declare phase results |

### Error Types

Errors use `Data.TaggedError` for typed error handling with `Effect.catchTag`:

```typescript
// Plugin errors
class DeclareError extends Data.TaggedError("DeclareError")<{
  message: string;
  plugin: string;
  cause?: unknown;
}> {}

class RenderError extends Data.TaggedError("RenderError")<{
  message: string;
  plugin: string;
  symbol?: string;
  cause?: unknown;
}> {}

// Validation errors
class UnsatisfiedCapability extends Data.TaggedError("UnsatisfiedCapability")<{
  message: string;
  capability: Capability;
  consumer: string;
}> {}

class SymbolCollision extends Data.TaggedError("SymbolCollision")<{
  message: string;
  capability: Capability;
  existingSymbol: string;
  newSymbol: string;
}> {}

class CircularDependency extends Data.TaggedError("CircularDependency")<{
  message: string;
  cycle: readonly string[];
}> {}
```

### Phase 1: Declare

Plugins yield from Effect services to access IR, inflection, etc.

```typescript
interface SymbolDeclaration {
  name: string;
  capability: Capability; // name + capability = unique identity
  kind: SymbolKind;
  entity?: string; // Associated entity (e.g., "User")
  signature?: SignatureDef; // For functions
  metadata?: unknown; // Plugin-specific, passed back in render
}

// Services accessed via yield*
const ir = yield* IR; // SemanticIR
const inflection = yield* Inflection; // Naming service
const typeHints = yield* TypeHints; // User type overrides
const config = yield* PluginConfig; // This plugin's config
```

**Key**: Services provide all context. No input object needed.

### Phase 2: Render

In addition to declare-phase services, plugins can access SymbolRegistry for cross-plugin references.

```typescript
interface RenderedSymbol {
  ref: SymbolRef; // { name, capability }
  body: AST;
  externalImports?: ImportSpec[]; // e.g., { from: "kysely", names: ["Kysely"] }
}

// Additional service available in render phase
const registry = yield* SymbolRegistry;

// Query other plugins' symbols
const symbols = registry.query("types"); // All type symbols
const user = registry.get({ name: "User", capability: "types" });

// Get handle for import tracking
const handle = registry.import("type:User");
handle.ref(); // Returns AST identifier, tracks cross-reference
handle.call(); // Returns AST call expression, tracks cross-reference
```

### Dynamic Requests

For on-demand parameterized generation, the registry supports dynamic requests:

```typescript
// In render phase, request a specific variant
const insertSchema = yield* registry.request("schemas", {
  entity: "User",
  shape: "insert",
  omitFields: ["id", "createdAt"],
});
```

This complements static `provides`/`consumes`:

- **Static declarations** → ordering, validation, cycle detection
- **Dynamic requests** → consumer-driven generation, parameterization

### Symbol Handles

When querying the registry in render phase, you get `SymbolHandle` objects:

```typescript
interface SymbolHandle extends SymbolDeclaration {
  ref(): n.Identifier; // Returns AST, tracks reference
  call(args: AST[]): n.CallExpression; // Returns call AST, tracks reference
  typeRef(): n.TSTypeReference; // For type symbols
}
```

Calling `.ref()` or `.call()` records the cross-reference. Runtime uses this to auto-generate imports between files.

## Plugin Authoring API

Plugins primarily interact with `hex` for queries and `conjure` for everything else.

### hex API Summary

```typescript
import { hex } from "pg-sourcerer";

// Build queries with declarative specs
const query = hex.select(ir, { selects, from, where, ... })
const query = hex.mutate(ir, { kind: "insert", table, columns, ... })

// Or from a query idea
const query = hex.fromIdea(ir, idea)

// Query object methods
query.sql              // Parameterized SQL string
query.descriptor       // Full QueryDescriptor
query.templateParts    // { parts: string[], paramNames: string[] }
query.toSignature()    // For symbol declarations

// Render to AST
query.toTaggedTemplate(tag, opts?)         // sql<T>`...${param}...`
query.toParameterizedCall(obj, method, opts?)  // pool.query<T>("...", [...])
query.toAnnotatedSql(opts?)                // For .sql file output
```

### conjure API Summary

```typescript
import { conjure } from "pg-sourcerer";

// Chain/expression builders
conjure.id("name")              // Start chain from identifier
conjure.chain(expr)             // Start chain from expression
conjure.call(obj, method, args) // Quick method call

// Compound builders
conjure.obj()                   // Object literal builder
conjure.arr(...)                // Array literal builder
conjure.fn()                    // Function builder

// Literals
conjure.str("value")
conjure.num(42)
conjure.bool(true)
conjure.template(parts, ...exprs)
conjure.taggedTemplate(tag, parts, exprs, typeParam?)

// TypeScript types (conjure.ts.*)
conjure.ts.ref("TypeName")
conjure.ts.array(innerType)
conjure.ts.union(...types)
conjure.ts.nullable(type)
conjure.ts.objectType(props)

// Statements (conjure.stmt.*)
conjure.stmt.const(name, init)
conjure.stmt.return(expr)
conjure.stmt.if(test, consequent, alternate?)

// Exports with symbol tracking (conjure.exp.*)
conjure.exp.interface(name, ctx, properties)
conjure.exp.const(name, ctx, init)
conjure.exp.type(name, ctx, type)
```

### Type Resolution

```typescript
// From IR fields
types.fromField(field, ir): TypeRef
types.fromPg(pgTypeName): TypeRef

// Cross-plugin references
types.ref(name, capability?): TypeRef

// TypeRef resolves to AST at emit time and tracks cross-references
```

## Example Plugins

### Query Ideation Plugin

Analyzes schema and proposes query patterns:

```typescript
import { Effect, Array, pipe } from "effect";
import type { Plugin, QueryIdea } from "pg-sourcerer";
import { IR } from "pg-sourcerer/services";

export const queryIdeation: Plugin = {
  name: "query-ideation",
  provides: ["query-ideas"],

  declare: Effect.fn("query-ideation.declare")(function* () {
    const ir = yield* IR;

    return pipe(
      Array.fromIterable(ir.entities.values()),
      Array.filter(e => e.kind === "table"),
      Array.flatMap(entity => {
        const ideas: QueryIdea[] = [];
        
        // Every table with PK gets findById
        if (entity.primaryKey) {
          ideas.push({
            kind: "query-idea",
            entity: entity.name,
            operation: "findOne",
            lookupFields: entity.primaryKey.fields,
            rationale: "primary key lookup",
          });
        }
        
        // Unique indexes suggest additional lookups
        for (const index of entity.indexes.filter(i => i.isUnique)) {
          ideas.push({
            kind: "query-idea",
            entity: entity.name,
            operation: "findOne", 
            lookupFields: index.columns,
            rationale: `unique index: ${index.name}`,
          });
        }
        
        // All tables get basic CRUD
        ideas.push(
          { kind: "query-idea", entity: entity.name, operation: "findMany", pagination: true },
          { kind: "query-idea", entity: entity.name, operation: "create" },
          { kind: "query-idea", entity: entity.name, operation: "update" },
          { kind: "query-idea", entity: entity.name, operation: "delete" },
        );
        
        return ideas;
      }),
    );
  }),
};
```

### Query Materialization Plugin

Converts ideas to actual queries with multiple output formats:

```typescript
import { Effect, Array, pipe } from "effect";
import { hex, type Plugin } from "pg-sourcerer";
import { IR, Inflection, SymbolRegistry } from "pg-sourcerer/services";

export const sqlQueries: Plugin = {
  name: "sql-queries",
  provides: ["queries"],
  consumes: ["query-ideas", "types"],

  declare: Effect.fn("sql-queries.declare")(function* () {
    const ir = yield* IR;
    const inflection = yield* Inflection;
    const registry = yield* SymbolRegistry;
    const ideas = registry.query("query-ideas");

    return ideas.map(idea => {
      const query = hex.fromIdea(ir, idea);
      
      return {
        name: inflection.queryName(idea),
        capability: "queries",
        kind: "function",
        entity: idea.entity,
        signature: query.toSignature(),
        metadata: { query, idea },
      };
    });
  }),

  render: Effect.fn("sql-queries.render")(function* () {
    const registry = yield* SymbolRegistry;
    const own = registry.own();

    return own.map(decl => {
      const { query } = decl.metadata;
      const entityType = registry.get({ name: decl.entity, capability: "types" });

      return {
        ref: decl,
        body: query.toTaggedTemplate("sql", {
          typeParam: entityType.typeRef(),
        }),
        externalImports: [{ from: "@effect/sql", names: ["sql"] }],
      };
    });
  }),
};
```

### HTTP Routes Plugin

Consumes queries to generate API endpoints:

```typescript
import { Effect } from "effect";
import { conjure, type Plugin } from "pg-sourcerer";
import { IR, Inflection, SymbolRegistry } from "pg-sourcerer/services";

export const httpRoutes: Plugin = {
  name: "http-routes",
  provides: ["http-routes"],
  consumes: ["queries", "schemas"],

  declare: Effect.fn("http-routes.declare")(function* () {
    const registry = yield* SymbolRegistry;
    const queries = registry.query("queries");
    const inflection = yield* Inflection;

    return queries.map(q => {
      const { idea } = q.metadata;
      const method = idea.operation === "findOne" || idea.operation === "findMany" 
        ? "GET" 
        : idea.operation === "create" ? "POST"
        : idea.operation === "update" ? "PATCH"
        : "DELETE";
      
      return {
        name: inflection.routeName(idea),
        capability: "http-routes",
        entity: idea.entity,
        metadata: {
          query: q,
          method,
          path: inflection.routePath(idea),
        },
      };
    });
  }),

  render: Effect.fn("http-routes.render")(function* () {
    const registry = yield* SymbolRegistry;
    const own = registry.own();
    
    return own.map(decl => {
      const { query, method, path } = decl.metadata;
      const queryFn = registry.get({ name: query.name, capability: "queries" });
      const inputSchema = registry.get({ name: `${decl.entity}Input`, capability: "schemas" });

      // Generate Hono route handler
      return {
        ref: decl,
        body: conjure.fn()
          .param("c", conjure.ts.ref("Context"))
          .async()
          .body(
            // const input = inputSchema.parse(await c.req.json())
            // const result = await queryFn(input)
            // return c.json(result)
          )
          .build(),
        externalImports: [{ from: "hono", names: ["Context"] }],
      };
    });
  }),
};
```

## File Layout Configuration

Config controls where symbols land:

```typescript
// sourcerer.config.ts
export default {
  output: {
    // Preset strategies
    layout: "by-capability", // or "by-entity", "single-file"

    // Or explicit per-capability
    paths: {
      types: "types.ts",
      queries: "queries/${entity}.ts", // Template with entity name
      zod: "schemas/zod.ts",
      http: "api/routes.ts",
    },
  },
};
```

Runtime resolves these between declare and render phases, passes `FileAssignments` to render.

## Symbol Identity

Symbols are uniquely identified by `(name, capability)`:

```typescript
interface SymbolRef {
  name: string
  capability: Capability
}

// Examples:
{ name: "User", capability: "types" }
{ name: "User", capability: "zod" }        // Different symbol, same name
{ name: "findUserById", capability: "queries" }
```

This allows multiple plugins to produce symbols with the same name (e.g., `User` type vs `User` Zod schema).

## Cross-Plugin References

### In Signatures (Declare Phase)

Use `types.ref()` for symbolic references:

```typescript
returns.single(types.ref("User", "types"), { nullable: true });
```

`types.ref()` returns a `TypeRef` that:

- Carries the symbol reference
- Resolves to AST at emit time
- Triggers import generation automatically

### In Bodies (Render Phase)

Use symbol handles from registry:

```typescript
render(input) {
  const userType = input.symbols.get({ name: "User", capability: "types" })

  return [{
    ref: { name: "createUser", capability: "queries" },
    body: b.fn([b.param("data", userType.typeRef())], /* ... */),
    //                         ↑ tracks reference, generates import
  }]
}
```

## Validation

After all `declare()` runs, before `render()`:

1. **Capability satisfaction** - All consumed capabilities have providers
2. **No collisions** - No duplicate `(name, capability)` pairs
3. **Acyclic deps** - Plugin dependency graph has no cycles

Errors are actionable:

- "Plugin `http-hono` consumes `queries` but no plugin provides it"
- "Collision: `User` in capability `types` declared by both `types` and `custom-types`"

## Comparison to Current System

| Aspect            | Current                            | New                                        |
| ----------------- | ---------------------------------- | ------------------------------------------ |
| Plugin API        | Effect-based, mutates shared state | Effect-based, returns immutable data       |
| Effect usage      | Implicit, tied to runtime          | Explicit services, `Effect.fn` for tracing |
| Execution         | Single pass                        | Two phases (declare → render)              |
| Cross-plugin refs | Runtime lookup by name             | Explicit handles with reference tracking   |
| File paths        | Plugin decides                     | Config decides                             |
| Validation        | During execution                   | Between phases                             |
| Import resolution | Manual                             | Automatic from handle usage                |
| Query building    | Inline in plugins                  | hex produces QueryDescriptor               |
| Error handling    | Mixed                              | Typed errors with `Data.TaggedError`       |
| Tracing           | Manual spans                       | Automatic via `Effect.fn`                  |

## Supersedes

This design supersedes:

- **ep-f39a14** (Plugin Coordination Refactor) - ResourceProvider model was more abstract but less powerful
- **ep-933e05** (v0.4 Pull-Based Interop) - Core ideas preserved, but implementation approach changed

Key differences from ResourceProvider:

- Symbols as universal currency vs opaque resources
- Two explicit phases vs single provide() with request()
- hex as SQL layer vs plugins building SQL inline

## Implementation Plan

### Current State (as of review)

**Already implemented:**
- Runtime types: `Plugin`, `SymbolDeclaration`, `RenderedSymbol`, `SymbolHandle`
- SymbolRegistry: register, resolve, import, reference tracking
- Orchestrator: two-phase execution (declare → validate → assign → render)
- conjure/types: Type AST builders (`types.fromField`, `types.ref`, etc.)
- conjure/signature: `param`, `returns`, `sig` for function signatures
- hex: Declarative query builder returning `QueryDescriptor`
- IR: `SemanticIR` with entities, shapes, fields
- File assignment and emit infrastructure

### Phase 1: Core Primitives (Minimum Viable Plugin)

Goal: Get a simple `types` plugin working end-to-end to validate the architecture.

1. **Add SymbolHandle.consume() support**
   - Extend `SymbolHandle` interface with optional `consume?: (input: Expression) => Expression`
   - Update `createSymbolHandle` to accept consume callback
   - Schema/query plugins will provide their own consume implementations

2. **Add conjure expression builders**
   - `conjure.id(name)` - identifier
   - `conjure.prop(obj, name)` - property access
   - `conjure.call(callee, args)` - call expression
   - `conjure.taggedTemplate(tag, parts, exprs, typeParam?)` - tagged template literal
   - `conjure.exportConst(name, init)` - export const declaration
   - `conjure.exportInterface(name, properties)` - export interface declaration

3. **Write minimal types plugin**
   - Declares `type:EntityName` for each table entity
   - Renders TypeScript interfaces from IR shapes
   - Validates: declare → render → emit flow works

4. **Add integration test**
   - Load example DB IR
   - Run types plugin through orchestrator
   - Verify emitted TypeScript compiles

### Phase 2: Query Plugin Pattern

Goal: Validate hex → Query → AST flow with consumer callbacks.

5. **Wrap hex in Query object**
   - `hex.select()` returns `Query` instead of raw `QueryDescriptor`
   - Add `.toTaggedTemplate(tag, opts)` returning AST
   - Add `.toParameterizedCall(obj, method, opts)` returning AST
   - Add `.descriptor` for raw access
   - Add `.consume(params)` for execution wrapper (e.g., `.execute()`)

6. **Write sql-queries plugin**
   - Consumes IR, produces query functions
   - Uses hex to build queries
   - Provides `consume()` callback that wraps with execution

7. **Write zod plugin**
   - Consumes shapes, produces Zod schemas
   - Provides `consume()` callback: `(input) => z.parse(Schema, input)`

### Phase 3: Cross-Plugin Composition

Goal: Validate plugin → plugin consumption via registry.

8. **Write HTTP routes plugin**
   - Consumes: query functions (via registry)
   - Consumes: schemas (via registry, uses `consume()` for validation)
   - Produces: route handler functions

9. **Integration test: full pipeline**
   - IR → types → queries → schemas → HTTP routes
   - Verify all cross-references resolve
   - Verify imports are generated correctly

### Phase 4: Polish and CLI

10. **Update CLI and generate.ts**
    - Wire up new orchestrator
    - Plugin discovery/loading
    - Config-driven plugin selection

11. **Documentation and examples**
    - Plugin authoring guide
    - Example plugins
    - Migration guide from old API

## Related Documents

- **[DECISIONS.md](./DECISIONS.md)** - Resolved architectural decisions with rationale
- **[OPEN_QUESTIONS.md](./OPEN_QUESTIONS.md)** - Unresolved items needing implementation experience or user input
- **[DATA_SOURCE_AGNOSTICISM.md](./DATA_SOURCE_AGNOSTICISM.md)** - Capability-based approach for multiple data sources

## Success Criteria

1. **Simple authoring experience** - Plugins are easy to write, APIs are discoverable
2. **Cross-plugin references "just work"** - No manual import tracking
3. **Validation catches errors early** - Before rendering, not at emit time
4. **Config controls file layout** - Without plugin changes
5. **Generated code type-checks** - Always
6. **Query → AST is seamless** - `query.toTaggedTemplate()` just works
7. **Postgres features inform generation** - Indexes suggest queries, RLS informs access patterns
8. **Ecosystem composability** - Plugins can consume and extend each other's output
9. **Full-stack scaffolding path** - From DB → queries → schemas → HTTP → SDK → UI

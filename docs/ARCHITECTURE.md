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
│  Query Plugin (sql-queries, kysely, etc.)   │
│  - Generates typed query functions          │
│  - Registers QueryMethod metadata           │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌──────────────────────────────────────────────────────────┐
│  Parallel consumers:                                     │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐  │
│  │ Schema Gen   │ │ HTTP Routes  │ │ Client SDK       │  │
│  │ (Zod/Effect) │ │ Plugin       │ │ Plugin           │  │
│  └──────────────┘ └──────────────┘ └──────────────────┘  │
│                          │                               │
│                          ▼                               │
│                 ┌──────────────────┐                     │
│                 │ UI Scaffold      │                     │
│                 │ Plugin           │                     │
│                 └──────────────────┘                     │
└──────────────────────────────────────────────────────────┘
```

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
| **Conjure**       | AST building + symbol tracking        | TypeScript AST nodes, automatic registration  |
| **Plugins**       | Business logic                        | Symbol declarations + rendered statements     |
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

### Smart Query Generation

With hex knowing about IR, queries are intelligent:

1. **Index-aware** - Generate queries that use available indexes
2. **Type-safe params** - Params carry PG type info for downstream use
3. **Return shape inference** - `SELECT *` → all columns, subset → subset type
4. **Aggregate awareness** - `COUNT(*)` returns `bigint`, not row type
5. **Multiple output formats** - Same query → tagged template, parameterized call, or raw SQL

## Conjure: Contextual AST Building

Conjure is an Effect service that provides AST building with automatic symbol tracking. Plugins access it via `yield* Conjure` to get a context-aware instance. The service uses FiberRef internally to track the current plugin context.

### The Magic

When you call `exp.const(...)` inside a plugin's render phase, conjure:
1. Builds the AST node (pure computation)
2. Extracts identifier references for cross-file import tracking
3. Infers capability from current plugin context (via FiberRef)
4. Registers the symbol with the orchestrator's registry
5. Returns the statement for inclusion in the output

**Plugin authors never see the registry.** They just write AST "templates" and the sorcery handles the rest.

### The Conjure Service

```typescript
// Plugins access Conjure as an Effect service
class Conjure extends Context.Tag("@pgsourcerer/Conjure")<
  Conjure,
  ConjureService
>() {}

interface ConjureService {
  // ═══════════════════════════════════════════════════════════════════════════
  // Tracked exports - these register symbols automatically
  // ═══════════════════════════════════════════════════════════════════════════
  
  readonly exp: {
    /** Export const: `export const name = init` */
    const(name: string, init: n.Expression, opts?: ExpOpts): Effect<n.Statement>
    
    /** Export type alias: `export type Name = Type` */
    type(name: string, type: n.TSType, opts?: ExpOpts): Effect<n.Statement>
    
    /** Export interface: `export interface Name { ... }` */
    interface(name: string, props: InterfaceProp[], opts?: ExpOpts): Effect<n.Statement>
    
    /** Export function: `export function name(...) { ... }` */
    fn(decl: n.FunctionDeclaration, opts?: ExpOpts): Effect<n.Statement>
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // Cross-plugin references
  // ═══════════════════════════════════════════════════════════════════════════
  
  /** Import a symbol from another plugin, returns handle for AST generation */
  use(capability: string): SymbolHandle
  
  // ═══════════════════════════════════════════════════════════════════════════
  // Pure AST builders - no tracking, just construction
  // ═══════════════════════════════════════════════════════════════════════════
  
  /** Start chain from identifier */
  id(name: string): ChainBuilder
  
  /** Start chain from expression */
  chain(expr: n.Expression): ChainBuilder
  
  /** Object literal builder */
  obj(): ObjBuilder
  
  /** Array literal builder */
  arr(...elements: n.Expression[]): ArrBuilder
  
  /** Function builder */
  fn(): FnBuilder
  
  /** Literals */
  str(value: string): n.StringLiteral
  num(value: number): n.NumericLiteral
  bool(value: boolean): n.BooleanLiteral
  
  /** TypeScript types */
  readonly ts: {
    ref(name: string, typeParams?: n.TSType[]): n.TSTypeReference
    array(elementType: n.TSType): n.TSArrayType
    union(...types: n.TSType[]): n.TSUnionType
    nullable(type: n.TSType): n.TSUnionType
    // ... etc
  }
  
  /** Statement builders */
  readonly stmt: {
    const(name: string, init: n.Expression): n.VariableDeclaration
    return(expr?: n.Expression): n.ReturnStatement
    // ... etc
  }
  
  /** Parameter builders */
  readonly param: {
    typed(name: string, type: n.TSType): n.Identifier
    pick(fields: string[], entityType: string): n.ObjectPattern
    // ... etc
  }
}
```

### ExpOpts: Controlling Symbol Registration

```typescript
interface ExpOpts {
  /** 
   * Capability identifier for this symbol.
   * If omitted, inferred from plugin provides + symbol name.
   * Only needed for plugins that provide multiple capabilities.
   */
  capability?: string
  
  /** External package imports needed by this symbol */
  imports?: ExternalImport[]
  
  /** 
   * Consumer callback: how to use/validate through this symbol.
   * Enables Liskov Substitution—consumers don't care if Zod or Effect Schema.
   */
  consume?: (input: n.Expression) => n.Expression
  
  /** Export style override (default: "named") */
  exports?: "named" | "default" | false
}
```

### Capability Inference

Capabilities are inferred from plugin context by default, following Liskov Substitution Principle:

```typescript
// Zod plugin declares what it provides
const zodPlugin: Plugin = {
  name: "zod",
  provides: ["schema"],  // Abstract capability
  
  render: Effect.gen(function* () {
    const { exp } = yield* Conjure
    
    // Capability inferred as "schema:zod:User" from context
    yield* exp.const("User", schemaExpr)
    
    // Explicit override for edge cases
    yield* exp.const("UserInput", inputSchema, { 
      capability: "schema:zod:User:input" 
    })
  })
}

// HTTP plugin consumes abstract "schema", doesn't care about implementation
const httpPlugin: Plugin = {
  name: "http",
  consumes: ["schema"],  // Any schema provider works
  
  render: Effect.gen(function* () {
    const { use } = yield* Conjure
    
    // Gets whatever schema plugin provided
    const userSchema = use("schema:User")
    
    // consume() works regardless of Zod, Valibot, ArkType, etc.
    const validated = userSchema.consume?.(inputExpr)
  })
}
```

### Plugin Authoring with Conjure

```typescript
render: Effect.gen(function* () {
  const ir = yield* IR
  const { exp, id, obj, ts, use } = yield* Conjure
  
  const statements: n.Statement[] = []
  
  for (const entity of ir.entities.values()) {
    if (!isTableEntity(entity)) continue
    
    // Build schema expression (pure AST building)
    const schemaExpr = id("z")
      .method("object", [
        obj().fromEntries(
          entity.shapes.row.fields.map(f => [f.name, fieldToZodType(f)])
        ).build()
      ])
      .build()
    
    // Emit with tracking (returns statement, registers symbol)
    // Capability inferred as "schema:zod:User" from plugin context
    statements.push(
      yield* exp.const(entity.name, schemaExpr, {
        imports: [{ from: "zod", names: ["z"] }],
        consume: (input) => id(entity.name).method("parse", [input]).build()
      })
    )
    
    // Cross-plugin reference example
    const typeHandle = use(`type:${entity.name}`)
    const inferredType = ts.qualifiedRef("z", "infer", [ts.typeof(entity.name)])
    
    statements.push(
      yield* exp.type(`${entity.name}Type`, inferredType)
    )
  }
  
  return statements
})
```

### Why This Design?

1. **No leaky abstractions** - Plugins return statements, not `RenderedSymbol` objects
2. **One way to do things** - Always `yield* Conjure`, always `exp.*` for exports
3. **Effect-native** - Services, context tracking, and dependency injection
4. **Discoverable** - Destructure what you need: `{ exp, id, ts, use }`
5. **Whimsical** - "Conjure" and "sorcery" fit the code generation theme

## Shared Types

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
  
  // For type generation
  toSignature(): TSTypeKind  // (params) => Promise<ReturnType>
  
  // AST rendering
  toTaggedTemplate(tag: string, opts?: {
    typeParam?: n.TSType
    paramExpr?: (name: string) => n.Expression
  }): n.TaggedTemplateExpression
  
  toParameterizedCall(obj: string, method: string, opts?: {
    typeParam?: n.TSType
    paramExpr?: (name: string) => n.Expression
  }): n.CallExpression
}
```

### QueryMethod (query-HTTP interface)

The interface between query plugins and HTTP plugins:

```typescript
interface QueryMethod {
  name: string                    // "findUserById"
  kind: QueryMethodKind           // read/list/create/update/delete/lookup/function
  params: QueryMethodParam[]      // { name, type, required, source }
  returns: QueryMethodReturn      // { type, nullable, isArray }
  lookupField?: string            // For lookup queries
  callSignature?: CallSignature   // { style: "named"|"positional" }
}

interface QueryMethodParam {
  name: string
  type: string                    // TypeScript type
  required: boolean
  columnName?: string
  source?: "pk" | "fk" | "lookup" | "body" | "pagination"
}
```

Query plugins register methods via `EntityQueriesExtension`. HTTP plugins consume via `registry.getEntityMethods()`.

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
| HTTP plugins need operation context           | QueryMethod includes kind, param sources           |
| Symbol tracking must be invisible             | Conjure service handles registration automatically |

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
     - Orchestrator sets FiberRef with plugin context (name, provides)
     - Plugin accesses Conjure service via `yield* Conjure`
     - Conjure reads FiberRef to infer capabilities
     Input:  { ir, config, deps, Conjure via FiberRef }
     Output: n.Statement[]

   exp.* calls automatically register symbols with inferred capabilities, refs, imports.

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

  // Phase 2: Render symbol bodies (Effect with services + Conjure)
  render: Effect<n.Statement[], PluginError, PluginServices | Conjure>;
}

// Services available to plugins via Effect context
type PluginServices = IR | Inflection | TypeHints | PluginConfig;
```

### Effect Services

| Service          | Purpose                                        | Depends On            |
| ---------------- | ---------------------------------------------- | --------------------- |
| `IR`             | SemanticIR access                              | Introspection         |
| `Capabilities`   | Query available introspection capabilities     | Introspection         |
| `Inflection`     | Naming transforms (entity names, field names)  | Config                |
| `TypeHints`      | User type overrides                            | Config                |
| `PluginConfig`   | This plugin's parsed configuration             | Config, configSchema  |
| `Conjure`        | AST building + symbol registration             | Registry (internal)   |

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
  metadata?: unknown; // Plugin-specific (e.g., QueryMethod for queries)
}

// Services accessed via yield*
const ir = yield* IR; // SemanticIR
const inflection = yield* Inflection; // Naming service
const typeHints = yield* TypeHints; // User type overrides
const config = yield* PluginConfig; // This plugin's config
```

**Key**: Services provide all context. No input object needed.

### Phase 2: Render

Plugins access Conjure for AST building with automatic symbol tracking.

```typescript
// Get the Conjure service
const { exp, id, obj, ts, use } = yield* Conjure;

// Build and emit symbols
const statements: n.Statement[] = [];

statements.push(
  yield* exp.const("findUserById", fnExpr, {
    imports: [{ from: "@effect/sql", names: ["sql"] }],
    metadata: { query: queryDescriptor }
  })
);

return statements;
```

### Symbol Handles for Cross-Plugin References

The `use()` method returns a handle for referencing another plugin's symbols:

```typescript
interface SymbolHandle {
  readonly name: string
  readonly capability: Capability
  readonly metadata?: unknown
  
  /** Use as identifier - tracks reference for imports */
  ref(): n.Identifier
  
  /** Use as type reference - tracks reference for imports */
  typeRef(): n.TSTypeReference
  
  /** Use as call expression - tracks reference for imports */
  call(...args: n.Expression[]): n.CallExpression
  
  /** 
   * Consume/validate input through this symbol.
   * Returns AST that wraps the input with library-specific logic.
   */
  consume?(input: n.Expression): n.Expression
}
```

Example usage:

```typescript
const { use, id } = yield* Conjure

// Get handle to a schema from another plugin
const userSchema = use("schema:zod:User")

// Use in validation (schema plugin provides consume callback)
const validated = userSchema.consume?.(id("input").build())
// → UserSchema.parse(input)

// Use as type reference
const returnType = userSchema.typeRef()
// → z.infer<typeof UserSchema>
```

## Example Plugins

### Zod Schema Plugin

```typescript
import { Effect } from "effect";
import type { Plugin } from "pg-sourcerer";
import { IR, Conjure } from "pg-sourcerer/services";
import { isTableEntity, isEnumEntity } from "pg-sourcerer/ir";

export const zodPlugin: Plugin = {
  name: "zod",
  provides: ["schema"],
  
  declare: Effect.gen(function* () {
    const ir = yield* IR;
    const declarations = [];
    
    for (const entity of ir.entities.values()) {
      if (isEnumEntity(entity)) {
        declarations.push({
          name: entity.name,
          capability: `schema:zod:${entity.name}`,
        });
      }
      if (isTableEntity(entity)) {
        declarations.push(
          { name: entity.name, capability: `schema:zod:${entity.name}` },
          { name: `${entity.name}Insert`, capability: `schema:zod:${entity.name}:insert` },
        );
      }
    }
    
    return declarations;
  }),
  
  render: Effect.gen(function* () {
    const ir = yield* IR;
    const { exp, id, obj, arr, ts } = yield* Conjure;
    
    const statements = [];
    
    // Enum schemas
    for (const entity of ir.entities.values()) {
      if (!isEnumEntity(entity)) continue;
      
      const schemaExpr = id("z")
        .method("enum", [arr(...entity.values.map(v => str(v))).build()])
        .build();
      
      statements.push(
        yield* exp.const(entity.name, schemaExpr, {
          imports: [{ from: "zod", names: ["z"] }],
          metadata: {
            consume: (input) => id(entity.name).method("parse", [input]).build()
          }
        })
      );
    }
    
    // Table schemas
    for (const entity of ir.entities.values()) {
      if (!isTableEntity(entity)) continue;
      
      const schemaExpr = id("z")
        .method("object", [
          obj().fromEntries(
            entity.shapes.row.fields.map(f => [f.name, fieldToZodType(f)])
          ).build()
        ])
        .build();
      
      statements.push(
        yield* exp.const(entity.name, schemaExpr, {
          imports: [{ from: "zod", names: ["z"] }],
          metadata: {
            consume: (input) => id(entity.name).method("parse", [input]).build()
          }
        })
      );
    }
    
    return statements;
  }),
};
```

### HTTP Routes Plugin

```typescript
import { Effect } from "effect";
import type { Plugin } from "pg-sourcerer";
import { IR, Inflection, Conjure } from "pg-sourcerer/services";

export const httpRoutes: Plugin = {
  name: "http-routes",
  provides: ["http-routes"],
  consumes: ["queries", "schema"],

  declare: Effect.gen(function* () {
    const { use } = yield* Conjure;
    const queries = use("queries"); // Get all query symbols
    const inflection = yield* Inflection;

    return queries.map(q => ({
      name: inflection.routeName(q.metadata.idea),
      capability: "http-routes",
      entity: q.metadata.idea.entity,
      metadata: {
        query: q,
        method: operationToMethod(q.metadata.idea.operation),
        path: inflection.routePath(q.metadata.idea),
      },
    }));
  }),

  render: Effect.gen(function* () {
    const { exp, id, fn, use } = yield* Conjure;
    const own = yield* ownDeclarations(); // Helper to get this plugin's declarations
    
    const statements = [];
    
    for (const decl of own) {
      const { query, method, path } = decl.metadata;
      
      // Get handles to consumed symbols
      const queryFn = use(query.capability);
      const inputSchema = use(`schema:${decl.entity}:insert`);
      
      // Build route handler
      const handler = fn()
        .async()
        .arrow()
        .param("c", ts.ref("Context"))
        .body(
          // const input = Schema.parse(await c.req.json())
          stmt.const("input", inputSchema.consume(
            id("c").prop("req").method("json").build()
          )),
          // const result = await queryFn(input)
          stmt.const("result", await_(queryFn.call(id("input").build()))),
          // return c.json(result)
          stmt.return(id("c").method("json", [id("result").build()]).build())
        )
        .build();
      
      statements.push(
        yield* exp.const(decl.name, handler, {
          imports: [{ from: "hono", names: ["Context"] }]
        })
      );
    }
    
    return statements;
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

## Validation

After all `declare()` runs, before `render()`:

1. **Capability satisfaction** - All consumed capabilities have providers
2. **No collisions** - No duplicate `(name, capability)` pairs
3. **Acyclic deps** - Plugin dependency graph has no cycles

Errors are actionable:

- "Plugin `http-hono` consumes `queries` but no plugin provides it"
- "Collision: `User` in capability `types` declared by both `types` and `custom-types`"

## Design Summary

| Aspect            | Approach                                                    |
| ----------------- | ----------------------------------------------------------- |
| Plugin API        | Effect-based, returns `n.Statement[]`                       |
| Symbol tracking   | Automatic via Conjure service + FiberRef                    |
| Cross-plugin refs | `use()` method on Conjure                                   |
| Capability inference | From plugin provides, explicit override available        |
| Effect usage      | Explicit services, `Effect.fn` for tracing                  |
| Execution         | Two phases: declare → validate → render                     |
| File paths        | Config decides, not plugins                                 |
| Validation        | Between declare and render phases                           |
| Import resolution | Automatic from `use()` and `exp.*`                          |
| Query building    | hex produces `Query` objects with multiple output formats   |
| Error handling    | Typed errors with `Data.TaggedError`                        |
| Tracing           | Automatic via `Effect.fn`                                   |

## Implementation Plan

### Phase 1: Conjure Service

Goal: Implement the Conjure Effect service with `exp.*` helpers.

1. **Create Conjure service tag**
   - `packages/pg-sourcerer/src/services/conjure.ts`
   - Context.Tag with ConjureService interface
   - FiberRef for plugin context (name, provides)
   
2. **Implement exp.* methods**
   - `exp.const()`, `exp.type()`, `exp.interface()`, `exp.fn()`
   - Each returns `Effect<n.Statement>` 
   - Reads FiberRef for capability inference
   - Internally registers with provided registry
   - Extracts refs via `extractIdentifierRefs()`

3. **Implement use() for cross-plugin refs**
   - Returns SymbolHandle with ref(), typeRef(), call(), consume()
   - Tracks cross-references for import generation

4. **Update orchestrator**
   - Set FiberRef before each plugin runs
   - Provide Conjure service layer
   - Collect registered symbols after render

### Phase 2: Migrate Plugins

Goal: Update existing plugins to use new Conjure service.

5. **Migrate zod plugin**
   - Change render return type to `n.Statement[]`
   - Use `yield* Conjure` and `exp.*` helpers
   - Remove manual RenderedSymbol construction

6. **Migrate remaining plugins**
   - valibot, arktype, kysely, sql-queries
   - HTTP plugins
   - Effect schema plugin

### Phase 3: Cleanup

7. **Remove old patterns**
   - Remove `getConjureMeta` and metadata injection (in progress)
   - Simplify RenderedSymbol (internal only)
   - Update tests

8. **Documentation**
   - Plugin authoring guide
   - Migration examples

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

## Future Considerations

### Query Ideation Layer

A potential enhancement: an "ideation" layer between schema analysis and query generation. Currently query plugins generate `QueryMethod` directly from IR. An ideation layer could:

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

**Benefits**:
- **Different ideation strategies** (conservative, aggressive, custom)
- **Schema-aware materialization** (knows about shapes, types)
- **Inspectable intent** (see why queries were generated)

**Current status**: Not implemented. Query plugins work well generating methods directly. Consider adding if:
- Users want more control over which queries are generated
- Smart query suggestions become a feature
- RLS-aware query generation is needed

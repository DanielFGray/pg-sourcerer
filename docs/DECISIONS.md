# Design Decisions

Resolved architectural decisions with rationale. These emerged from design discussions in ARCHITECTURE.md and DATA_SOURCE_AGNOSTICISM.md.

## Plugin System

### Plugins are Effect-Based

**Decision**: Plugins use Effect for all operations.

**Rationale**:
- `Effect.fn` provides automatic tracing/logging
- Services via `yield*` give clean dependency injection
- Immutable return data (SymbolDeclaration[], n.Statement[]) enables validation between phases
- `Data.TaggedError` for typed errors integrates with Effect's error handling

**Implication**: Plugin authors must understand basic Effect patterns, but get tracing/error-handling for free.

### Two-Phase Execution (Declare → Render)

**Decision**: Plugins run in two distinct phases.

**Rationale**:
- Declare phase collects all symbols before any rendering
- Enables validation (capability satisfaction, collision detection, cycle detection)
- Cross-plugin references can be validated before code generation
- Config can assign symbols to files between phases

**Implication**: Plugins cannot generate code during declaration. All cross-plugin coordination happens through the registry.

### Static + Dynamic Capabilities

**Decision**: Support both static declarations and dynamic requests.

- **Static (`provides`/`consumes`)** → ordering, validation, cycle detection
- **Dynamic (`request()`)** → render-phase only, for parameterized variants

**Rationale**:
- Static capabilities enable topological sorting without running plugins
- Some generation is inherently parameterized (e.g., "insert schema for User omitting id")
- Plugins shouldn't declare every permutation upfront

**Implication**: `request()` is render-phase only. To consume another plugin's output:
1. Consume their static capability (declared symbols available via registry)
2. Call `request()` in render for parameterized variants the provider supports

## Query Building (hex)

### Declarative Specs Over Fluent Chains

**Decision**: hex uses declarative spec objects, not fluent builder chains.

```typescript
// Declarative (chosen)
const spec = {
  selects: fields.map(f => ({ kind: "column", from: table, column: f.name })),
  where: lookupFields.map(f => ({ kind: "equals", column: f, value: paramFor(f) })),
}
const query = hex.select(ir, spec)

// Fluent (rejected)
const query = fields.reduce((q, f) => q.select(f.name), hex.from(table))
```

**Rationale**:
- Specs are easier to generate programmatically (simple mapping)
- Specs are easier to inspect/transform before building
- Fluent chains require awkward reduce patterns for dynamic generation

### Query Objects with Multiple Output Formats

**Decision**: `hex.select()` returns a `Query` object, not raw SQL.

**Rationale**:
- Same query → tagged template, parameterized call, or raw SQL
- Descriptor metadata available for downstream plugins
- Template parts available for custom rendering

**Implication**: Plugins call `query.toTaggedTemplate()` or similar, not string manipulation.

### hex Uses conjure Internally

**Decision**: hex is the primary interface for query building. It uses conjure internally for AST generation.

**Rationale**:
- Plugin authors shouldn't juggle two libraries
- hex handles SQL-specific concerns
- conjure remains available for non-query AST (schemas, types, custom logic)

**Implication**: Most plugins only import hex. Advanced plugins use conjure directly for non-query code.

## Type System

### Schema in Descriptors

**Decision**: `ParamDescriptor` and `ReturnDescriptor` include optional Effect Schemas.

```typescript
interface ParamDescriptor {
  name: string
  tsType: string
  pgType: string
  nullable: boolean
  schema?: Schema.Schema<unknown>  // Optional runtime validation
}
```

**Rationale**:
- Enables runtime validation matching compile-time types
- Consistent with config/smart-tag validation patterns (already use Effect Schema)
- Schema plugins can access param/return schemas directly

**Implication**: Plugins that need runtime validation get it from descriptors. Plugins that don't can ignore the field.

## Data Source Agnosticism

### Postgres-First, Capability-Gated

**Decision**: Postgres is first-class, not special-cased. Other sources provide fewer capabilities.

**Rationale**:
- Postgres provides the richest introspection (indexes, RLS, constraints, enums)
- Plugins check `caps.has("introspection:indexes")`, not `dialect === "postgres"`
- Graceful degradation over hard failure

**Implication**: Adding a new SQL dialect means implementing an adapter that declares its capabilities. Existing plugins work automatically with degraded output.

### hex is SQL-Only

**Decision**: hex builds SQL queries. Non-SQL sources (DynamoDB, GraphQL) bring their own builders.

**Rationale**:
- SQL dialects share enough structure for one builder
- Non-SQL sources are fundamentally different
- Plugins can bring their own query builders

**Implication**: The core doesn't need to abstract over SQL vs non-SQL. That's a plugin concern.

### Coarse Capability Granularity

**Decision**: Start with coarse capabilities (`introspection:indexes`), not fine-grained (`introspection:indexes:partial`).

**Rationale**:
- Over-granular → explosion of capability strings
- Refine only when a real plugin or adapter needs finer distinction
- Current plugins check for feature presence, not nuances

**Implication**: Add sub-capabilities when implementing a dialect with partial support, not speculatively.

## Cross-Plugin Consumption

### Shapes as the Lingua Franca

**Decision**: IR shapes (row, insert, update, patch) are the unit of cross-plugin communication.

```typescript
// IR defines shapes per entity
entity.shapes.row     // all fields
entity.shapes.insert  // omit generated, require non-nullable without defaults
entity.shapes.update  // all optional
entity.shapes.patch   // partial

// Schema plugins generate validators for shapes
// HTTP plugins reference schemas by shape name (e.g., "UserInsert", "UserUpdate")
```

**Rationale**:
- Shapes are computed once in IR, stable identifiers all plugins can reference
- Decouples query plugins from schema plugins from HTTP plugins
- Each plugin only needs to understand shape names, not internal structures

**Implication**: Plugins reference shapes by naming convention. Schema plugins generate `UserInsert`, `UserUpdate`, etc.

### Consumer Callbacks for Library-Specific Operations

**Decision**: Symbol handles include consumer callbacks that generate AST wrappers for consumption. This is a general pattern available to all plugins, not just schemas.

```typescript
interface SymbolHandle {
  // Standard accessors
  ref(): Identifier
  call(args): CallExpression
  typeRef(): TypeReference
  
  // Consumer callback: how to use this symbol
  // Returns AST that wraps/completes the symbol's usage
  consume?(input: Expression): Expression
}
```

**Examples**:

```typescript
// Schema symbols: validation wrappers
const inputSchema = registry.get("User:insert", "schemas:zod")
const validated = inputSchema.consume(conjure.id("req").prop("body"))
// → z.parse(UserInsertSchema, req.body)  // Zod
// → Schema.decodeUnknownSync(UserInsert)(req.body)  // Effect Schema

// Query symbols: execution wrappers
// Kysely plugin generates query partials:
//   findUserById({ id }) { return db.selectFrom('users').where('id', '=', id) }
// Consumer needs to add .execute() or .executeTakeFirst()
const query = registry.get("findUserById", "queries:kysely")
const executed = query.consume(conjure.id("params"))
// → findUserById(params).executeTakeFirst()
```

**Rationale**:
- Consumers can't know every library's API (Zod vs Effect Schema, Kysely vs Drizzle)
- Only the provider plugin knows how to complete the operation
- Pattern generalizes: schemas need parse/decode, queries need execute, etc.

**Implication**: Plugins that produce "partial" symbols (needing completion) implement `consume()`. Consumers call it without knowing library specifics.

### QueryMethod as Query-HTTP Interface

**Decision**: `QueryMethod` is the interface between query plugins and HTTP plugins.

```typescript
interface QueryMethod {
  name: string                    // "findUserById"
  kind: QueryMethodKind           // read/list/create/update/delete/lookup/function
  params: QueryMethodParam[]      // { name, type, required, source: "pk"|"body"|... }
  returns: QueryMethodReturn      // { type, nullable, isArray }
  lookupField?: string            // For lookup queries
  callSignature?: CallSignature   // { style: "named"|"positional" }
}
```

**Rationale**:
- `kind` determines HTTP method and route structure
- `params.source` tells HTTP plugins where to extract values (path, query, body)
- `callSignature` enables correct function invocation generation
- Evolved from implementation experience with 5 HTTP frameworks

**Implication**: Query plugins register `QueryMethod` via `EntityQueriesExtension`. HTTP plugins consume without knowing query implementation details.

### Plugin Data Flow

**Decision**: Plugins form a pipeline where each layer consumes the previous layer's **symbols**, not internal data structures.

```
IR (entities, shapes)
    ↓
Query Plugin
    provides: function symbols with QueryMethod metadata
    registers via EntityQueriesExtension
    ↓
Schema Plugin
    provides: schema symbols for each shape
    consumer callback: consume(input) → validated output
    ↓
HTTP Plugin
    consumes: query functions (via QueryMethod)
    consumes: schemas (by shape name, uses consume() callback)
    provides: route handler symbols
    ↓
Client SDK Plugin
    consumes: HTTP routes
    provides: typed client wrapper symbols
```

**Rationale**:
- Each plugin only knows about symbol interfaces, not internals
- 1:1 mapping of queries → endpoints (by convention)
- Schema plugins respond to shape names, don't need to know who's asking
- Consumer callbacks bridge library-specific APIs

**Implication**: Plugins are loosely coupled. Adding a new schema library means implementing one plugin with the right `consume()` callback. HTTP plugins work unchanged.

## Conjure Service

### Conjure as Effect Service (Not Pure Module)

**Decision**: Conjure is an Effect service (`yield* Conjure`), not a pure module import.

**Rationale**:
- Symbol tracking requires registry access, which is a runtime concern
- Effect's context system provides clean dependency injection
- Plugins get a pre-wired Conjure instance with no manual setup
- Enables automatic symbol registration without leaking implementation details

**Implication**: Plugins must `yield* Conjure` to access AST builders. This is intentional—it ensures tracking happens.

### exp.* Methods Return Effects

**Decision**: `exp.const()`, `exp.type()`, etc. return `Effect<n.Statement>`, not plain statements.

```typescript
// Plugin code
const { exp } = yield* Conjure
statements.push(yield* exp.const("User", schemaExpr, { imports: [...] }))
```

**Rationale**:
- Effectful return makes tracking explicit
- Enables future middleware (logging, metrics, etc.)
- Consistent with Effect-first design philosophy
- Type system enforces correct usage

**Implication**: Plugin render code uses `yield*` for exports. Pure AST building (id, obj, ts) remains synchronous.

### Single API Surface (No Dual Pure/Effectful)

**Decision**: There is ONE way to build exports—through the Conjure service. No pure `conjure.export.*` fallback.

**Rationale**:
- Multiple ways to do the same thing increases cognitive load
- Plugin authors shouldn't choose between "tracked" and "untracked"
- Pure AST builders (id, obj, ts) remain available for expressions
- Exports always need tracking, so always use the service

**Implication**: Old `conjure.export.*` helpers are removed or internal-only. Plugins use `yield* Conjure` exclusively.

### Plugins Return Statements, Not RenderedSymbol

**Decision**: `render()` returns `Effect<n.Statement[]>`, not `Effect<RenderedSymbol[]>`.

**Rationale**:
- RenderedSymbol is an implementation detail (capability, imports, refs, metadata)
- Plugins shouldn't manually construct this boilerplate
- `exp.*` methods handle all tracking internally
- Statements are what plugins conceptually produce

**Implication**: `RenderedSymbol` becomes internal to the runtime. Plugins never see it.

### use() for Cross-Plugin References

**Decision**: Cross-plugin references use `use("capability")` on Conjure, not direct registry access.

```typescript
const { use } = yield* Conjure
const userSchema = use("schema:zod:User")
const validated = userSchema.consume?.(inputExpr)
```

**Rationale**:
- Single entry point for all plugin needs (AST building + cross-refs)
- Hides registry implementation from plugins
- Consistent API surface
- Reference tracking happens automatically

**Implication**: `registry.import()` becomes internal. Plugins use `use()` exclusively.

### Conjure Service Uses FiberRef for Scoping

**Decision**: The Conjure service uses FiberRef to track current plugin context, not per-plugin layers.

**Rationale**:
- FiberRef aligns with Effect idioms for contextual state
- Avoids overhead of creating new service instances per plugin
- Orchestrator updates context before each plugin runs
- Plugin code remains clean—just `yield* Conjure`

**Implication**: Orchestrator sets FiberRef before running each plugin's render. Conjure reads from FiberRef to determine capability prefixes.

### Capability Inference with Liskov Substitution

**Decision**: Capabilities are inferred from plugin provides by default. Consumer plugins reference abstract capabilities, not specific implementations.

```typescript
// Provider declares what it provides
provides: ["schema"]  // Zod plugin provides schemas

// Consumer declares what it needs (abstract)
consumes: ["schema"]  // HTTP plugin needs schemas, doesn't care if Zod or Effect Schema

// exp.* infers capability from plugin context
yield* exp.const("User", schemaExpr)  // Becomes "schema:zod:User" automatically
```

**Rationale**:
- Liskov Substitution Principle: consumers shouldn't know or care about the specific implementation
- A schema is a schema—whether Zod, Valibot, ArkType, or Effect Schema
- Reduces coupling between plugins
- Explicit override available for edge cases (multi-capability plugins)

**Implication**: Plugins providing multiple capabilities may need explicit capability in `exp.*` calls. Single-capability plugins get automatic inference.

### Plugin Return Type is Effect<n.Statement[]>

**Decision**: `render()` returns `Effect<n.Statement[]>`.

**Rationale**:
- Explicit about what's emitted
- Aids debugging—can inspect returned statements
- Enables ordering control
- Registry tracking happens via `exp.*` calls regardless

**Implication**: Plugins collect statements and return them. Both the return value AND registry contain the output (redundant but useful for debugging).

## Smart Tags

### JSON Syntax for Smart Tags

**Decision**: Smart tags use JSON in SQL comments.

```sql
COMMENT ON TABLE users IS '{ "description": "User accounts", "sourcerer": { "omit": true } }';
COMMENT ON COLUMN users.email IS '{ "description": "Primary contact email" }';
```

**Rationale**:
- JSON is universally understood, parseable, tooling-friendly
- Structured data supports complex configurations
- Clear schema: `{ description: string, sourcerer?: {...} }`
- If parse fails as JSON, treat entire comment as string description

**Implication**: Smart tag parser tries JSON first. Plain strings become `{ description: "..." }`.

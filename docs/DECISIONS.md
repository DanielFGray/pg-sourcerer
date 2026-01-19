# Design Decisions

Resolved architectural decisions with rationale. These emerged from design discussions in SYMBOLS_CONJURE_REDESIGN.md and DATA_SOURCE_AGNOSTICISM.md.

## Plugin System

### Plugins are Effect-Based

**Decision**: Plugins use Effect for all operations.

**Rationale**:
- `Effect.fn` provides automatic tracing/logging
- Services via `yield*` give clean dependency injection
- Immutable return data (SymbolDeclaration[], RenderedSymbol[]) enables validation between phases
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

## QueryIdea Design

### Flat Discriminated Union

**Decision**: QueryIdea is a discriminated union, extensible per-operation.

```typescript
type QueryIdea = 
  | FindOneIdea 
  | FindManyIdea 
  | CreateIdea 
  | UpdateIdea 
  | DeleteIdea 
  | CustomIdea
```

**Rationale**:
- Each operation variant carries operation-specific fields
- Downstream plugins can switch on operation type
- Extensible without bloating base interface

### Custom Query Support

**Decision**: Custom queries use `{ operation: "custom", name, spec }`.

**Rationale**:
- Aggregations, reports, custom joins are real needs
- Ideation plugin shouldn't invent these
- Smart tags can hint custom queries: `@query findActiveByRegion(region: text)`
- Plugins can inject custom QueryIdeas directly

**Implication**: Custom queries bypass ideation's pattern matching. They're explicit escape hatches.

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

// Query signatures reference shapes
signature.params = [{ name: "data", shape: "User:insert" }]
signature.returns = { shape: "User:row", mode: "one" }

// Schema plugins generate validators for shapes
// HTTP plugins reference schemas by shape name
```

**Rationale**:
- Shapes are computed once in IR, stable identifiers all plugins can reference
- Decouples query plugins from schema plugins from HTTP plugins
- Each plugin only needs to understand shape names, not internal structures

**Implication**: SignatureDef references shapes by name. Plugins don't pass raw field lists around.

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

### Plugin Data Flow

**Decision**: Plugins form a pipeline where each layer consumes the previous layer's **symbols**, not internal data structures.

```
IR (entities, shapes)
    ↓
Query Plugin
    provides: function symbols with SignatureDef
    SignatureDef references shapes ("User:insert", "User:row")
    ↓
Schema Plugin
    provides: schema symbols for each shape
    consumer callback: consume(input) → validated output
    ↓
HTTP Plugin
    consumes: query functions (by SignatureDef)
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

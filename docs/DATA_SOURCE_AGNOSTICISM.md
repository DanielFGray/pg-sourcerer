# Data Source Agnosticism

## Overview

pg-sourcerer is currently Postgres-focused, leveraging rich introspection (indexes, RLS, constraints, enums) for intelligent code generation. However, the plugin ecosystem shouldn't be limited to one database.

This document outlines how to maintain the power of deep introspection while enabling flexibility for other data sources—without requiring us to implement those adapters yet.

## The Tension

We want both:

1. **Power from specificity** - Postgres introspection gives us indexes, RLS policies, constraints, enum values, comments with smart tags. This richness enables smart query generation.

2. **Flexibility for others** - MySQL, SQLite, DynamoDB, even non-SQL sources (REST APIs via OpenAPI, GraphQL schemas) could benefit from the same plugin ecosystem.

## Key Insight: Introspection Quality is a Capability

The richness of introspection can be expressed through the existing capability system:

```typescript
// Postgres introspection provides rich capabilities
provides: [
  "introspection:tables",
  "introspection:columns",
  "introspection:indexes",
  "introspection:constraints",
  "introspection:foreign-keys",
  "introspection:rls-policies",
  "introspection:enums",
  "introspection:functions",
  "introspection:comments",
]

// MySQL introspection provides less
provides: [
  "introspection:tables",
  "introspection:columns",
  "introspection:indexes",
  "introspection:constraints",
  "introspection:foreign-keys",
  "introspection:enums",  // limited
]

// SQLite provides even less
provides: [
  "introspection:tables",
  "introspection:columns",
  "introspection:indexes",
]

// OpenAPI spec provides different capabilities entirely
provides: [
  "introspection:endpoints",
  "introspection:request-schemas",
  "introspection:response-schemas",
]
```

## Capability Taxonomy

### Introspection Capabilities

What the data source provides about its schema:

| Capability | Description | Postgres | MySQL | SQLite |
|------------|-------------|----------|-------|--------|
| `introspection:tables` | Tables/collections exist | ✓ | ✓ | ✓ |
| `introspection:columns` | Column names and types | ✓ | ✓ | ✓ |
| `introspection:indexes` | Index definitions | ✓ | ✓ | ✓ |
| `introspection:constraints` | CHECK, UNIQUE, etc. | ✓ | ✓ | partial |
| `introspection:foreign-keys` | FK relationships | ✓ | ✓ | ✓ |
| `introspection:enums` | Enum type definitions | ✓ | partial | ✗ |
| `introspection:functions` | Stored procedures/functions | ✓ | ✓ | ✗ |
| `introspection:rls-policies` | Row-level security | ✓ | ✗ | ✗ |
| `introspection:comments` | Column/table comments | ✓ | ✓ | ✗ |
| `introspection:smart-tags` | Parsed @tags from comments | ✓ | ✓ | ✗ |

### Generation Capabilities

What plugins produce:

| Capability | Description | Requires |
|------------|-------------|----------|
| `types` | TypeScript interfaces for entities | `introspection:tables`, `introspection:columns` |
| `query-ideas` | Proposed query patterns | `introspection:tables`, `introspection:columns` |
| `queries` | Materialized query functions | `query-ideas`, `types` |
| `schemas:zod` | Zod validation schemas | `types` |
| `schemas:effect` | Effect Schema definitions | `types` |
| `http-routes` | HTTP endpoint handlers | `queries`, `schemas:*` |
| `client-sdk` | Client-side API wrapper | `http-routes` |

## Plugin Dependency Model

### Hard vs Soft Dependencies

Extend the plugin interface with `enhancedBy`:

```typescript
interface Plugin {
  name: string
  provides: Capability[]
  
  // Hard requirement - plugin won't run without these
  consumes?: Capability[]
  
  // Soft enhancement - uses if available, degrades gracefully
  enhancedBy?: Capability[]
}
```

### Example: Query Ideation with Graceful Degradation

```typescript
export const queryIdeation: Plugin = {
  name: "query-ideation",
  provides: ["query-ideas"],
  
  // Must have basic schema info
  consumes: ["introspection:tables", "introspection:columns"],
  
  // Can generate smarter queries if these are available
  enhancedBy: [
    "introspection:indexes",
    "introspection:foreign-keys",
    "introspection:rls-policies",
  ],
  
  declare: Effect.fn("query-ideation.declare")(function* () {
    const ir = yield* IR
    const caps = yield* Capabilities
    
    const ideas: QueryIdea[] = []
    
    for (const entity of ir.entities.values()) {
      // Always: basic CRUD (any data source can do this)
      ideas.push({ entity: entity.name, operation: "findMany" })
      ideas.push({ entity: entity.name, operation: "create" })
      ideas.push({ entity: entity.name, operation: "update" })
      ideas.push({ entity: entity.name, operation: "delete" })
      
      // If we have primary key info
      if (entity.primaryKey) {
        ideas.push({
          entity: entity.name,
          operation: "findOne",
          lookupFields: entity.primaryKey,
          rationale: "primary key lookup",
        })
      }
      
      // Enhanced: index-aware lookups
      if (caps.has("introspection:indexes") && entity.indexes) {
        for (const index of entity.indexes.filter(i => i.isUnique)) {
          ideas.push({
            entity: entity.name,
            operation: "findOne",
            lookupFields: index.columns,
            rationale: `unique index: ${index.name}`,
          })
        }
      }
      
      // Enhanced: relation-aware queries
      if (caps.has("introspection:foreign-keys") && entity.relations) {
        for (const rel of entity.relations) {
          ideas.push({
            entity: entity.name,
            operation: "findMany",
            includeRelations: [rel.name],
            rationale: `eager load ${rel.name}`,
          })
        }
      }
      
      // Enhanced: RLS-aware context
      if (caps.has("introspection:rls-policies") && entity.policies) {
        // Generate tenant-scoped or user-scoped queries
      }
    }
    
    return ideas
  }),
}
```

## SemanticIR Structure

### Core vs Optional Fields

The IR should clearly separate required core from capability-gated extensions:

```typescript
interface SemanticIR {
  // === Core (all sources must provide) ===
  entities: Map<string, Entity>
  
  // === Capability-gated (may be undefined) ===
  
  // requires: introspection:indexes
  indexes?: Map<string, IndexDef>
  
  // requires: introspection:rls-policies
  policies?: Map<string, PolicyDef>
  
  // requires: introspection:functions
  functions?: Map<string, FunctionDef>
  
  // requires: introspection:enums
  enums?: Map<string, EnumDef>
  
  // === Metadata ===
  capabilities: ReadonlySet<string>
  dialect?: "postgres" | "mysql" | "sqlite" | "other"
}

interface Entity {
  // === Core ===
  name: string
  kind: "table" | "view" | "collection" | "endpoint"
  fields: Field[]
  
  // === Optional based on capabilities ===
  primaryKey?: string[]                    // most SQL sources
  indexes?: IndexDef[]                     // introspection:indexes
  constraints?: ConstraintDef[]            // introspection:constraints
  relations?: Relation[]                   // introspection:foreign-keys
  policies?: PolicyDef[]                   // introspection:rls-policies
  comment?: string                         // introspection:comments
  smartTags?: Record<string, unknown>      // introspection:smart-tags
}

interface Field {
  // === Core ===
  name: string
  type: string           // Normalized type name
  nullable: boolean
  
  // === Optional ===
  isPrimaryKey?: boolean
  isGenerated?: boolean
  hasDefault?: boolean
  defaultValue?: unknown
  comment?: string
  smartTags?: Record<string, unknown>
  
  // === Source-specific (for query building) ===
  pgType?: string        // Original Postgres type
  pgAttribute?: object   // Raw pg-introspection data
}
```

### Capabilities Service

Plugins can query what's available:

```typescript
interface Capabilities {
  has(capability: string): boolean
  all(): ReadonlySet<string>
  
  // Convenience for common checks
  hasIndexes(): boolean      // introspection:indexes
  hasRelations(): boolean    // introspection:foreign-keys
  hasRLS(): boolean          // introspection:rls-policies
  hasEnums(): boolean        // introspection:enums
}

// Usage in plugins
const caps = yield* Capabilities

if (caps.has("introspection:indexes")) {
  // Generate index-aware queries
}
```

## Introspection Adapter Interface

A clear contract for data source adapters:

```typescript
interface IntrospectionAdapter {
  name: string
  dialect: string
  
  // What this adapter can provide
  provides: readonly string[]
  
  // Perform introspection, return normalized IR
  introspect(config: AdapterConfig): Effect<SemanticIR, IntrospectionError>
}

// Example: Postgres adapter
const postgresAdapter: IntrospectionAdapter = {
  name: "postgres",
  dialect: "postgres",
  provides: [
    "introspection:tables",
    "introspection:columns",
    "introspection:indexes",
    "introspection:constraints",
    "introspection:foreign-keys",
    "introspection:enums",
    "introspection:functions",
    "introspection:rls-policies",
    "introspection:comments",
    "introspection:smart-tags",
  ],
  introspect: (config) => Effect.gen(function* () {
    // Use pg-introspection, normalize to SemanticIR
  }),
}
```

## hex Dialect Awareness

hex should be explicit about SQL dialect:

```typescript
// Option A: Dialect as parameter
const query = hex.select(ir, spec, { dialect: "postgres" })

// Option B: Dialect from IR
const query = hex.select(ir, spec)  // reads ir.dialect internally

// Option C: Dialect-specific builders
const pgHex = hex.postgres(ir)
const sqliteHex = hex.sqlite(ir)
```

Dialect affects:
- Parameter placeholder style (`$1` vs `?`)
- Type mappings
- Available features (RETURNING, ON CONFLICT, etc.)
- Generated SQL syntax

## Plugin Portability Matrix

| Plugin | Hard Requirements | Enhanced By | Portable? |
|--------|-------------------|-------------|-----------|
| `types` | tables, columns | comments | ✓ All SQL |
| `query-ideation` | tables, columns | indexes, FKs, RLS | ✓ Degrades gracefully |
| `sql-queries` | tables, columns, dialect:sql | indexes | ✓ SQL only |
| `zod-schemas` | types | - | ✓ Any source |
| `http-routes` | queries | - | ✓ Any source |
| `rls-queries` | tables, rls-policies | - | ✗ Postgres only |

## Concrete Refactors

### Phase 1: Foundation (Do Now)

1. **Audit SemanticIR** - Mark PG-specific fields as optional, add `capabilities` set
2. **Add `enhancedBy` to Plugin interface** - Soft dependencies
3. **Add `Capabilities` service** - Let plugins query what's available
4. **Document capability taxonomy** - This doc

### Phase 2: Boundaries (Do Soon)

5. **Separate introspection from IR building** - Clear adapter interface
6. **Audit hex for dialect assumptions** - Make explicit or parameterized
7. **Audit plugins for graceful degradation** - Use `enhancedBy` pattern

### Phase 3: Validation (Do When Adding Sources)

8. **Add SQLite adapter** - Simpler, validates the abstraction
9. **Add MySQL adapter** - Similar to PG, tests capability differences
10. **Add OpenAPI adapter** - Different domain, tests flexibility

## Design Principles

1. **Postgres is first-class, not special-cased** - It just provides more capabilities
2. **Capability presence, not source identity** - Plugins check `caps.has("indexes")`, not `dialect === "postgres"`
3. **Graceful degradation over hard failure** - Generate simpler code when info unavailable
4. **Core IR is minimal** - Only what ALL sources can provide
5. **Extensions are explicit** - Optional fields tied to capabilities
6. **No phantom abstractions** - Don't build adapters we don't need yet

## Related Documents

- **[DECISIONS.md](./DECISIONS.md)** - Resolved decisions including data source agnosticism choices
- **[OPEN_QUESTIONS.md](./OPEN_QUESTIONS.md)** - Deferred items including non-SQL sources

## Success Criteria

1. **SemanticIR has explicit core vs optional fields** - Clear contract
2. **Plugins can query capabilities** - `yield* Capabilities`
3. **Plugins use `enhancedBy` for graceful degradation** - Smart but flexible
4. **hex is dialect-aware** - Explicit, not assumed
5. **Adding a new SQL dialect is straightforward** - Just implement adapter interface
6. **Existing plugins work with less-capable sources** - Graceful degradation

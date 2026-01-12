# Plugin Architecture Redesign

## Overview

A ground-up redesign of the plugin system based on first principles. Plugins become pure-ish functions that declare symbols and render bodies in two distinct phases.

**Scope**: Postgres-specific, full-stack from query to symbol. We embrace Postgres-specific information (types, indexes, constraints) as a feature, not a limitation.

**Branch**: `feature/symbols-conjure-redesign`
**Exploration branch** (for reference): `explore/conjure-registry-v1`

## Core Principles

1. **Plugins transform data** - Input data in, output data out. Runtime handles side effects.
2. **Two-phase execution** - Declare what exists, then render bodies. Enables validation and cross-plugin references.
3. **Symbols are the real output** - Files are just serialization of symbols.
4. **Config controls file layout** - Plugins don't hardcode paths.
5. **Postgres-focused** - Leverage PG-specific features (types, indexes, JSONB, arrays) rather than abstracting them away.

## Architecture Layers

```
PostgreSQL Schema
       │
       ▼
┌─────────────────┐
│  Introspection  │  PG types, indexes, constraints, comments
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   SemanticIR    │  Entities, fields, relations, enums
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌───────┐ ┌─────────┐
│  hex  │ │ conjure │
│ (SQL) │ │(symbols)│
└───┬───┘ └────┬────┘
    │          │
    └────┬─────┘
         │
         ▼
┌─────────────────┐
│   Shared Types  │  QueryDescriptor, ParamDescriptor, TypeRef
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│     Plugins     │  Declare symbols, render bodies
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│      Emit       │  TypeScript files with correct imports
└─────────────────┘
```

### Layer Responsibilities

| Layer | Owns | Produces |
|-------|------|----------|
| **Introspection** | Database connection, pg-introspection | Raw PG metadata |
| **SemanticIR** | Schema interpretation | Entities, fields, relations, enums |
| **hex** | SQL query building | `QueryDescriptor` (SQL + return type info) |
| **conjure** | Symbol coordination | Signatures, type refs, AST helpers |
| **Shared Types** | Vocabulary between hex/conjure | Descriptors, converters |
| **Plugins** | Business logic | Symbol declarations + rendered bodies |
| **Emit** | File writing | TypeScript source files |

## hex + conjure Integration

hex and conjure are separate but share types. Neither depends on the other.

### Shared Types

```typescript
// shared/query-types.ts

interface QueryDescriptor {
  sql: SqlTemplate
  params: ParamDescriptor[]
  returns: ReturnDescriptor
}

interface ParamDescriptor {
  name: string
  pgType: string              // int4, text, uuid, etc.
  source?: "pk" | "fk" | "lookup" | "body"
  nullable?: boolean
  schema?: Schema<any, any>   // Effect Schema for encode/decode
}

type ReturnDescriptor =
  | { kind: "entity"; entity: string; fields?: string[] }  // SELECT * or subset
  | { kind: "scalar"; pgType: string }                     // COUNT(*) → bigint
  | { kind: "void" }                                       // INSERT without RETURNING

// Pure converter: QueryDescriptor → signature parts
function queryToSignature(
  query: QueryDescriptor,
  ir: SemanticIR
): { params: ParamDef[]; returns: ReturnDef }
```

### hex Produces QueryDescriptor

```typescript
// hex knows what the query returns
const query: QueryDescriptor = hex
  .select("users", ["id", "name", "email"])
  .where("id", "=", param("id", "uuid"))
  .single()    // Returns one row or null
  .build()

// query = {
//   sql: "SELECT id, name, email FROM users WHERE id = $1",
//   params: [{ name: "id", pgType: "uuid", source: "pk" }],
//   returns: { kind: "entity", entity: "User", fields: ["id", "name", "email"] }
// }
```

### Plugin Converts to Symbols

```typescript
declare(input) {
  const query = hex.select("users").where("id", "=", param("id")).single().build()
  const { params, returns } = queryToSignature(query, input.ir)

  return [{
    name: "findUserById",
    capability: "queries",
    kind: "function",
    entity: "User",
    signature: sig({ params, returns }),
    metadata: { query },  // Keep for render phase
  }]
}

render(input) {
  return input.own.map(decl => {
    const { query } = decl.metadata as { query: QueryDescriptor }
    return {
      ref: decl,
      body: buildQueryFunction(query),  // Uses query.sql
      externalImports: [{ from: "pg", names: ["sql"] }],
    }
  })
}
```

### Smart Query Generation

With hex knowing about IR, we can generate intelligent queries:

1. **Index-aware** - Generate queries that use available indexes
2. **Type-safe params** - Params carry PG type info → flow to conjure signatures
3. **Return shape inference** - `SELECT *` → all columns, `SELECT id, name` → subset
4. **Aggregate awareness** - `COUNT(*)` returns `bigint`, not row type
5. **Effect Schema integration** - Encode/decode for runtime type safety

## Constraints (What Forced These Decisions)

| Constraint | Implication |
|------------|-------------|
| Plugins depend on other plugins' output | Ordered execution, capability system |
| Generated code must type-check | Import resolution mandatory, AST over strings |
| Users control output structure | Config decides file paths, not plugins |
| Validation after all plugins | Need complete symbol graph before rendering |
| hex produces SQL, shouldn't know about TS AST | Shared types as bridge |
| conjure tracks symbols, shouldn't parse SQL | Shared types as bridge |
| Both need IR types | Shared vocabulary referencing entities/fields |

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

```typescript
interface Plugin<Config = unknown> {
  name: string
  capabilities: {
    provides: Capability[]
    consumes: Capability[]
  }
  configSchema?: Schema<Config>

  // Phase 1: Declare what symbols exist
  declare(input: DeclareInput<Config>): SymbolDeclaration[]

  // Phase 2: Render symbol bodies
  render(input: RenderInput<Config>): RenderedSymbol[]
}
```

### Phase 1: Declare

```typescript
interface DeclareInput<Config> {
  ir: SemanticIR
  config: Config
  deps: DepsQuery  // Symbols from consumed capabilities
}

interface SymbolDeclaration {
  name: string
  capability: Capability      // name + capability = unique identity
  kind: SymbolKind
  entity?: string             // Associated entity (e.g., "User")
  signature?: SignatureDef    // For functions
  metadata?: unknown          // Plugin-specific, passed back in render
}

interface DepsQuery {
  get(ref: SymbolRef): SymbolDeclaration | undefined
  filter(query: { capability?: Cap, entity?: string, kind?: Kind }): SymbolDeclaration[]
  all(capability: Capability): SymbolDeclaration[]
}
```

**Key**: Deps are available in declare phase. Plugins can conditionally declare based on what other plugins provide.

### Phase 2: Render

```typescript
interface RenderInput<Config> extends DeclareInput<Config> {
  symbols: SymbolRegistry     // Complete graph from all plugins
  files: FileAssignments      // Where each symbol lands
  own: SymbolDeclaration[]    // This plugin's declarations (with metadata)
}

interface RenderedSymbol {
  ref: SymbolRef              // { name, capability }
  body: AST
  externalImports?: ImportSpec[]  // e.g., { from: "kysely", names: ["Kysely"] }
}
```

### Symbol Handles

When querying the registry in render phase, you get `SymbolHandle` objects:

```typescript
interface SymbolHandle extends SymbolDeclaration {
  ref(): n.Identifier              // Returns AST, tracks reference
  call(args: AST[]): n.CallExpression  // Returns call AST, tracks reference
  typeRef(): n.TSTypeReference     // For type symbols
}
```

Calling `.ref()` or `.call()` records the cross-reference. Runtime uses this to auto-generate imports between files.

## Conjure SDK

Conjure is the plugin authoring toolkit. All helpers, no state (state is in runtime).

```typescript
import { conjure } from "pg-sourcerer"
const { ts, types, param, returns, sig, b } = conjure
```

### Namespaces

| Namespace | Purpose |
|-----------|---------|
| `ts.*` | AST type builders |
| `types.*` | Smart type resolution from fields/PG types |
| `param.*` | Parameter definition builders |
| `returns.*` | Return type builders |
| `sig()` | Combine params + returns into signature |
| `b.*` | Expression/statement AST builders |

### Type Resolution (`types.*`)

```typescript
types.fromField(field: Field, ir: SemanticIR): TypeRef
types.fromPg(typeName: string): TypeRef
types.ref(name: string, capability?: Capability): TypeRef

// TypeRef is a symbolic reference that:
// - Resolves to AST at emit time
// - Automatically tracks as cross-reference when used
```

### Signature Helpers

```typescript
// Parameters
param.pk(name: string, type: TypeRef): ParamDef
param.fk(name: string, type: TypeRef): ParamDef
param.body(name: string, type: TypeRef): ParamDef
param.connection(name: string, type: TypeRef): ParamDef

// Returns
returns.single(type: TypeRef, opts?: { nullable?: boolean }): ReturnDef
returns.array(type: TypeRef): ReturnDef
returns.void(): ReturnDef

// Combine
sig({ params: ParamDef[], returns: ReturnDef }): SignatureDef
```

## Example Plugin

```typescript
import { conjure, definePlugin } from "pg-sourcerer"
import { hex, queryToSignature } from "pg-sourcerer/hex"

const { ts, types, param, returns, sig, b } = conjure

export const sqlQueriesPlugin = definePlugin({
  name: "sql-queries",
  capabilities: {
    provides: ["queries"],
    consumes: ["types"],
  },

  declare(input) {
    const { ir, deps } = input
    const declarations: SymbolDeclaration[] = []

    for (const entity of ir.entities.values()) {
      const pkField = entity.fields.find(f => f.isPrimaryKey)
      if (!pkField) continue

      const typeSymbol = deps.get({ name: entity.name, capability: "types" })
      if (!typeSymbol) continue

      // hex builds the query and knows return type
      const query = hex
        .select(entity.tableName)
        .where(pkField.columnName, "=", hex.param("id", pkField.pgType))
        .single()
        .build()

      const { params, returns: ret } = queryToSignature(query, ir)

      declarations.push({
        name: `find${entity.name}ById`,
        capability: "queries",
        kind: "function",
        entity: entity.name,
        signature: sig({ params, returns: ret }),
        metadata: { query, typeSymbol },
      })
    }

    return declarations
  },

  render(input) {
    const { own, symbols } = input

    return own.map(decl => {
      const { query } = decl.metadata as { query: QueryDescriptor }

      return {
        ref: { name: decl.name, capability: decl.capability },
        body: b.arrowFunction(
          decl.signature!.params.map(p => b.param(p.name, p.type)),
          b.sql(query.sql)  // Renders the SQL template
        ),
        externalImports: [{ from: "pg", names: ["sql"] }],
      }
    })
  },
})
```

## File Layout Configuration

Config controls where symbols land:

```typescript
// sourcerer.config.ts
export default {
  output: {
    // Preset strategies
    layout: "by-capability",  // or "by-entity", "single-file"

    // Or explicit per-capability
    paths: {
      types: "types.ts",
      queries: "queries/${entity}.ts",  // Template with entity name
      zod: "schemas/zod.ts",
      http: "api/routes.ts",
    },
  },
}
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
returns.single(types.ref("User", "types"), { nullable: true })
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

| Aspect | Current | New |
|--------|---------|-----|
| Plugin API | Effect-based, mutates shared state | Pure-ish, returns data |
| Execution | Single pass | Two phases (declare → render) |
| Cross-plugin refs | Runtime lookup by name | Explicit handles with reference tracking |
| File paths | Plugin decides | Config decides |
| Validation | During execution | Between phases |
| Import resolution | Manual | Automatic from handle usage |
| Query building | Inline in plugins | hex produces QueryDescriptor |

## Supersedes

This design supersedes:
- **ep-f39a14** (Plugin Coordination Refactor) - ResourceProvider model was more abstract but less powerful
- **ep-933e05** (v0.4 Pull-Based Interop) - Core ideas preserved, but implementation approach changed

Key differences from ResourceProvider:
- Symbols as universal currency vs opaque resources
- Two explicit phases vs single provide() with request()
- hex as SQL layer vs plugins building SQL inline

## Implementation Plan

### Approach: Nuke + Rewrite + Experiment

Rather than incremental refactoring, we:
1. **Nuke** old plugin infrastructure (it's in git if we need it)
2. **Rewrite** core runtime from scratch based on this design
3. **Experiment** with `bun -e` and mock plugins before touching real plugins
4. **Promote** successful experiments to integration tests

This is faster than refactoring 1800+ lines of tightly-coupled code.

### Files to Nuke

| File | Lines | Reason |
|------|-------|--------|
| `services/plugin.ts` | 593 | Old plugin interface |
| `services/plugin-runner.ts` | ~300 | Single-pass execution |
| `services/resolution.ts` | ~200 | ResourceProvider model |
| `services/execution.ts` | ~200 | ResourceProvider execution |
| `services/core-providers.ts` | ~100 | Old provider registration |
| `services/symbols.ts` | ~300 | String-based types |
| `services/artifact-store.ts` | ~150 | May not need |

**~1850 lines to delete**

### Files to Keep

| Category | Files | Reuse % |
|----------|-------|---------|
| AST/SQL | `lib/conjure.ts`, `lib/hex.ts` | 90% |
| IR | `ir/*`, `services/ir-builder.ts` | 95% |
| Introspection | `services/introspection.ts`, `services/smart-tags-parser.ts` | 95% |
| Services | `services/inflection.ts`, `services/emissions.ts`, `services/file-writer.ts`, `services/file-builder.ts` | 90% |
| Config/CLI | `config.ts`, `cli.ts`, `errors.ts` | 80% |

### Files to Create

| File | Purpose |
|------|---------|
| `runtime/types.ts` | Plugin interface, SymbolDeclaration, RenderedSymbol |
| `runtime/registry.ts` | SymbolRegistry, DepsQuery, SymbolHandle |
| `runtime/orchestrator.ts` | Two-phase execution (declare → validate → assign → render → emit) |
| `runtime/validation.ts` | Capability checks, collision detection |
| `runtime/file-assignment.ts` | Config-driven file path resolution |
| `shared/query-types.ts` | QueryDescriptor, ParamDescriptor, ReturnDescriptor |
| `shared/converters.ts` | queryToSignature() and friends |
| `conjure/types.ts` | types.fromField(), types.ref() |
| `conjure/signature.ts` | param.*, returns.*, sig() |
| `conjure/index.ts` | Unified conjure export |

### Phase 1: Foundation (No Plugins Yet)

1. **Nuke old files** - Delete the 7 files listed above
2. **Create runtime types** - Plugin interface, symbol types
3. **Create registry** - SymbolRegistry with sync queries
4. **Create orchestrator** - Two-phase execution skeleton
5. **Extend hex** - Add QueryDescriptor output

**Validation**: `bun -e` scripts with mock plugins that:
- Declare symbols
- Query deps
- Render bodies
- Verify import tracking works

### Phase 2: Mock Plugin Experiments

Before touching real plugins, validate the API with throwaway scripts:

```bash
# Experiment: Can two mock plugins coordinate?
bun -e "
import { definePlugin, runPlugins } from './src/runtime'

const typesPlugin = definePlugin({
  name: 'types',
  provides: ['types'],
  declare: (input) => [{ name: 'User', capability: 'types', kind: 'type' }],
  render: (input) => [{ ref: { name: 'User', capability: 'types' }, body: ... }],
})

const queriesPlugin = definePlugin({
  name: 'queries', 
  provides: ['queries'],
  consumes: ['types'],
  declare: (input) => {
    const userType = input.deps.get({ name: 'User', capability: 'types' })
    return [{ name: 'findUser', ... }]
  },
  render: (input) => ...
})

const result = runPlugins([typesPlugin, queriesPlugin], mockIR)
console.log(result.files)
"
```

**Successful experiments → integration tests**

### Phase 3: Migrate Real Plugins

Once the runtime is validated with mocks:

1. **types.ts** - Simplest, good first test
2. **zod.ts** - Schema plugin pattern
3. **sql-queries.ts** - Query plugin with hex integration
4. **http-hono.ts** - Consumer plugin pattern

Each migration:
- Extract generation logic from old plugin
- Wrap in new Plugin interface
- Delete old plugin when new one works

### Phase 4: Cleanup

1. Remove any remaining old infrastructure
2. Update exports in `index.ts`
3. Update CLI to use new runtime
4. Update tests

## Open Questions

### 1. Effect in plugin interface?

Current design is synchronous. Do we need Effect for:
- Async operations in plugins?
- Error handling?

**Tentative answer**: Keep plugins sync. If async needed, can wrap in Effect at runtime.

### 2. Effect Schema in descriptors

Should `ParamDescriptor` and `ReturnDescriptor` carry Effect Schemas for encode/decode?

**Tentative answer**: Yes, optional. Enables runtime validation matching compile-time types.

### 3. hex API design

Current hex is template-based. Should it become a full query builder?

**Tentative answer**: Incremental. Start with current hex + metadata, evolve as needed.

### 4. Incremental regeneration

Future concern: Can we re-run only affected plugins when schema changes?

**Tentative answer**: Symbol identity + file assignments enable this, but defer to future.

## Success Criteria

1. Plugins are easier to write (less boilerplate)
2. Cross-plugin references "just work" (no manual import tracking)
3. Validation catches errors before rendering
4. Config controls file layout without plugin changes
5. Generated code type-checks
6. hex queries flow seamlessly into conjure symbols
7. Postgres-specific features (indexes, types) inform generation

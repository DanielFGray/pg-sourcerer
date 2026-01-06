# Agent Notes for pg-sourcerer

## Tooling

- **Bun** - Runtime and package manager. Never use `npm` or `npx`.
- **Vitest + @effect/vitest** - Testing framework with Effect integration
- **Effect-ts** - Core framework for services, errors, and composition

### Running Tests
```bash
cd packages/sourcerer-rewrite
bun run test     # never `bun test`
bun test:watch  # Watch mode
bun typecheck   # Type check without emit
```

## Key Libraries

### Effect-ts
- Docs: Query Context7 with library ID `/effect-ts/effect` or `/llmstxt/effect_website_llms-full_txt`
- Key patterns used:
  - `Context.Tag` for service definitions
  - `Layer` for dependency injection
  - `Effect.gen` for generator-based effects
  - `Data.TaggedError` for typed errors
  - `Schema` for validation (use `S.optionalWith({ default: () => value })` for defaults)

### @effect/vitest
- Import `{ it, describe, expect, layer }` from `@effect/vitest`
- Use `it.effect("name", () => Effect.gen(...))` for effect tests
- Use `layer(MyLayer)("suite name", (it) => { ... })` to provide layers to test suites
- The `it` inside layer callback has the layer's services available

### pg-introspection
- Provides `PgAttribute`, `PgClass`, `PgType`, `PgConstraint`, etc.
- **Important patterns:**
  ```typescript
  // Get type from attribute (NOT attr.type)
  const pgType = pgAttribute.getType()
  
  // Check for arrays
  const isArray = pgType?.typcategory === 'A'
  
  // Get enum values
  const isEnum = pgType?.typtype === 'e'
  const values = pgType?.getEnumValues()
  
  // Get table columns
  const columns = pgClass.getAttributes().filter(a => a.attnum > 0)
  
  // Get foreign keys
  const fks = pgClass.getConstraints().filter(c => c.contype === 'f')
  ```

## Architecture Overview

See `/ARCHITECTURE.md` in the repo root for the full plan.

### Core Principle
**The core plugin system shouldn't know what it's generating.** Core orchestrates plugins that declare capabilities and dependencies.

### IR Structure

```
SemanticIR
├── entities: Map<string, Entity>
│   └── Entity
│       ├── shapes: { row, insert?, update?, patch? }
│       │   └── Shape { fields: Field[] }
│       └── relations: Relation[]
├── enums: Map<string, EnumDef>
└── artifacts: Map<CapabilityKey, Artifact>
```

### Error Types (all defined in errors.ts)

- Config: `ConfigNotFound`, `ConfigInvalid`
- Database: `ConnectionFailed`, `IntrospectionFailed`
- Tags: `TagParseError`
- Plugins: `CapabilityNotSatisfied`, `CapabilityConflict`, `CapabilityCycle`, `PluginConfigInvalid`, `PluginExecutionFailed`
- Emission: `EmitConflict`, `WriteError`

## Testing Patterns

### Basic Effect Test
```typescript
it.effect("description", () =>
  Effect.gen(function* () {
    const result = yield* someEffect
    expect(result).toBe(expected)
  })
)
```

### Test with Layer
```typescript
layer(MyServiceLayer)("suite name", (it) => {
  it.effect("has access to service", () =>
    Effect.gen(function* () {
      const svc = yield* MyService
      // use svc
    })
  )
})
```

### Creating Test IR
```typescript
import { createIRBuilder, freezeIR } from "../index.js"

const builder = createIRBuilder(["public"])
// Add entities, enums to builder
const ir = freezeIR(builder)
```

### Stub Plugin Context for Unit Tests
```typescript
import { createStubPluginContext } from "../index.js"

const ctx = createStubPluginContext(ir, "test-plugin")
// ctx has all services stubbed for isolation
```

## File Organization

```
src/
├── index.ts           # Public API exports
├── errors.ts          # All TaggedError types
├── config.ts          # Config schema
├── ir/
│   ├── index.ts       # Re-exports
│   ├── smart-tags.ts  # SmartTags Effect Schema
│   └── semantic-ir.ts # IR types and builder
└── services/
    ├── index.ts       # Re-exports
    ├── inflection.ts  # Naming service
    ├── type-hints.ts  # Type override registry
    ├── symbols.ts     # Symbol registry for imports
    ├── emissions.ts   # Output buffer
    ├── plugin-context.ts  # What plugins receive
    └── plugin-runner.ts   # Plugin orchestration
```

## ⚠️ Effect Code: Read the Style Guide First

**MANDATORY**: Read `/EFFECT_STYLE.md` before writing or modifying Effect code.

Effect has specific idioms that differ from typical TypeScript. The style guide covers:
- Method `.pipe()` vs function `pipe()` (critical distinction)
- Import conventions (no single-letter abbreviations)
- Functional patterns (`Effect.reduce`, find-first, `Effect.if`)
- Anti-patterns and how to fix them
- Service and error definitions

### Quick Rules (see EFFECT_STYLE.md for full details)

```typescript
// ✅ Effect values: method-style .pipe()
buildProviderMap(plugins).pipe(Effect.flatMap(...))

// ✅ Pure data: function pipe()
const names = pipe(plugins, Array.map(p => p.name))

// ✅ Full import names
import { Array, HashMap, Option } from "effect"

// ❌ Never abbreviate
import { Array as A } from "effect"  // NO
```

## Reminders

1. **Stub first** - Get the wiring right before implementing logic
2. **Use Effect patterns** - Services via Context.Tag, errors via TaggedError
3. **Think functionally** - Data transformations, not imperative steps
4. **Test with @effect/vitest** - Use `it.effect` and `layer()`
5. **Check ARCHITECTURE.md** - For design decisions and open questions
6. **Query Context7** - For Effect-ts API questions
7. **No barrel files** - Import directly from source files, not through index.ts re-exports. Barrel files slow down TypeScript.

## ⚠️ CRITICAL: Task Tracking

**NEVER use TodoWrite/TodoRead** - These are disabled for this project.

**Use beads MCP tools ONLY** for all task tracking:
- `beads_ready()` - Find available work
- `beads_list()` - List issues with filters
- `beads_show()` - View task details  
- `beads_update()` - Update status/fields
- `beads_close()` - Complete a task
- `beads_create()` - Create new tasks

Do NOT use bash `bd` CLI commands. Use the MCP tools directly.

## Beads Workflow

Tasks are tracked in beads. **Always use beads MCP tools directly** - e.g., `beads_ready()`, `beads_update()`, `beads_close()` (do not use bash for beads)

```bash
# Check what's ready to work on
beads_ready()

# See all rewrite tasks
beads_list(labels=["rewrite"])

# Show task details
beads_show(issue_id="pg-sourcerer-xxx")

# Start working on a task
beads_update(issue_id="pg-sourcerer-xxx", status="in_progress")

# Complete a task
beads_close(issue_id="pg-sourcerer-xxx", reason="Description of what was done")
```

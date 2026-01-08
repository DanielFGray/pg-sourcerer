# Agent Notes for pg-sourcerer

## Tooling

- **Bun** - Runtime and package manager. Never use `npm` or `npx`.
- **Vitest + @effect/vitest** - Testing framework with Effect integration
- **Effect-ts** - Core framework for services, errors, and composition

### Running Tests
```bash
cd packages/pg-sourcerer
bun run test     # never `bun test`
bun run test:watch  # Watch mode
bun run typecheck   # Type check without emit
```

### Database for Integration Tests
Some tests require the example PostgreSQL database. To start it:
```bash
cd packages/example && bun db:ensure
```
This runs Docker, initializes database, applies migrations, and post-migration hook runs the generate script. The database stays running for subsequent test runs.

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

See `./docs/ARCHITECTURE.md` in the repo root for the full plan.

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
packages/pg-sourcerer/src/
├── index.ts              # Public API exports
├── cli.ts                # CLI entry point (@effect/cli)
├── generate.ts           # Main orchestration function
├── errors.ts             # All TaggedError types
├── config.ts             # Config schema
├── testing.ts            # Test utilities
├── ir/
│   ├── index.ts          # Re-exports
│   ├── smart-tags.ts     # SmartTags Effect Schema
│   └── semantic-ir.ts    # IR types and builder
├── lib/
│   └── conjure.ts        # AST builders for code generation
├── plugins/
│   ├── types.ts          # TypeScript types plugin
│   └── zod.ts            # Zod schema plugin
└── services/
    ├── artifact-store.ts # Plugin artifact storage
    ├── config-loader.ts  # Config file discovery/loading
    ├── emissions.ts      # Output buffer for generated files
    ├── file-builder.ts   # AST file construction helpers
    ├── file-writer.ts    # Writes emissions to disk
    ├── imports.ts        # Import statement helpers
    ├── inflection.ts     # Naming conventions service
    ├── introspection.ts  # Database introspection
    ├── ir-builder.ts     # Builds SemanticIR from introspection
    ├── ir.ts             # IR access service
    ├── pg-types.ts       # PostgreSQL type mapping
    ├── plugin-meta.ts    # Plugin metadata helpers
    ├── plugin-runner.ts  # Plugin orchestration
    ├── plugin.ts         # Plugin definition helpers
    ├── smart-tags-parser.ts # Parse @tags from comments
    ├── symbols.ts        # Symbol registry for imports
    └── type-hints.ts     # User type overrides
```

## ⚠️ Effect Code: Read the Style Guide First

**MANDATORY**: Read `./docs/EFFECT_STYLE.md` before writing or modifying Effect code.

Effect has specific idioms that differ from typical TypeScript. The style guide covers:
- Method `.pipe()` vs function `pipe()` (critical distinction)
- Import conventions (no single-letter abbreviations)
- Functional patterns (`Effect.reduce`, find-first, `Effect.if`)
- Anti-patterns and how to fix them
- Service and error definitions

### Quick Rules (see ./docs/EFFECT_STYLE.md for full details)

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
5. **Check ./docs/ARCHITECTURE.md** - For design decisions and open questions
6. **Query Context7** - For Effect-ts API questions
7. **No barrel files** - Import directly from source files, not through index.ts re-exports. Barrel files slow down TypeScript.

## ⚠️ CRITICAL: Decision Making

**ALWAYS defer to the user on design decisions.**

When you identify multiple approaches/options:
1. **STOP** - Do not pick one and proceed
2. **Present the options clearly** - Brief description of each, with your recommendation if you have one
3. **Wait for user input** - Let the user decide which approach to take

This applies to:
- Architecture choices
- API design decisions  
- Implementation strategies
- Naming conventions
- Any situation with 2+ reasonable paths forward

Do NOT make assumptions about user preferences. Ask first.

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

<!-- bv-agent-instructions-v1 -->

---

## Beads Workflow Integration

This project uses [beads_viewer](https://github.com/Dicklesworthstone/beads_viewer) for issue tracking. Issues are stored in `.beads/` and tracked in git.

### Essential Commands

```bash
# View issues (launches TUI - avoid in automated sessions)
bv

# CLI commands for agents (use these instead)
bd ready              # Show issues ready to work (no blockers)
bd list --status=open # All open issues
bd show <id>          # Full issue details with dependencies
bd create --title="..." --type=task --priority=2
bd update <id> --status=in_progress
bd close <id> --reason="Completed"
bd close <id1> <id2>  # Close multiple issues at once
bd sync               # Commit and push changes
```

### Workflow Pattern

1. **Start**: Run `bd ready` to find actionable work
2. **Claim**: Use `bd update <id> --status=in_progress`
3. **Work**: Implement the task
4. **Complete**: Use `bd close <id>`
5. **Sync**: Always run `bd sync` at session end

### Key Concepts

- **Dependencies**: Issues can block other issues. `bd ready` shows only unblocked work.
- **Priority**: P0=critical, P1=high, P2=medium, P3=low, P4=backlog (use numbers, not words)
- **Types**: task, bug, feature, epic, question, docs
- **Blocking**: `bd dep add <issue> <depends-on>` to add dependencies

### Session Protocol

**Before ending any session, run this checklist:**

```bash
git status              # Check what changed
git add <files>         # Stage code changes
bd sync                 # Commit beads changes
git commit -m "..."     # Commit code
bd sync                 # Commit any new beads changes
git push                # Push to remote
```

### Best Practices

- Check `bd ready` at session start to find available work
- Update status as you work (in_progress → closed)
- Create new issues with `bd create` when you discover tasks
- Use descriptive titles and set appropriate priority/type
- Always `bd sync` before ending session

## Priority Rules: Core > Plugins

**Core issues take priority over plugin issues at every priority level.**

### Priority Definitions

| Priority | Core Examples | Plugin Examples |
|----------|---------------|-----------------|
| **P1** | Infrastructure, test coverage, foundation | Critical bug fixes only |
| **P2** | Code quality, refactoring | Important features, stable plugins |
| **P3** | Documentation, polish | Advanced features, non-blocking |
| **P4** | Nice-to-have cleanup | Experimental plugins |

### Rule Application

- When choosing between P1 core vs P1 plugin → Pick core
- Core P2 issues may take priority over plugin P1 bugs if core blocks others
- Plugin issues should rarely be P1 unless they block core development

<!-- end-bv-agent-instructions -->

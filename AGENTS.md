# Agent Notes for pg-sourcerer

## Workspace Structure

This is a monorepo with two packages:

- **`packages/pg-sourcerer`** - The main library. Introspects PostgreSQL, builds IR, runs plugins, emits code.
- **`packages/example`** - Demo app that uses pg-sourcerer. Has a Docker PostgreSQL database, migrations, and sample config.

### Common Workflows

**Making changes to pg-sourcerer:**
```bash
cd packages/pg-sourcerer
bun run build          # Compile TypeScript
bun run test           # Run unit tests
```

**Testing changes end-to-end:**
```bash
cd packages/example
bun db:ensure          # Start DB if needed (requires Docker)
bun run generate       # Run code generation with your changes
```

**Running integration tests** (requires database):
```bash
cd packages/example && bun db:ensure
cd packages/pg-sourcerer && bun run test:integration
```

### Environment Setup

The example package needs a `.env` file with database credentials. If missing:
```bash
cd packages/example && bun run init   # Creates .env, starts DB, runs migrations
```

Scripts in `packages/example` use `bun --env-file=.env` to load environment variables.

### Build Dependencies

- `ast-types` must match the version used by `recast` (currently `^0.16.1`). Version mismatch causes type incompatibility errors.
- The `bin/pgsourcerer` wrapper uses Node shebang for portability; dev scripts use Bun.

## Git Branching Strategy

**Work on `develop`, release to `main`.**

- Main worktree stays on `develop` branch for day-to-day work
- CI runs tests on PRs and main pushes
- CI publishes to npm on every main push (version must be bumped first)

### Releasing to main

```bash
# 1. Bump version in packages/pg-sourcerer
cd packages/pg-sourcerer && npm version patch  # or minor/major

# 2. Commit and push to develop
git add -A && git commit -m "chore: bump version" && git push

# 3. Merge to main
git checkout main
git merge develop -m "Release $(npm pkg get version -w packages/pg-sourcerer | tr -d '\"')"
git push
git checkout develop
```

### Syncing main→develop

When changes are made directly to main (hotfixes, CI updates, etc.):

```bash
git checkout develop
git merge origin/main -m "Merge main into develop"
git push
```

## Tooling

- **Bun** - Runtime and package manager. Never use `npm` or `npx`.
- **Vitest + @effect/vitest** - Testing framework with Effect integration
- **Effect-ts** - Core framework for services, errors, and composition
- **effect-solutions** - CLI for browsing Effect best practices documentation

### learning about effect

Browse Effect patterns and best practices from the terminal:

```bash
effect-solutions list
effect-solutions show basics services-and-layers error-handling testing
effect-solutions search retry
```

`context7` can also help, see also effect source at ~/.local/share/effect-solutions/effect/

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
  const pgType = pgAttribute.getType();

  // Check for arrays
  const isArray = pgType?.typcategory === "A";

  // Get enum values
  const isEnum = pgType?.typtype === "e";
  const values = pgType?.getEnumValues();

  // Get table columns
  const columns = pgClass.getAttributes().filter(a => a.attnum > 0);

  // Get foreign keys
  const fks = pgClass.getConstraints().filter(c => c.contype === "f");
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
    const result = yield* someEffect;
    expect(result).toBe(expected);
  }),
);
```

### Test with Layer

```typescript
layer(MyServiceLayer)("suite name", it => {
  it.effect("has access to service", () =>
    Effect.gen(function* () {
      const svc = yield* MyService;
      // use svc
    }),
  );
});
```

### Creating Test IR

```typescript
import { createIRBuilder, freezeIR } from "../index.js";

const builder = createIRBuilder(["public"]);
// Add entities, enums to builder
const ir = freezeIR(builder);
```

### Stub Plugin Context for Unit Tests

```typescript
import { createStubPluginContext } from "../index.js";

const ctx = createStubPluginContext(ir, "test-plugin");
// ctx has all services stubbed for isolation
```

## Code Organization (Conceptual)

**`packages/pg-sourcerer/src/`**

- **Public API** (`index.ts`) - Exports for library consumers: `defineConfig`, plugins, types
- **CLI** (`cli.ts`) - Command-line entry point using `@effect/cli`
- **IR layer** (`ir/`) - Semantic representation of database schema: entities, shapes, fields, relations
- **Services** (`services/`) - Effect services for each concern: config loading, introspection, file writing, inflection
- **Plugins** (`plugins/`) - Code generators: arktype, zod, kysely, trpc, etc. Each declares capabilities and dependencies.
- **Conjure** (`conjure/`) - AST builder DSL for generating TypeScript/JavaScript code via recast
- **Runtime** (`runtime/`) - Plugin orchestration, symbol registry, validation, emission

**Key abstractions:**
- **Entity** - A database table mapped to TypeScript types
- **Shape** - A variant of an entity (row, insert, update, patch)
- **Field** - A column with type info and metadata
- **Capability** - What a plugin provides (e.g., "zod:schema", "kysely:types")
- **Symbol** - A named export that plugins register and reference

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

## ⚠️ CRITICAL: Git Safety

**NEVER commit git submodules** without explicit user direction. The `vendor/` directory may contain local submodule checkouts for development - these should not be committed.

Before committing, verify no submodules are staged:

```bash
git diff --cached --diff-filter=A | grep "^+Subproject"  # Should be empty
```

**NEVER use `git stash`** without explicit user permission. Stashes can be compacted/lost, and subsequent agents may not know to pop them - resulting in work on the wrong working tree state. If you need to test baseline behavior, use `git diff` to save changes to a file, or ask the user first.

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

**Use prog CLI** for all task tracking. All commands require `-p pg-sourcerer`.

## Prog Workflow

Tasks are tracked in [prog](https://github.com/baiirun/prog). Use CLI via bash.

### Essential Commands

```bash
# Find ready tasks (no blockers)
prog ready -p pg-sourcerer

# Project overview
prog status -p pg-sourcerer

# List all open tasks
prog list -p pg-sourcerer --status=open

# Show task details
prog show ts-XXXXXX

# Start working on a task
prog start ts-XXXXXX

# Log progress (timestamped)
prog log ts-XXXXXX "Implemented feature X"

# Complete a task
prog done ts-XXXXXX

# Create a new task
prog add "Task title" -p pg-sourcerer --priority 2

# Create an epic
prog add "Epic title" -p pg-sourcerer -e

# Add dependency (blocker blocks blocked)
prog blocks ts-blocker ts-blocked

# Set parent epic
prog parent ts-task ep-epic
```

### Workflow Pattern

1. **Start**: Run `prog ready -p pg-sourcerer` to find actionable work
2. **Claim**: Use `prog start ts-XXXXXX`
3. **Work**: Implement the task
4. **Progress**: Use `prog log ts-XXXXXX "what I did"` to track progress
5. **Complete**: Use `prog done ts-XXXXXX`

### Key Concepts

- **Dependencies**: Issues can block other issues. `prog ready` shows only unblocked work.
- **Priority**: 1=high, 2=medium (default), 3=low
- **Types**: task (default), epic (`-e` flag)
- **Project scope**: Always use `-p pg-sourcerer`

### TUI Mode

For interactive browsing: `prog tui` (or `prog ui`)

### Knowledge Base: `prog learn`

When you research something that future sessions would benefit from, capture it:

```bash
# Log a learning linked to a concept
prog learn "insight here" -c concept-name -p pg-sourcerer

# Check existing learnings before researching
prog concepts -p pg-sourcerer
prog context -c concept-name -p pg-sourcerer --summary
```

**What NOT to capture** (project state that can become stale):

- "QueryArtifact is in ir/query-artifact.ts" (file locations change)
- Task status or progress
- Implementation details of what you just built (use `prog log` instead)

**The key test**: Would this help an agent working on a _different_ task in 6 months?

- YES → `prog learn` (e.g., "Effect has a Graph module at ~/.local/share/effect-solutions/effect/packages/effect/src/Graph.ts")
- NO → `prog log` (e.g., "Created emit.ts with cross-file import tracking")

**When to use:**

- After researching a library API via Context7 or docs
- After discovering a non-obvious pattern through trial/error
- Before ending a session, if you learned something reusable

Good learnings are **stable facts** that won't change with our code.

## Priority Rules: Core > Plugins

**Core issues take priority over plugin issues at every priority level.**

| Priority | Core Examples                             | Plugin Examples                    |
| -------- | ----------------------------------------- | ---------------------------------- |
| **P1**   | Infrastructure, test coverage, foundation | Critical bug fixes only            |
| **P2**   | Code quality, refactoring                 | Important features, stable plugins |
| **P3**   | Documentation, polish                     | Advanced features, non-blocking    |
| **P4**   | Nice-to-have cleanup                      | Experimental plugins               |

When choosing between same-priority core vs plugin → Pick core.

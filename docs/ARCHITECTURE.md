# pg-sourcerer Architecture Plan

## Overview

A PostgreSQL code generation framework with a plugin ecosystem centered around database introspection. The core principle is that **the system shouldn't know what it's generating** - it orchestrates plugins that declare their capabilities and dependencies, enabling composition and extensibility.

**Built with Effect-ts** for robust error handling, dependency injection, and structured concurrency. Uses **Effect Schema** internally for configuration and IR validation.

## Core vs Plugin Responsibilities

| Core Infrastructure | Plugin Responsibility |
|--------------------|-----------------------|
| Load config, connect to DB | N/A |
| Introspect schema via pg-introspection | N/A |
| Parse smart tags from comments | Define custom tag keys |
| Build semantic IR (entities, shapes, fields, relations) | Read IR, attach extensions |
| Resolve plugin capabilities & ordering | Declare requires/provides |
| Provide PluginContext API | Call emit(), register symbols |
| Provide TypeHintRegistry (user-configured overrides) | Query hints, interpret values, apply mappings |
| Buffer emissions, detect conflicts | Generate code strings |
| Calculate relative imports | Request imports via SymbolRegistry |
| Write files to disk | N/A |
| **Not core's job:** | Type mapping logic (pg→TS, pg→Zod) |
| | Code formatting |
| | Language/library-specific logic |

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                         CLI Layer                            │
│              (commands, config loading, logging)             │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Effect Service Layer                      │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐│
│  │ ConfigSvc   │ │ DatabaseSvc │ │ FileSystemSvc           ││
│  │             │ │             │ │ (@effect/platform)      ││
│  └─────────────┘ └─────────────┘ └─────────────────────────┘│
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                      pg-introspection                        │
└──────────────────────────┬──────────────────────────────────┘
                           │ raw introspection
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   Smart Tags Parser                          │
│    (parse JSON from pg_description comments, validate)       │
└──────────────────────────┬──────────────────────────────────┘
                           │ introspection + parsed tags
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Semantic IR Builder                       │
│                                                              │
│  Builds:                                                     │
│    - Entities (tables/views → named entities)               │
│    - Shapes (row, insert, update, patch)                    │
│    - Relations (FKs → named associations)                   │
│    - Fields (columns → typed fields)                        │
│    - Enums (PostgreSQL enums)                               │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Plugin Pipeline                           │
│                                                              │
│  1. Validate plugin configs (Effect Schema)                 │
│  2. Build capability graph, check for conflicts/cycles      │
│  3. Topological sort by requires/provides                   │
│  4. Execute plugins sequentially                            │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Symbol Registry                           │
│              (tracks emitted symbols for imports)            │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Emission Buffer                           │
│                                                              │
│  1. Collect all emit() calls from plugins                   │
│  2. Detect conflicts (same path, different plugins)         │
│  3. Resolve imports across files                            │
│  4. Format code (optional)                                  │
│  5. Write to disk (or dry-run)                              │
└─────────────────────────────────────────────────────────────┘
```

## Effect-ts Foundation

The core runtime is built on Effect-ts, providing:

- **Typed errors** - All failure modes tracked in the type system via tagged unions
- **Dependency injection** - Services injected via Effect's Context/Layer system
- **Structured concurrency** - Plugin execution is safe and composable
- **Resource management** - Database connections scoped with `Effect.acquireRelease`
- **Effect Schema** - Configuration and IR validation

### Effect Modules to Research During Implementation

| Module | Purpose | Notes |
|--------|---------|-------|
| `Effect.Config` | Type-safe config with env var resolution | May replace lilconfig |
| `@effect/platform` `FileSystem` | File operations service | Cross-platform |
| `@effect/platform` `Command` | CLI argument parsing | Alternative to parseArgs |
| `Effect.Layer` | Service composition | Core architectural pattern |
| `Effect.Scope` | Resource lifecycle | For DB connection pooling |
| `Data.TaggedEnum` | Error type definitions | For typed error taxonomy |
| `Schema.TreeFormatter` | Error message formatting | User-friendly validation errors |

### Service Layer Architecture

```typescript
// Conceptual Layer structure - exact APIs to be determined during implementation
type MainLayer = 
  | ConfigService      // Load and validate pgsourcerer.config.ts
  | DatabaseService    // Connection pool, introspection queries
  | IntrospectionService // Build IR from raw introspection
  | PluginRunnerService  // Orchestrate plugin execution
  | SymbolRegistryService // Track cross-file symbols
  | EmitterService     // Buffer writes, resolve imports, write files
  | FileSystemService  // From @effect/platform
```

## Error Taxonomy

All errors are typed via Effect's tagged union pattern. This enables precise error handling and helpful messages.

```typescript
// Core error types - exact structure to be refined during implementation
type SourcererError = Data.TaggedEnum<{
  // Configuration errors
  ConfigNotFound: { searchPaths: string[] }
  ConfigInvalid: { path: string; errors: ParseError[] }
  
  // Database errors  
  ConnectionFailed: { connectionString: string; cause: Error }
  IntrospectionFailed: { schema: string; cause: Error }
  
  // Smart tags errors
  TagParseError: { 
    objectType: 'table' | 'column' | 'constraint'
    objectName: string
    comment: string
    cause: Error 
  }
  
  // Plugin errors
  CapabilityNotSatisfied: { required: CapabilityKey; by: string }
  CapabilityConflict: { capability: CapabilityKey; providers: string[] }
  CapabilityCycle: { cycle: string[] }
  PluginConfigInvalid: { plugin: string; errors: ParseError[] }
  PluginExecutionFailed: { 
    plugin: string
    entity?: string
    field?: string
    cause: Error
    hint?: string  // Actionable suggestion
  }
  
  // Emission errors
  EmitConflict: { path: string; plugins: string[] }
  WriteError: { path: string; cause: Error }
}>
```

## Core Type Definitions

All IR types defined with Effect Schema for validation. These are the authoritative type definitions.

### Smart Tags

```typescript
import { Schema as S } from 'effect'

// Smart tags extracted from PostgreSQL COMMENT ON statements
const SmartTags = S.Struct({
  // Renaming
  name: S.optional(S.String),
  
  // Omission: true = omit entirely, array = omit from specific shapes
  omit: S.optional(S.Union(
    S.Boolean,
    S.Array(S.Literal('row', 'insert', 'update', 'patch'))
  )),
  
  // Type override (emitter-specific, passed through as string)
  type: S.optional(S.String),
  
  // Deprecation: true = deprecated, string = deprecated with message
  deprecated: S.optional(S.Union(S.Boolean, S.String)),
  
  // For views: define virtual primary key
  primaryKey: S.optional(S.Array(S.String)),
  
  // For constraints: relation naming
  fieldName: S.optional(S.String),
  foreignFieldName: S.optional(S.String),
  
  // Extension point: plugins can define additional keys
  // Validated by individual plugins, not core
}).pipe(S.extend(S.Record(S.String, S.Unknown)))

type SmartTags = S.Schema.Type<typeof SmartTags>
```

### Semantic IR

```typescript
const ShapeKind = S.Literal('row', 'insert', 'update', 'patch')
type ShapeKind = S.Schema.Type<typeof ShapeKind>

// Note: PgAttribute, PgClass, PgEnum are from pg-introspection library
// They are used as-is, not re-defined here

interface Field {
  name: string                    // Inflected field name
  columnName: string              // Original PostgreSQL column name
  pgAttribute: PgAttribute        // Raw from pg-introspection
  
  // Semantic properties (derived from pgAttribute for convenience)
  nullable: boolean               // Can be NULL at runtime
  optional: boolean               // Optional in this shape (e.g., has default for insert)
  hasDefault: boolean             // Has DEFAULT or is GENERATED
  isGenerated: boolean            // GENERATED ALWAYS column
  isIdentity: boolean             // IDENTITY column
  
  // Array handling
  isArray: boolean                // PostgreSQL array type
  elementTypeName?: string        // For arrays, the element type name
  
  tags: SmartTags
  
  // Plugin-attached data (extensible, keyed by plugin name)
  extensions: Map<string, unknown>
}

interface Shape {
  name: string                    // e.g., "UserRow", "UserInsert"
  kind: ShapeKind
  fields: Field[]
}

interface Relation {
  name: string                    // Inflected relation name
  kind: 'hasMany' | 'hasOne' | 'belongsTo'
  targetEntity: string            // Entity name (not table name)
  constraintName: string          // Original FK constraint name
  
  // Column mappings (supports composite FKs)
  columns: Array<{
    local: string                 // Local column name
    foreign: string               // Foreign column name  
  }>
  
  tags: SmartTags
}

interface Entity {
  name: string                    // Inflected entity name
  tableName: string               // Original PostgreSQL table/view name
  schemaName: string              // PostgreSQL schema
  kind: 'table' | 'view' | 'composite'
  pgClass: PgClass                // Raw from pg-introspection
  
  // Primary key columns (may be undefined for views without @primaryKey tag)
  primaryKey?: {
    columns: string[]             // Column names
    isVirtual: boolean            // True if from @primaryKey tag, false if real PK
  }
  
  shapes: {
    row: Shape                    // Always present
    insert?: Shape                // Tables only (not views)
    update?: Shape                // Tables only
    patch?: Shape                 // Partial update shape
  }
  
  relations: Relation[]
  tags: SmartTags
}

interface EnumDef {
  name: string                    // Inflected enum name
  pgName: string                  // Original PostgreSQL enum name
  schemaName: string              // PostgreSQL schema
  pgType: PgType                  // Raw from pg-introspection
  values: string[]                // Enum values in order
  tags: SmartTags
}

// Artifacts are plugin outputs stored in IR for downstream plugins
// Structure is plugin-defined, keyed by capability
interface Artifact {
  capability: CapabilityKey
  plugin: string                  // Plugin that created this
  data: unknown                   // Plugin-specific data
}

interface SemanticIR {
  entities: Map<string, Entity>
  enums: Map<string, EnumDef>
  artifacts: Map<CapabilityKey, Artifact>
  
  // Metadata
  introspectedAt: Date
  schemas: string[]               // PostgreSQL schemas that were introspected
}
```

### Plugin System Types

```typescript
// Capability keys use colon-separated namespaces
// More specific capabilities implicitly provide their parents
// e.g., "schemas:zod" also provides "schemas"
type CapabilityKey = string  // e.g., "types", "schemas", "schemas:zod", "queries:crud"

interface PluginInflection {
  // Generate output file path for an entity
  outputFile(entity: Entity, artifactKind: string): string
  
  // Generate symbol name for an entity
  symbolName(entity: Entity, artifactKind: string): string
}

interface PluginContext {
  // Read-only access to IR
  readonly ir: SemanticIR
  
  // Core inflection (shared across plugins)
  readonly inflection: CoreInflection
  
  // Symbol registry for cross-file imports
  readonly symbols: SymbolRegistry
  
  // Type hints registry (user-configured type overrides)
  readonly typeHints: TypeHintRegistry
  
  // Get artifact from a previous plugin
  getArtifact(capability: CapabilityKey): Artifact | undefined
  
  // Store artifact for downstream plugins
  setArtifact(capability: CapabilityKey, data: unknown): void
  
  // Emit code to a file (buffered, not written until all plugins complete)
  emit(path: string, content: string): void
  
  // Append to an already-emitted file (same plugin only)
  appendEmit(path: string, content: string): void
  
  // Logging
  readonly log: {
    debug(message: string): void
    info(message: string): void
    warn(message: string): void
  }
}

// Plugin definition
interface Plugin<TConfig = unknown> {
  name: string
  
  // Capabilities this plugin requires (must be provided by earlier plugins)
  requires?: CapabilityKey[]
  
  // Capabilities this plugin provides
  provides: CapabilityKey[]
  
  // Configuration schema (Effect Schema)
  configSchema: S.Schema<TConfig>
  
  // Plugin-specific inflection
  inflection: PluginInflection
  
  // Plugin execution - returns Effect for proper error typing
  run(config: TConfig): Effect.Effect<void, PluginError, PluginContext>
}
```

### Symbol Registry Types

```typescript
interface SymbolRef {
  capability: CapabilityKey       // e.g., "schemas", "types"
  entity: string                  // Entity name
  shape?: string                  // Shape kind (optional for non-shape symbols)
}

interface Symbol {
  name: string                    // Exported symbol name
  file: string                    // File path relative to output root
  capability: CapabilityKey
  entity: string
  shape?: string
  isType: boolean                 // TypeScript type-only export
  isDefault: boolean              // Default export
}

interface ImportStatement {
  from: string                    // Import path (relative, calculated)
  named: string[]                 // Named imports
  types: string[]                 // Type-only imports
  default?: string                // Default import name
}

interface SymbolRegistry {
  // Register a symbol (called by plugins during emit)
  register(symbol: Symbol): void
  
  // Resolve a reference to a symbol
  resolve(ref: SymbolRef): Symbol | undefined
  
  // Generate import statement from one file to another
  importFor(symbol: Symbol, fromFile: string): ImportStatement
  
  // Check for conflicts (same name in same file from different plugins)
  validate(): Array<{ symbol: string; file: string; plugins: string[] }>
}
```

### Type Hint Registry

User-configured type overrides that plugins can query. This allows users to customize type mapping without modifying plugins. The core provides the registry; plugins decide how to interpret hints.

```typescript
// Configured in pgsourcerer.config.ts
interface TypeHint {
  // Match criteria (all specified criteria must match)
  match: {
    schema?: string           // PostgreSQL schema name
    table?: string            // Table/view name
    column?: string           // Column name
    pgType?: string           // PostgreSQL type name (e.g., 'text', 'uuid')
  }
  
  // Hint data (plugin-specific, opaque to core)
  // Examples:
  //   { ts: 'UserId', zod: 'z.string().uuid().brand<"UserId">()' }
  //   { ts: 'Email', zod: 'emailSchema', import: './branded.js' }
  hints: Record<string, unknown>
}

interface TypeHintRegistry {
  // Get hints for a specific field (returns merged hints from all matching rules)
  // More specific matches take precedence over general ones
  getHints(field: {
    schema: string
    table: string  
    column: string
    pgType: string
  }): Record<string, unknown>
  
  // Get a specific hint value
  getHint<T>(field: { schema: string; table: string; column: string; pgType: string }, 
             key: string): T | undefined
}
```

**Configuration example:**

```typescript
// pgsourcerer.config.ts
export default defineConfig({
  connectionString: process.env.DATABASE_URL,
  
  typeHints: [
    // All uuid columns → branded UserId type
    {
      match: { pgType: 'uuid' },
      hints: { 
        ts: 'string',  // Base TS type
        zod: 'z.string().uuid()',
      }
    },
    
    // Specific column override → Effect branded type
    {
      match: { table: 'users', column: 'id' },
      hints: {
        ts: 'UserId',
        zod: 'UserId',  // Assumes UserId is a branded schema
        import: { UserId: '@/types/branded.js' }
      }
    },
    
    // All email columns
    {
      match: { column: 'email' },
      hints: {
        ts: 'Email',
        zod: 'emailSchema',
        import: { Email: '@/types/branded.js', emailSchema: '@/schemas/email.js' }
      }
    },
  ],
  
  plugins: [/* ... */],
})
```

**Plugin usage:**

```typescript
// Inside a plugin's run() function
const hints = ctx.typeHints.getHints({
  schema: field.schemaName,
  table: entity.tableName,
  column: field.columnName,
  pgType: field.pgAttribute.getType()?.typname ?? 'unknown'
})

// Plugin decides what to do with hints
const tsType = hints.ts as string ?? defaultTsType(field)
const zodType = hints.zod as string ?? defaultZodType(field)

// Handle imports if specified
if (hints.import) {
  for (const [symbol, path] of Object.entries(hints.import as Record<string, string>)) {
    ctx.symbols.registerExternal({ name: symbol, from: path })
  }
}
```

**Precedence rules:**
1. More specific matches override less specific
2. `table + column` > `table` > `column` > `pgType`
3. Later rules in array override earlier (for same specificity)

The pg-introspection library has specific patterns that must be followed.

### Accessing Type Information

```typescript
// CORRECT: Use getType() method
const pgType = pgAttribute.getType()
const typeName = pgType?.typname

// WRONG: No direct .type property
// pgAttribute.type.typname  // This doesn't exist

// For arrays, check typcategory
const isArray = pgType?.typcategory === 'A'
const elementType = isArray ? pgType?.getElemType() : undefined

// For domains, unwrap to base type
const baseType = pgType?.typtype === 'd' ? pgType?.getBaseType() : pgType

// For enums, get values
const isEnum = pgType?.typtype === 'e'
const enumValues = isEnum ? pgType?.getEnumValues() : undefined
```

### Getting Table/View Information

```typescript
// Get all tables in a schema
const tables = introspection.classes.filter(c => 
  c.relkind === 'r' &&  // 'r' = ordinary table
  c.getNamespace()?.nspname === schemaName
)

// Get all views
const views = introspection.classes.filter(c =>
  c.relkind === 'v' &&  // 'v' = view
  c.getNamespace()?.nspname === schemaName
)

// Get columns for a table/view
const columns = pgClass.getAttributes().filter(a => a.attnum > 0)

// Get primary key
const pk = pgClass.getPrimaryKeyConstraint()
const pkColumns = pk?.getAttributes() ?? []

// Get foreign keys
const fks = pgClass.getConstraints().filter(c => c.contype === 'f')
```

## Smart Tags (Configuration in Comments)

Configuration is embedded in PostgreSQL `COMMENT ON` statements using JSON with a `sourcerer` namespace.

### Format

```sql
COMMENT ON TABLE users IS E'{"sourcerer": {"name": "User"}}\nUser accounts in the system';
COMMENT ON COLUMN users.email IS E'{"sourcerer": {"omit": ["update"]}}';
COMMENT ON COLUMN users.password_hash IS E'{"sourcerer": {"omit": true}}';
COMMENT ON CONSTRAINT users_org_fkey ON users IS E'{"sourcerer": {"fieldName": "organization", "foreignFieldName": "members"}}';
```

### Parsing Behavior

| Scenario | Behavior |
|----------|----------|
| Valid JSON with `sourcerer` key | Extract and validate against SmartTags schema |
| Valid JSON without `sourcerer` key | No tags (other tools may use their own namespaces) |
| Malformed JSON | Warning logged, treated as no tags, rest of comment used as description |
| Multiple JSON objects | First valid one used, warning logged |
| Empty comment | No tags |
| No comment | No tags |

### Supported Keys

| Key | Applies To | Type | Purpose |
|-----|-----------|------|---------|
| `name` | table, column | `string` | Rename in generated code |
| `omit` | table, column | `boolean \| ShapeKind[]` | Exclude from generation |
| `type` | column | `string` | Override generated type (emitter-specific) |
| `fieldName` | constraint | `string` | Name the local side of relation |
| `foreignFieldName` | constraint | `string` | Name the foreign side of relation |
| `deprecated` | any | `boolean \| string` | Mark as deprecated (string = message) |
| `primaryKey` | view | `string[]` | Define virtual primary key columns |

## Capability System

### Namespace Rules

Capabilities use colon-separated hierarchical namespaces:

```
schemas           # Base capability
schemas:zod       # Specific implementation
schemas:zod:v4    # Version-specific (if needed)
```

**Implicit Provision Rule**: A plugin providing `schemas:zod` automatically provides `schemas`.

**Satisfaction Rule**: A plugin requiring `schemas` is satisfied by any of `schemas`, `schemas:zod`, `schemas:effect`, etc.

### Conflict Detection

- Two plugins cannot provide the same leaf capability
- `schemas` and `schemas:zod` from different plugins = conflict
- User must choose one schema provider

### Resolution Algorithm

1. Collect all `provides` and `requires` from plugins
2. Expand implicit provisions (e.g., `schemas:zod` → also provides `schemas`)
3. Check for conflicts (same capability from multiple plugins)
4. Check all `requires` are satisfied
5. Build dependency graph
6. Topological sort (error on cycles)
7. Execute in sorted order

## Inflection

### Core Inflection (Shared)

```typescript
interface CoreInflection {
  // Base transforms
  camelCase(text: string): string
  pascalCase(text: string): string
  pluralize(text: string): string
  singularize(text: string): string
  
  // Handle reserved words (class, type, etc.)
  safeIdentifier(text: string): string
  
  // Entity naming (respects @name tag)
  entityName(pgClass: PgClass, tags: SmartTags): string
  
  // Shape naming: "User" + "row" → "UserRow"
  shapeName(entityName: string, kind: ShapeKind): string
  
  // Field naming (respects @name tag on columns)
  fieldName(pgAttribute: PgAttribute, tags: SmartTags): string
  
  // Enum naming
  enumName(pgType: PgType, tags: SmartTags): string
  enumValueName(value: string): string
  
  // Relation naming (respects @fieldName/@foreignFieldName)
  relationName(constraint: PgConstraint, side: 'local' | 'foreign', tags: SmartTags): string
}
```

### Naming Conventions

| Input | Transform | Output |
|-------|-----------|--------|
| `user_accounts` | entityName | `UserAccount` |
| `UserAccount` + `insert` | shapeName | `UserAccountInsert` |
| `created_at` | fieldName | `createdAt` |
| `author_id` | relationName (local) | `author` |
| `posts` (table) | relationName (foreign from User) | `posts` |
| `authored_posts` (disambiguated) | relationName (foreign) | `authoredPosts` |

### Reserved Word Handling

When a name conflicts with TypeScript/JavaScript reserved words, append underscore:

```
class → class_
type → type_
default → default_
```

## Relations

### Kind Determination

| Scenario | Kind |
|----------|------|
| FK is on this entity, pointing to other | `belongsTo` |
| Other entity has FK pointing here, FK is unique | `hasOne` |
| Other entity has FK pointing here, FK is not unique | `hasMany` |

### Composite Foreign Keys

Fully supported via the `columns` array:

```typescript
// FK: orders(customer_id, region_id) → customers(id, region_id)
{
  name: 'customer',
  kind: 'belongsTo',
  targetEntity: 'Customer',
  columns: [
    { local: 'customer_id', foreign: 'id' },
    { local: 'region_id', foreign: 'region_id' }
  ]
}
```

### Self-Referential Relations

```sql
-- Table: employees(id, manager_id → employees.id)
```

Produces two relations:
- `manager: belongsTo Employee` (local side)
- `directReports: hasMany Employee` (foreign side)

Naming uses smart inference or explicit tags.

## Configuration

### Main Config File

```typescript
// pgsourcerer.config.ts
import { defineConfig } from 'pg-sourcerer'
import { typesPlugin } from 'pg-sourcerer/plugins/types'
import { zodPlugin } from 'pg-sourcerer/plugins/zod'

export default defineConfig({
  // Database connection (required)
  connectionString: process.env.DATABASE_URL,
  
  // PostgreSQL schemas to introspect (default: ['public'])
  schemas: ['public', 'app'],
  
  // Output directory root (default: 'src/generated')
  outputDir: 'src/generated',
  
  // Plugins (order doesn't matter - sorted by capabilities)
  plugins: [
    typesPlugin({
      outputDir: 'types',  // Relative to main outputDir
    }),
    
    zodPlugin({
      outputDir: 'schemas',
    }),
  ],
})
```

### Config Schema

```typescript
const TypeHintMatch = S.Struct({
  schema: S.optional(S.String),
  table: S.optional(S.String),
  column: S.optional(S.String),
  pgType: S.optional(S.String),
})

const TypeHint = S.Struct({
  match: TypeHintMatch,
  hints: S.Record(S.String, S.Unknown),
})

const ConfigSchema = S.Struct({
  connectionString: S.String,
  schemas: S.optional(S.Array(S.String)).pipe(S.withDefault(() => ['public'])),
  outputDir: S.optional(S.String).pipe(S.withDefault(() => 'src/generated')),
  typeHints: S.optional(S.Array(TypeHint)).pipe(S.withDefault(() => [])),
  plugins: S.Array(S.Any),  // Validated individually per plugin
})
```

### Config File Discovery

Search order (first found wins):
1. `--config` CLI flag
2. `pgsourcerer.config.ts`
3. `pgsourcerer.config.js`
4. `pgsourcerer.config.mjs`

## CLI Interface

```
pgsourcerer <command> [options]

Commands:
  generate    Generate code from database schema (default)
  init        Create a new config file

Options:
  --config, -c <path>    Path to config file
  --dry-run              Show what would be generated without writing
  --verbose, -v          Enable verbose logging
  --help, -h             Show help
  --version              Show version

Exit codes:
  0    Success
  1    Error (config, connection, plugin failure, etc.)
```

## File System Conventions

### Output Structure

```
{outputDir}/
  types/
    User.ts
    Post.ts
    index.ts          # Optional barrel, plugin-controlled
  schemas/
    User.ts
    Post.ts
```

### File Handling

| Behavior | Rule |
|----------|------|
| Existing files | Overwritten (generated code is not meant to be edited) |
| Empty directories | Created as needed |
| Output root | Created if doesn't exist |
| Permissions | Inherit from parent directory |

### Generated File Header

All generated files include:

```typescript
// This file is auto-generated by pg-sourcerer. Do not edit.
// Generated at: 2024-01-15T10:30:00.000Z
```

## Import Resolution

### Algorithm

1. Both files are relative to `outputDir`
2. Calculate relative path from importer to importee
3. Use `.js` extension in imports (ESM)
4. Separate type imports from value imports

### Example

```typescript
// File: schemas/User.ts wants to import from types/User.ts
// Calculated import:
import type { User } from '../types/User.js'
```

### Constraints

- All imports are relative (no path aliases in generated code)
- ESM format with `.js` extensions
- Type-only imports use `import type`

## Testing Strategy

### Unit Tests

Mock the `PluginContext`:

```typescript
const mockCtx = createMockPluginContext({
  ir: buildTestIR([
    { name: 'users', columns: [/* ... */] },
  ]),
})

const result = await Effect.runPromise(
  zodPlugin.run({ outputDir: 'schemas' }).pipe(
    Effect.provideService(PluginContext, mockCtx)
  )
)

expect(mockCtx.emitted.get('schemas/User.ts')).toContain('z.object')
```

### Introspection Fixtures

Pre-built IR fixtures for common scenarios:
- Simple table with scalar columns
- Table with enum column
- Table with array column
- Two tables with FK relation (1:N)
- Two tables with FK relation + unique constraint (1:1)
- Self-referential table (tree structure)
- View without primary key
- View with `@primaryKey` tag
- Table with composite primary key
- Table with composite foreign key

### Integration Tests

Using testcontainers with real PostgreSQL:
1. Apply test migration
2. Run introspection
3. Run generation
4. Compile generated TypeScript
5. Optionally: run generated code against test DB

### Snapshot Tests

Generated code output as snapshots for regression detection.

## Implementation Phases

### Phase 1: Core Infrastructure
- [ ] Effect service layer scaffolding
- [ ] Smart tags parser with validation
- [ ] Semantic IR types (Effect Schema)
- [ ] IR builder from pg-introspection
- [ ] Core inflection system
- [ ] Plugin runner with capability resolution
- [ ] Symbol registry
- [ ] Emission buffer and file writer

### Phase 2: Base Plugins
- [ ] Types plugin (TypeScript interfaces)
- [ ] Effect Schema plugin (schemas + inferred types)
- [ ] Zod plugin (schemas + inferred types)

### Phase 3: Query & HTTP Plugins
- [ ] CRUD queries plugin (adapter-agnostic declarations)
- [ ] Kysely adapter
- [ ] HTTP routes plugin (Hono)

### Phase 4: Developer Experience
- [ ] Watch mode
- [ ] Improved error messages with hints
- [ ] Dry-run mode output formatting

### Phase 5: Extended Features
- [ ] Many-to-many relation detection
- [ ] PostgreSQL function introspection
- [ ] Alternative schema plugins (Arktype, TypeBox)
- [ ] Additional query adapters (Drizzle, raw SQL)

---

## Yet To Be Determined

These items require further research or decisions during implementation of the **core plugin runner**.

### Effect-ts Patterns (Research Required)
- [ ] Exact Layer composition structure - how do services depend on each other?
- [ ] Whether to use `Effect.Config` or keep lilconfig for config loading
- [ ] Best practices for Effect Schema error formatting (`TreeFormatter`?)
- [ ] Pattern for providing `PluginContext` to plugin `run()` - service or parameter?

### Plugin Runner Core
- [ ] Capability conflict detection - exact algorithm for hierarchical namespaces
- [ ] Plugin execution error boundaries - does one plugin failure stop all?
- [ ] Should plugins receive pre-instantiated inflection or a factory?
- [ ] Plugin lifecycle hooks (beforeAll, afterAll) - needed for Phase 1?

### Symbol Registry & Import Resolution
- [ ] Exact algorithm for relative path calculation
- [ ] Handling circular imports between generated files - detect and error, or allow?
- [ ] Symbol collision detection - same name from different plugins in same file
- [ ] External symbol registration (for type hint imports)

### Type Hint Registry
- [ ] Exact precedence calculation algorithm (specificity scoring?)
- [ ] Glob/regex support in match patterns (e.g., `table: 'user_*'`)?
- [ ] Inheritance/merge behavior when multiple hints match
- [ ] Validation of hint values (per-plugin schemas?)

### Emission Buffer
- [ ] Multiple `emit()` calls to same file from same plugin - append or replace?
- [ ] Order of content when multiple plugins write to same file (if allowed)
- [ ] Dry-run output format - diff, file list, or full content?

### Database Connection
- [ ] Connection string only, or support for discrete options (host, port, etc.)?
- [ ] Connection pooling - single connection sufficient for introspection?
- [ ] Timeout configuration

### Config Loading
- [ ] Use lilconfig, Effect.Config, or Bun's native import?
- [ ] Environment variable substitution in config values
- [ ] Config file TypeScript compilation (Bun handles natively?)

---

## Out of Scope for Core

These are plugin/emitter concerns, not core infrastructure:

- **Type mapping logic** (pg types → TS/Zod/etc.) - each plugin owns its mapping
  - Core provides: `TypeHintRegistry` for user overrides, `Field.pgAttribute` for raw type info
  - Plugin decides: how to interpret hints, default mappings, fallbacks
- **Code formatting** (prettier) - plugins can format their own output
- **Barrel file generation** - plugin decision
- **Path aliases in output** - plugins control their import style
- **Watch mode** - Phase 4, after core is stable

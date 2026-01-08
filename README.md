# pg-sourcerer

PostgreSQL code generation framework with a plugin ecosystem. Introspects your database schema and generates TypeScript types, Zod schemas, Effect Models, and more.

Built with [Effect-ts](https://effect.website/) for robust error handling and composability.

## Installation

```bash
npm install @danielfgray/pg-sourcerer
```

## Quick Start

1. Create a config file `pgsourcerer.config.ts`:

```typescript
import { defineConfig, typesPlugin, zodPlugin } from "@danielfgray/pg-sourcerer"

export default defineConfig({
  connectionString: process.env.DATABASE_URL,
  schemas: ["public"],
  outputDir: "./src/generated",
  plugins: [
    typesPlugin({ outputDir: "types" }),
    zodPlugin({ outputDir: "schemas" }),
  ],
})
```

2. Run the generator:

```bash
pgsourcerer generate
```

## CLI

```
pgsourcerer generate [options]

Options:
  -c, --config <path>   Path to config file
  -o, --output <dir>    Override output directory  
  -n, --dry-run         Show what would be generated
  --log-level <level>   debug | info | none
```

## Plugins

| Plugin | Provides | Description |
|--------|----------|-------------|
| `typesPlugin` | TypeScript interfaces | `User`, `UserInsert`, `UserUpdate` |
| `zodPlugin` | Zod schemas | Runtime validation with inferred types |
| `arktypePlugin` | ArkType validators | String-based type syntax with inference |
| `effectModelPlugin` | Effect Model classes | Rich models with Schema integration |
| `kyselyQueriesPlugin` | Kysely query builders | Type-safe CRUD operations |
| `sqlQueriesPlugin` | Raw SQL functions | Parameterized query helpers |

## What Gets Generated

Given a PostgreSQL table like:

```sql
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username citext UNIQUE NOT NULL,
  name text,
  role user_role NOT NULL DEFAULT 'user',
  bio text NOT NULL DEFAULT '',
  is_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

Each plugin generates different artifacts:

### `typesPlugin` — TypeScript Interfaces

```typescript
import type { UserRole } from "./UserRole.js";

export interface User {
  id: string;
  username: string;
  name?: string | null;
  role: UserRole;
  bio: string;
  isVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserUpdate {
  username?: string;
  name?: string | null;
  bio?: string;
}
```

### `zodPlugin` — Zod Schemas

```typescript
import { z } from "zod";

export const User = z.object({
  id: z.string().uuid(),
  username: z.string(),
  name: z.string().nullable().optional(),
  role: z.enum(["admin", "moderator", "user"]),
  bio: z.string(),
  isVerified: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type User = z.infer<typeof User>;
```

### `arktypePlugin` — ArkType Validators

```typescript
import { type } from "arktype";

export const User = type({
  id: "string.uuid",
  username: "string",
  "name?": "string | null",
  role: "'admin' | 'moderator' | 'user'",
  bio: "string",
  isVerified: "boolean",
  createdAt: "Date",
  updatedAt: "Date",
});

export type User = typeof User.infer;
```

### `effectModelPlugin` — Effect SQL Models

```typescript
import { Model } from "@effect/sql";
import { Schema as S } from "effect";

export class User extends Model.Class<User>("User")({
  id: Model.Generated(S.UUID),
  username: S.String,
  name: S.NullOr(S.String),
  role: S.Union(S.Literal("admin"), S.Literal("moderator"), S.Literal("user")),
  bio: S.String,
  isVerified: S.Boolean,
  createdAt: Model.DateTimeInsertFromDate,
  updatedAt: Model.DateTimeUpdateFromDate,
}) {}
```

### `kyselyQueriesPlugin` — Kysely Query Builders

```typescript
import type { Kysely, Updateable } from "kysely";
import type { DB, AppPublicUsers } from "../DB.js";

export const users = {
  findById: (db: Kysely<DB>, id: string) =>
    db.selectFrom("app_public.users")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst(),

  findMany: (db: Kysely<DB>, opts?: { limit?: number; offset?: number }) =>
    db.selectFrom("app_public.users")
      .selectAll()
      .$if(opts?.limit != null, q => q.limit(opts!.limit!))
      .$if(opts?.offset != null, q => q.offset(opts!.offset!))
      .execute(),

  update: (db: Kysely<DB>, id: string, data: Updateable<AppPublicUsers>) =>
    db.updateTable("app_public.users")
      .set(data)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow(),

  findByUsername: (db: Kysely<DB>, username: string) =>
    db.selectFrom("app_public.users")
      .selectAll()
      .where("username", "=", username)
      .executeTakeFirst(),
};
```

### `sqlQueriesPlugin` — Raw SQL Query Functions

```typescript
import { sql } from "./sql-tag.js";
import type { User, UserInsert, UserUpdate } from "../types/User.js";

export async function getUserById({ id }: Pick<User, "id">): Promise<User | undefined> {
  const result = await sql<User[]>`
    SELECT * FROM app_public.users WHERE id = ${id}
  `;
  return result[0];
}

export async function insertUser(data: UserInsert): Promise<User> {
  const result = await sql<User[]>`
    INSERT INTO app_public.users (username, name, bio)
    VALUES (${data.username}, ${data.name}, ${data.bio})
    RETURNING *
  `;
  return result[0]!;
}
```

## Feature Support

| Feature | types | zod | arktype | effect-model | kysely | sql |
|---------|:-----:|:---:|:-------:|:------------:|:------:|:---:|
| Row types | ✓ | ✓ | ✓ | ✓ | — | imports |
| Insert shapes | ✓ | ✓ | ✓ | via Model | — | ✓ |
| Update shapes | ✓ | ✓ | ✓ | via Model | — | ✓ |
| Enums | ✓ | ✓ | ✓ | ✓ | — | — |
| Composite types | ✓ | ✓ | ✓ | ✓ | — | — |
| Views | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| CRUD queries | — | — | — | — | ✓ | ✓ |
| Index lookups | — | — | — | — | ✓ | ✓ |
| Runtime validation | — | ✓ | ✓ | ✓ | — | — |

## Smart Tags

Configure generation via PostgreSQL comments:

```sql
-- Rename entity
COMMENT ON TABLE users IS '{"sourcerer": {"name": "Account"}}';

-- Omit from generation
COMMENT ON COLUMN users.password_hash IS '{"sourcerer": {"omit": true}}';

-- Omit from specific shapes
COMMENT ON COLUMN users.created_at IS '{"sourcerer": {"omit": ["insert", "update"]}}';

-- Custom relation names
COMMENT ON CONSTRAINT posts_author_fkey ON posts IS 
  '{"sourcerer": {"fieldName": "author", "foreignFieldName": "posts"}}';
```

## Type Hints

Override type mappings in your config:

```typescript
defineConfig({
  // ...
  typeHints: [
    {
      match: { pgType: "uuid" },
      hints: { ts: "string", zod: "z.string().uuid()" }
    },
    {
      match: { table: "users", column: "email" },
      hints: { ts: "Email", zod: "emailSchema", import: { Email: "./branded.js" } }
    },
  ],
})
```

## Writing Plugins

Plugins generate code from the introspected database schema. Use `definePlugin` for a simple, synchronous API.

### Minimal Example

```typescript
import { definePlugin, conjure, Schema as S } from "@danielfgray/pg-sourcerer"

const { ts, exp } = conjure

export const myPlugin = definePlugin({
  name: "my-plugin",
  provides: ["my-types"],
  configSchema: S.Struct({
    outputDir: S.String,
  }),
  inflection: {
    outputFile: (ctx) => `${ctx.entityName}.ts`,
    symbolName: (entity, kind) => `${entity}${kind}`,
  },

  run: (ctx, config) => {
    ctx.ir.entities.forEach((entity, name) => {
      // Build interface properties from row shape
      const props = entity.shapes.row.fields.map((field) => ({
        name: field.name,
        type: field.nullable 
          ? ts.union(ts.string(), ts.null()) 
          : ts.string(),
        optional: field.optional,
      }))

      // Create exported interface with symbol tracking
      const statement = exp.interface(
        `${name}Row`,
        { capability: "my-types", entity: name, shape: "row" },
        props
      )

      // Emit file
      ctx.file(`${config.outputDir}/${name}.ts`)
        .header("// Auto-generated\n")
        .ast(conjure.symbolProgram(statement))
        .emit()
    })
  },
})
```

### Plugin Context

The `ctx` object provides:

| Property | Description |
|----------|-------------|
| `ctx.ir` | Semantic IR with `entities`, `enums`, `extensions` |
| `ctx.inflection` | Naming utilities (`camelCase`, `singularize`, etc.) |
| `ctx.typeHints` | User-configured type overrides |
| `ctx.file(path)` | Create a `FileBuilder` for structured emission |
| `ctx.emit(path, content)` | Emit raw string content |
| `ctx.getArtifact(cap)` | Read data from upstream plugins |
| `ctx.setArtifact(cap, data)` | Share data with downstream plugins |

### Conjure API

Conjure builds AST nodes for code generation:

```typescript
// Method chains: z.string().uuid()
conjure.id("z").method("string").method("uuid").build()

// Object literals: { path: "/users", method: "GET" }
conjure.obj()
  .prop("path", conjure.str("/users"))
  .prop("method", conjure.str("GET"))
  .build()

// TypeScript types
conjure.ts.string()                              // string
conjure.ts.ref("User")                           // User
conjure.ts.array(conjure.ts.string())            // string[]
conjure.ts.union(conjure.ts.string(), ts.null()) // string | null

// Statements
conjure.stmt.const("x", conjure.num(42))         // const x = 42
conjure.stmt.return(conjure.id("result"))        // return result

// Exports with symbol tracking (for import resolution)
exp.interface("UserRow", symbolCtx, properties)
exp.const("UserSchema", symbolCtx, schemaExpr)
exp.typeAlias("UserId", symbolCtx, ts.string())

// Print to code string
conjure.print(node)
```

### Depending on Other Plugins

Use `requires` to depend on capabilities from other plugins:

```typescript
definePlugin({
  name: "zod-schemas",
  requires: ["types"],  // Must run after types plugin
  provides: ["schemas:zod"],
  // ...
})
```

Access upstream artifacts:

```typescript
run: (ctx) => {
  const typesArtifact = ctx.getArtifact("types")
  // Use data from types plugin
}
```

## Development

```bash
# Clone and install
git clone https://github.com/danielfgray/pg-sourcerer
cd pg-sourcerer
npm install

# Run tests
cd packages/pg-sourcerer
npm test

# Try the example
cd packages/example
npm run init      # Start Postgres, run migrations
npm run generate  # Generate code
```

## License

MIT — see [LICENSE](./LICENSE)

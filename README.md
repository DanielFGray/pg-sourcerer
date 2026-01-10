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
| `valibotPlugin` | Valibot schemas | Modular validation with tree-shaking |
| `effectModelPlugin` | Effect Model classes | Rich models with Schema integration |
| `kyselyQueriesPlugin` | Kysely query builders | Type-safe CRUD operations |
| `sqlQueriesPlugin` | Raw SQL functions | Parameterized query helpers |
| `httpElysiaPlugin` | Elysia routes | REST endpoints with TypeBox validation |
| `httpTrpcPlugin` | tRPC routers | Type-safe RPC with Zod validation |
| `httpOrpcPlugin` | oRPC handlers | Lightweight RPC with TypeScript inference |

## What Gets Generated

Given a PostgreSQL table like:

```sql
create type app_public.user_role as enum('admin', 'moderator', 'user');
create domain app_public.username as citext check(length(value) >= 2 and length(value) <= 24 and value ~ '^[a-zA-Z][a-zA-Z0-9_-]+$');
create domain app_public.url as text check(value ~ '^https?://\S+');

create table app_public.users (
  id uuid primary key default gen_random_uuid(),
  username app_public.username not null unique,
  name text,
  avatar_url app_public.url,
  role app_public.user_role not null default 'user',
  bio text not null check(length(bio) <= 4000) default '',
  is_verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table app_public.users enable row level security;
create index on app_public.users (username);

grant
  select,
  update(username, name, bio, avatar_url)
  on app_public.users to :DATABASE_VISITOR;
```

Each plugin generates different artifacts:

### `typesPlugin` — TypeScript Interfaces

```typescript
import type { UserRole } from "./UserRole.js";

export interface User {
  id: string;
  username: string;
  name?: string | null;
  avatar_url?: string | null;
  role: UserRole;
  bio: string;
  is_verified: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface UserUpdate {
  username?: string;
  name?: string | null;
  avatar_url?: string | null;
  bio?: string;
}
```

### `zodPlugin` — Zod Schemas

```typescript
// UserRole.ts
import { z } from "zod";

export const UserRole = z.enum(["admin", "moderator", "user"]);

export type UserRole = z.infer<typeof UserRole>;

// User.ts
import { z } from "zod";
import { UserRole } from "./UserRole.js";

export const User = z.object({
  id: z.string().uuid(),
  username: z.string(),
  name: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
  role: UserRole,
  bio: z.string(),
  is_verified: z.boolean(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export type User = z.infer<typeof User>;

export const UserUpdate = z.object({
  username: z.string().optional(),
  name: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
  bio: z.string().optional(),
});

export type UserUpdate = z.infer<typeof UserUpdate>;
```

### `arktypePlugin` — ArkType Validators

```typescript
// UserRole.ts
import { type } from "arktype";

export const UserRole = type("'admin' | 'moderator' | 'user'");

export type UserRole = typeof UserRole.infer;

// User.ts
import { type } from "arktype";
import { UserRole } from "./UserRole.js";

export const User = type({
  id: "string.uuid",
  username: "string",
  "name?": "string | null",
  "avatar_url?": "string | null",
  role: UserRole,
  bio: "string",
  is_verified: "boolean",
  created_at: "Date",
  updated_at: "Date",
});

export type User = typeof User.infer;

export const UserUpdate = type({
  "username?": "string",
  "name?": "string | null",
  "avatar_url?": "string | null",
  "bio?": "string",
});

export type UserUpdate = typeof UserUpdate.infer;
```

### `valibotPlugin` — Valibot Schemas

```typescript
// UserRole.ts
import * as v from "valibot";

export const UserRole = v.picklist(["admin", "moderator", "user"]);

export type UserRole = v.InferOutput<typeof UserRole>;

// User.ts
import * as v from "valibot";
import { UserRole } from "./UserRole.js";

export const User = v.object({
  id: v.pipe(v.string(), v.uuid()),
  username: v.string(),
  name: v.optional(v.nullable(v.string())),
  avatar_url: v.optional(v.nullable(v.string())),
  role: UserRole,
  bio: v.string(),
  is_verified: v.boolean(),
  created_at: v.date(),
  updated_at: v.date(),
});

export type User = v.InferOutput<typeof User>;

export const UserUpdate = v.object({
  username: v.optional(v.string()),
  name: v.optional(v.nullable(v.string())),
  avatar_url: v.optional(v.nullable(v.string())),
  bio: v.optional(v.string()),
});

export type UserUpdate = v.InferOutput<typeof UserUpdate>;
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

### `sqlQueriesPlugin` — Raw SQL Query Functions

with `sqlQueriesPlugin({ sqlStyle: "tag" })`
```typescript
import { sql } from "../../db.js";
import type { User } from "../types/User.js";

export async function findUserById({ id }: Pick<User, "id">) {
  const [result] = await sql<User[]>`
    select id, username, name, avatar_url, role, bio, is_verified, created_at, updated_at
    from app_public.users where id = ${id}`;
  return result;
}

export async function findUserManys({ limit = 50, offset = 0 }: { limit?: number; offset?: number }) {
  return await sql<User[]>`
    select id, username, name, avatar_url, role, bio, is_verified, created_at, updated_at
    from app_public.users limit ${limit} offset ${offset}`;
}

export async function getUserByUsername({ username }: { username: NonNullable<User["username"]> }) {
  const [result] = await sql<User[]>`
    select id, username, name, avatar_url, role, bio, is_verified, created_at, updated_at
    from app_public.users where username = ${username}`;
  return result;
}

export async function currentUser() {
  const [result] = await sql<User[]>`select * from app_public.current_user()`;
  return result;
}
```

not using tagged templates? got you covered with `sqlQueriesPlugin({ sqlStyle: "string" })`

### `kyselyQueriesPlugin` — Kysely Query Builders

```typescript
import { db } from "../../db.js";
import type { User } from "../db.js";
import type { Updateable } from "kysely";

export const findById = ({ id }: { id: string }) =>
  db
    .selectFrom("users")
    .select(["id", "username", "name", "avatar_url", "role", "bio", "is_verified", "created_at", "updated_at"])
    .where("id", "=", id)
    .executeTakeFirst();

export const update = ({ id, data }: { id: string; data: Updateable<User> }) =>
  db.updateTable("users").set(data).where("id", "=", id).returningAll().executeTakeFirstOrThrow();

export const findByUsername = ({ username }: { username: string }) =>
  db
    .selectFrom("users")
    .select(["id", "username", "name", "avatar_url", "role", "bio", "is_verified", "created_at", "updated_at"])
    .where("username", "=", username)
    .executeTakeFirst();

export const currentUser = () =>
  db
    .selectFrom((eb) => eb.fn<User>("app_public.current_user", []).as("f"))
    .selectAll()
    .executeTakeFirst();
```

### `httpElysiaPlugin` — Elysia REST Routes

```typescript
import { Elysia, t } from "elysia";
import { findUserById, findUserManys, getUserByUsername } from "../sql-queries/User.js";

export const userRoutes = new Elysia({ prefix: "/api/users" })
  .get(
    "/:id",
    async ({ params, status }) => {
      const result = await findUserById({ id: params.id });
      if (!result) return status(404, "Not found");
      return result;
    },
    { params: t.Object({ id: t.String() }) },
  )
  .get(
    "/",
    async ({ query }) => {
      return await findUserManys({ limit: query.limit, offset: query.offset });
    },
    { query: t.Object({ limit: t.Optional(t.Numeric()), offset: t.Optional(t.Numeric()) }) },
  )
  .get(
    "/by-username/:username",
    async ({ params, status }) => {
      const result = await getUserByUsername({ username: params.username });
      if (!result) return status(404, "Not found");
      return result;
    },
    { params: t.Object({ username: t.String() }) },
  );
```

### `httpTrpcPlugin` — tRPC Routers

```typescript
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { findUserById, findUserManys, getUserByUsername } from "../sql-queries/User.js";

export const userRouter = router({
  findUserById: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      return await findUserById({ id: input.id });
    }),

  findUserManys: publicProcedure
    .input(z.object({ limit: z.coerce.number().optional(), offset: z.coerce.number().optional() }))
    .query(async ({ input }) => {
      return await findUserManys({ limit: input.limit, offset: input.offset });
    }),

  getUserByUsername: publicProcedure
    .input(z.object({ username: z.string() }))
    .query(async ({ input }) => {
      return await getUserByUsername({ username: input.username });
    }),
});
```

### `httpOrpcPlugin` — oRPC Handlers

```typescript
import { findUserById, findUserManys, getUserByUsername } from "../sql-queries/User.js";
import { os, type } from "@orpc/server";

export const findById = os
  .input(type<{ id: string }>())
  .handler(async ({ input }) => await findUserById(input));

export const list = os
  .input(type<{ limit?: number; offset?: number }>())
  .handler(async ({ input }) => await findUserManys(input));

export const findByUsername = os
  .input(type<{ username: string }>())
  .handler(async ({ input }) => await getUserByUsername(input));

export const userRouter = { findById, list, findByUsername };
```

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

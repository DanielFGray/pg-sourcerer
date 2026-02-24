## Installation

```bash
npm install @danielfgray/pg-sourcerer
```

## Quick Start

1. Create a config file `pgsourcerer.config.ts`:

```typescript
import { defineConfig, typesPlugin, zod, express } from "@danielfgray/pg-sourcerer";

export default defineConfig({
  connectionString: process.env.DATABASE_URL,
  schemas: ["public"],
  outputDir: "./src/generated",
  plugins: [typesPlugin(), zod(), express()],
});
```

2. Run the generator:

```bash
pgsourcerer generate
```

## CLI

```text
pgsourcerer generate [options]

Options:
  -c, --config <path>   Path to config file
  -o, --output <dir>    Override output directory
  -n, --dry-run         Show what would be generated
  --log-level <level>   debug | info | none
```

## Plugins

| Plugin        | Provides                         | Description                               |
| ------------- | -------------------------------- | ----------------------------------------- |
| `typesPlugin` | TypeScript interfaces            | `User`, `UserInsert`, `UserUpdate`        |
| `zod`         | Zod schemas                      | Runtime validation with inferred types    |
| `arktype`     | ArkType validators               | String-based type syntax with inference   |
| `valibot`     | Valibot schemas                  | Modular validation with tree-shaking      |
| `effect`      | Effect SQL Models + Repositories | Models, repos, and optional HTTP API      |
| `kysely`      | Kysely types + queries           | DB interface + type-safe CRUD functions   |
| `sqlQueries`  | Raw SQL functions                | Parameterized query helpers               |
| `httpElysia`  | Elysia routes                    | REST endpoints with TypeBox validation    |
| `httpExpress` | Express routes                   | REST endpoints with validation middleware |
| `httpHono`    | Hono routes                      | REST endpoints with standard-validator    |
| `httpTrpc`    | tRPC routers                     | Type-safe RPC with Zod validation         |
| `httpOrpc`    | oRPC handlers                    | Lightweight RPC with TypeScript inference |

## What Gets Generated

Given a PostgreSQL table like:

```sql
create type app_public.user_role as enum('admin', 'moderator', 'user');
create domain app_public.username as citext check(length(value) >= 2 and length(value) <= 24 and value ~ '^[a-zA-Z][a-zA-Z0-9_-]+$');
create domain app_public.url as text check(value ~ '^https?://\S+');

create table app_public.users (
  id uuid primary key default gen_random_uuid(),
  username app_public.username not null unique,
  avatar_url app_public.url,
  role app_public.user_role not null default 'user',
  bio text not null check(length(bio) <= 4000) default '',
  is_verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table app_public.users enable row level security;
create unique index on app_public.users (username);
create index on app_public.users (created_at desc);

grant
  select,
  update(username, name, bio, avatar_url)
  on app_public.users to :DATABASE_VISITOR;
```

Each plugin generates different artifacts:

```typescript
export type UserRole = "admin" | "moderator" | "user";

export type Url = string;

export type Username = string;

export interface User {
  readonly id: string;
  readonly username: Username;
  readonly name: string | null;
  readonly avatar_url: Url | null;
  readonly role: UserRole;
  readonly bio: string;
  readonly is_verified: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface UserUpdate {
  username?: Username;
  name?: string | null;
  avatar_url?: Url | null;
  bio?: string;
}
```

```typescript
import { z } from "zod";

export const UserRole = z.enum(["admin", "moderator", "user"] as const);

export type UserRole = z.infer<typeof UserRole>;

export const Url = z.string().regex(/^https?:\/\/\S+/);

export type Url = z.infer<typeof Url>;

export const Username = z.string().min(2).max(24).regex(/^[a-zA-Z][a-zA-Z0-9_-]+$/);

export type Username = z.infer<typeof Username>;

export const User = z.object({
  id: z.uuid(),
  username: Username,
  name: z.string().nullable(),
  avatar_url: Url.nullable(),
  role: UserRole,
  bio: z.string().max(4000),
  is_verified: z.boolean(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export type User = z.infer<typeof User>;

export const UserUpdate = User.pick({
  username: true,
  name: true,
  avatar_url: true,
  bio: true,
}).partial();

export type UserUpdate = z.infer<typeof UserUpdate>;
```

```typescript
import { type } from "arktype";

export const UserRole = type("'admin' | 'moderator' | 'user'");

export type UserRole = typeof UserRole.infer;

export const Url = type("string & /^https?:\\/\\/\\S+/");

export type Url = typeof Url.infer;

export const Username = type("string >= 2 <= 24 & /^[a-zA-Z][a-zA-Z0-9_-]+$/");

export type Username = typeof Username.infer;

export const User = type({
  id: "string.uuid",
  username: Username,
  name: "string | null",
  avatar_url: Url.or(type("null")),
  role: UserRole,
  bio: "string <= 4000",
  is_verified: "boolean",
  created_at: "Date",
  updated_at: "Date",
});

export type User = typeof User.infer;

export const UserUpdate = User.pick("username", "name", "avatar_url", "bio").partial();

export type UserUpdate = typeof UserUpdate.infer;
```

```typescript
import * as v from "valibot";

export const UserRole = v.picklist(["admin", "moderator", "user"]);

export type UserRole = v.InferOutput<typeof UserRole>;

export const Url = v.pipe(v.string(), v.regex(/^https?:\/\/\S+/));

export type Url = v.InferOutput<typeof Url>;

export const Username = v.pipe(
  v.string(),
  v.minLength(2),
  v.maxLength(24),
  v.regex(/^[a-zA-Z][a-zA-Z0-9_-]+$/),
);

export type Username = v.InferOutput<typeof Username>;

export const User = v.object({
  id: v.pipe(v.string(), v.uuid()),
  username: Username,
  name: v.nullable(v.string()),
  avatar_url: v.nullable(Url),
  role: UserRole,
  bio: v.pipe(v.string(), v.maxLength(4000)),
  is_verified: v.boolean(),
  created_at: v.date(),
  updated_at: v.date(),
});

export type User = v.InferOutput<typeof User>;

export const UserUpdate = v.object({
  username: v.optional(Username),
  name: v.optional(v.nullable(v.string())),
  avatar_url: v.optional(v.nullable(Url)),
  bio: v.optional(v.pipe(v.string(), v.maxLength(4000))),
});

export type UserUpdate = v.InferOutput<typeof UserUpdate>;
```

```typescript
import type { ColumnType } from "kysely";

export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;

export type UserRole = "admin" | "moderator" | "user";

export interface User {
  id: Generated<string>;
  username: Generated<string>;
  name: Generated<string | null>;
  avatar_url: Generated<string | null>;
  role: Generated<UserRole>;
  bio: Generated<string>;
  is_verified: Generated<boolean>;
  created_at: Generated<ColumnType<Date, Date | string, Date | string>>;
  updated_at: Generated<ColumnType<Date, Date | string, Date | string>>;
}

export interface DB {
  "app_public.users": User;
}
```

The unified `kysely` plugin generates both type definitions and query functions:

```typescript
import type { Updateable } from "kysely";
import type { User } from "./DB.js";

export const userListByCreatedAt = (
  {
    cursorCreatedAt,
    cursorId,
    limit = 50,
  }: {
    cursorCreatedAt?: Date;
    cursorId?: string;
    limit?: number;
  },
) => db.selectFrom("users").select([
  "id",
  "username",
  "name",
  "avatar_url",
  "role",
  "bio",
  "is_verified",
  "created_at",
  "updated_at",
]).$if(
  cursorCreatedAt !== undefined && cursorId !== undefined,
  qb => qb.where(eb => eb.or([
    eb("created_at", "<", cursorCreatedAt!),
    eb.and([eb("created_at", "=", cursorCreatedAt!), eb("id", "<", cursorId!)]),
  ])),
).orderBy("created_at", "desc").orderBy("id", "desc").limit(limit);

export const userUpdate = (
  {
    id,
    ...data
  }: Pick<User, "id"> & Omit<Updateable<User>, "id">,
) => db.updateTable("users").set(data).where("id", "=", id).returningAll();

export const userFindByUsername = (
  {
    username,
  }: Pick<User, "username">,
) => db.selectFrom("users").select([
  "id",
  "username",
  "name",
  "avatar_url",
  "role",
  "bio",
  "is_verified",
  "created_at",
  "updated_at",
]).where("username", "=", username);
```

Kysely also generates type-safe query builder functions:

```typescript
import { sql } from "../../db.js";
import type { User } from "../types/User.js";

export const userUpdate = (
  {
    id,
    ...fields
  }: Pick<User, "id"> & Partial<Pick<User, "username" | "name" | "avatar_url" | "bio">>,
) => sql`update app_public.users set ${sql(fields, Object.keys(fields))} where id = ${id}`;

export const userFindByUsername = (
  {
    username,
  }: Pick<User, "username">,
) => sql<User[]>`select id, username, name, avatar_url, role, bio, is_verified, created_at, updated_at from app_public.users where username = ${username}`;

export const userListByCreatedAt = (
  {
    limit = 50,
    offset = 0,
  }: {
    limit?: number;
    offset?: number;
  },
) => sql<User[]>`select id, username, name, avatar_url, role, bio, is_verified, created_at, updated_at from app_public.users order by created_at desc limit ${limit} offset ${offset}`;
```

with `sqlQueries({ sqlStyle: "tag" })`

not using tagged templates? got you covered with `sqlQueries({ sqlStyle: "string" })`

```typescript
export class User extends Model.Class<User>("users")({
  id: Model.Generated(S.UUID),
  username: Username,
  name: S.NullOr(S.String),
  avatar_url: S.NullOr(Url),
  role: UserRole,
  bio: S.String,
  is_verified: S.Boolean,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}

export class UserRepo extends Effect.Service<UserRepo>()("UserRepo", {
  effect: Effect.gen(function*() {
    const repo = yield* Model.makeRepository(User, {
      tableName: "app_public.users",
      spanPrefix: "UserRepo",
      idColumn: "id",
    });

    return {
      ...repo,
    };
  }),
}) {}
```

The `effect` plugin generates Model classes, optional Repositories, and optional HTTP APIs.

Set `repoModel: false` (or `repos: false` for legacy configs) to skip `Model.makeRepository`
and expose query functions from the active `queries` plugin (kysely/sql-queries).

```typescript
export class UserNotFound extends S.TaggedError<UserNotFound>()("UserNotFound", {
  id: S.UUID,
}) {}

export const UserApiGroup = HttpApiGroup.make("users").prefix("/api/users").add(
  HttpApiEndpoint.get("findById")`/${HttpApiSchema.param("id", S.UUID)}`.addSuccess(User).addError(UserNotFound, {
    status: 404,
  }),
).add(
  HttpApiEndpoint.post("insert", "/").setPayload(User.insert).addSuccess(User, {
    status: 201,
  }),
).add(
  HttpApiEndpoint.put("update")`/${HttpApiSchema.param("id", S.UUID)}`.setPayload(User.update).addSuccess(User).addError(UserNotFound, {
    status: 404,
  }),
).add(
  HttpApiEndpoint.del("delete")`/${HttpApiSchema.param("id", S.UUID)}`.addError(UserNotFound, {
    status: 404,
  }),
);

export const UserApi = HttpApi.make("UserApi").add(UserApiGroup);
```

```typescript
import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { Layer } from "effect";
import { UserApiLive } from "./user.js";

export const ServerLive = HttpApiBuilder.serve().pipe(Layer.provide([UserApiLive]), HttpServer.withLogAddress);
```

```typescript
import { Elysia } from "elysia";
import { z } from "zod";
import { findUserById, findUserManys, getUserByUsername } from "../queries/User.js";
import { User, UserUpdate } from "../schemas/User.js";

export const userRoutes = new Elysia({
  prefix: "/users",
})
  .patch(
    "/:id",
    async ({ params, body }) => {
      const result = await userUpdate({
        id: params.id,
        ...body,
      }).executeTakeFirstOrThrow();

      return result;
    },
    {
      body: UserUpdate,
      params: User.pick({ id: true }),
    },
  )
  .get(
    "/by-username/:username",
    async ({ params, status }) => {
      const result = await userFindByUsername({ username: params.username, }).executeTakeFirst();
      if (!result) return status(404, "Not found");
      return result;
    },
    {
      params: User.pick({ username: true }),
    }
  );
```

```typescript
import { Router } from "express";
import { z } from "zod";
import { findUserById, listUsers, updateUser } from "../queries/User.js";
import { User, UserUpdate } from "../schemas/User.js";

export const userRoutes = Router();

userRoutes.get("/:id", async (req, res) => {
  const { params } = z.object({
    params: z.object({ id: User.shape.id }),
  }).parse({ params: req.params }})
  const result = await findUserById({ id: params.id });
  if (!result) return res.status(404).json({ error: "Not found" });
  return res.json(result);
});

userRoutes.get("/", async (req, res) => {
  const query = z.object({
    cursorCreatedAt: z.coerce.date().optional(),
    cursorId: z.string().optional(),
    limit: z.coerce.number().optional(),
  }).parse(req.query);

  const result = await userListByCreatedAt({
    cursorCreatedAt: query.cursorCreatedAt,
    cursorId: query.cursorId,
    limit: query.limit,
  }).execute();

  return res.json(result);
});

userRoutes.put("/:id", async (req, res) => {
  const { params, body } = z.object({
    params: z.object({ id: User.shape.id })
    body: UserUpdate,
  }).parse({ params: req.params, body: req.body }})
  const result = await updateUser({ id: params.id, ...body });
  return res.json(result);
});
```

```typescript
import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { z } from "zod";
import { findUserById, listUsers, updateUser } from "../queries/User.js";
import { UserUpdate } from "../schemas/User.js";

export const userRoutes = new Hono()
  .get("/:id", async ctx => {
    const id = ctx.req.param("id");
    const result = await findUserById({ id });
    if (!result) return ctx.json({ error: "Not found" }, 404);
    return ctx.json(result);
  })
  .get(
    "/by-created-at",
    sValidator(
      "query",
      z.object({
        cursorCreatedAt: z.coerce.date().optional(),
        cursorId: z.string().optional(),
        limit: z.coerce.number().optional(),
      }),
    ),
    async ctx => {
      const query = ctx.req.valid("query");
      return ctx.json(await userListByCreatedAt({
        cursorCreatedAt: query.cursorCreatedAt,
        cursorId: query.cursorId,
        limit: query.limit,
      }).execute());
    },
  )
  .put("/:id", sValidator("json", UserUpdate), async ctx => {
    const id = ctx.req.param("id");
    const data = ctx.req.valid("json");
    const result = await updateUser({ id, ...data });
    return ctx.json(result);
  });
```

```typescript
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { userFindById, userListByCreatedAt, userFindByUsername } from "../queries.js";

export const userRouter = router({
  findById: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      return userFindById(input).executeTakeFirst();
    }),

  listByCreatedAt: publicProcedure
    .input(z.object({
      cursorCreatedAt: z.coerce.date().optional(),
      cursorId: z.string().optional(),
      limit: z.coerce.number().optional(),
    }))
    .query(async ({ input }) => {
      return userListByCreatedAt(input).execute();
    }),

  findByUsername: publicProcedure
    .input(z.object({ username: z.string() }))
    .query(async ({ input }) => {
      return userFindByUsername(input).executeTakeFirst();
    }),
});
```

```typescript
import { z } from "zod";
import { os } from "@orpc/server";
import { userFindById, userListByCreatedAt, userFindByUsername } from "../queries.js";

export const findById = os
  .input(z.object({ id: z.string() }))
  .handler(async ({ input }) => {
    return userFindById(input).executeTakeFirst();
  });

export const listByCreatedAt = os
  .input(z.object({
    cursorCreatedAt: z.coerce.date().optional(),
    cursorId: z.string().optional(),
    limit: z.coerce.number().optional(),
  }))
  .handler(async ({ input }) => {
    return userListByCreatedAt(input).execute();
  });

export const findByUsername = os
  .input(z.object({ username: z.string() }))
  .handler(async ({ input }) => {
    return userFindByUsername(input).executeTakeFirst();
  });

export const router = {
  user: {
    findById,
    listByCreatedAt,
    findByUsername,
  },
};
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
      hints: { ts: "string", zod: "z.string().uuid()" },
    },
    {
      match: { table: "users", column: "email" },
      hints: { ts: "Email", zod: "emailSchema", import: { Email: "./branded.js" } },
    },
  ],
});
```

## Writing Plugins

Plugins generate code from the introspected database schema. Use `definePlugin` for a simple, synchronous API.

### Minimal Example

```typescript
import { definePlugin, conjure, Schema as S } from "@danielfgray/pg-sourcerer";

const { ts, exp } = conjure;

export const myPlugin = definePlugin({
  name: "my-plugin",
  provides: ["my-types"],
  configSchema: S.Struct({
    outputDir: S.String,
  }),
  inflection: {
    outputFile: ctx => `${ctx.entityName}.ts`,
    symbolName: (entity, kind) => `${entity}${kind}`,
  },

  run: (ctx, config) => {
    ctx.ir.entities.forEach((entity, name) => {
      // Build interface properties from row shape
      const props = entity.shapes.row.fields.map(field => ({
        name: field.name,
        type: field.nullable ? ts.union(ts.string(), ts.null()) : ts.string(),
        optional: field.optional,
      }));

      // Create exported interface with symbol tracking
      const statement = exp.interface(
        `${name}Row`,
        { capability: "my-types", entity: name, shape: "row" },
        props,
      );

      // Emit file
      ctx
        .file(`${config.outputDir}/${name}.ts`)
        .header("// Auto-generated\n")
        .ast(conjure.program(statement))
        .emit();
    });
  },
});
```

### Plugin Context

The `ctx` object provides:

| Property                     | Description                                         |
| ---------------------------- | --------------------------------------------------- |
| `ctx.ir`                     | Semantic IR with `entities`, `enums`, `extensions`  |
| `ctx.inflection`             | Naming utilities (`camelCase`, `singularize`, etc.) |
| `ctx.typeHints`              | User-configured type overrides                      |
| `ctx.file(path)`             | Create a `FileBuilder` for structured emission      |
| `ctx.emit(path, content)`    | Emit raw string content                             |
| `ctx.getArtifact(cap)`       | Read data from upstream plugins                     |
| `ctx.setArtifact(cap, data)` | Share data with downstream plugins                  |

### Conjure API

Conjure builds AST nodes for code generation:

```typescript
// Method chains: z.string().uuid()
conjure.id("z").method("string").method("uuid").build();

// Object literals: { path: "/users", method: "GET" }
conjure.obj().prop("path", conjure.str("/users")).prop("method", conjure.str("GET")).build();

// TypeScript types
conjure.ts.string(); // string
conjure.ts.ref("User"); // User
conjure.ts.array(conjure.ts.string()); // string[]
conjure.ts.union(conjure.ts.string(), ts.null()); // string | null

// Statements
conjure.stmt.const("x", conjure.num(42)); // const x = 42
conjure.stmt.return(conjure.id("result")); // return result

// Exports with symbol tracking (for import resolution)
exp.interface("UserRow", symbolCtx, properties);
exp.const("UserSchema", symbolCtx, schemaExpr);
exp.typeAlias("UserId", symbolCtx, ts.string());

// Print to code string
conjure.print(node);
```

### Depending on Other Plugins

Use `requires` to depend on capabilities from other plugins:

```typescript
definePlugin({
  name: "zod-schemas",
  requires: ["types"], // Must run after types plugin
  provides: ["schemas:zod"],
  // ...
});
```

Access upstream artifacts:

```typescript
run: ctx => {
  const typesArtifact = ctx.getArtifact("types");
  // Use data from types plugin
};
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

MIT -- see [LICENSE](./LICENSE)

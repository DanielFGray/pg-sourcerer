# pg-sourcerer

PostgreSQL code generation framework with a plugin ecosystem. Introspects your database schema and generates TypeScript types, Zod schemas, Effect Models, and more.

Built with [Effect-ts](https://effect.website/) for robust error handling and composability.

## Installation

###

```bash
npm install @danielfgray/pg-sourcerer
```

## Quick Start

1. Create a config file `pgsourcerer.config.ts`:

###

```typescript
import { defineConfig, typesPlugin, zod } from "@danielfgray/pg-sourcerer";

export default defineConfig({
  connectionString: process.env.DATABASE_URL,
  schemas: ["public"],
  outputDir: "./src/generated",
  plugins: [typesPlugin({ outputDir: "types" }), zod({ outputDir: "schemas" })],
});
```

2. Run the generator:

###

```bash
pgsourcerer generate
```

## CLI

###

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

###

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
create unique index on app_public.users (username);
create index on app_public.users (created_at desc);

grant
  select,
  update(username, name, bio, avatar_url)
  on app_public.users to :DATABASE_VISITOR;
```

Each plugin generates different artifacts:

### `typesPlugin` -- TypeScript Interfaces

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

```typescript
export interface Comment {
    readonly id: string;
    readonly post_id: number;
    readonly user_id: string | null;
    readonly parent_id: string | null;
    readonly body: string;
    readonly search: unknown;
    readonly created_at: Date;
    readonly updated_at: Date;
}

export interface CommentsVote {
    readonly comment_id: string;
    readonly user_id: string;
    readonly vote: unknown;
    readonly created_at: Date;
}

export interface Post {
    readonly id: number;
    readonly user_id: string;
    readonly body: string;
    readonly tags: string[] | null;
    readonly mentions: string[] | null;
    readonly search: unknown;
    readonly created_at: Date;
    readonly updated_at: Date;
}

export interface PostsVote {
    readonly post_id: number;
    readonly user_id: string;
    readonly vote: unknown;
    readonly created_at: Date;
}

export interface RecentPost {
    readonly id: number | null;
    readonly user_id: string | null;
    readonly body: string | null;
    readonly tags: string[] | null;
    readonly mentions: string[] | null;
    readonly search: unknown | null;
    readonly created_at: Date | null;
    readonly updated_at: Date | null;
}

export interface TopTag {
    readonly tag: string | null;
    readonly count: number | null;
}

export interface UserEmail {
    readonly id: string;
    readonly user_id: string;
    readonly email: string;
    readonly is_verified: boolean;
    readonly is_primary: boolean;
    readonly created_at: Date;
    readonly updated_at: Date;
}

export interface User {
    readonly id: string;
    readonly username: unknown;
    readonly name: string | null;
    readonly avatar_url: unknown | null;
    readonly role: unknown;
    readonly bio: string;
    readonly is_verified: boolean;
    readonly created_at: Date;
    readonly updated_at: Date;
}
```

### `zodPlugin` -- Zod Schemas

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
  id: z.string().uuid(),
  username: z.string().optional(),
  name: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
  bio: z.string().optional(),
});

export type UserUpdate = z.infer<typeof UserUpdate>;
```

```typescript
import { z } from "zod";

export const SearchMatchType = z.enum(["fuzzy", "exact"]);

export type SearchMatchType = z.infer<typeof SearchMatchType>;

export const UserRole = z.enum(["admin", "moderator", "user"]);

export type UserRole = z.infer<typeof UserRole>;

export const VoteType = z.enum(["down", "up"]);

export type VoteType = z.infer<typeof VoteType>;

export const Comment = z.object({
    id: z.uuid(),
    post_id: z.number(),
    user_id: z.uuid().nullable().optional(),
    parent_id: z.uuid().nullable().optional(),
    body: z.string(),
    search: z.string(),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date()
});

export const CommentInsert = z.object({
    id: z.uuid().optional(),
    post_id: z.number(),
    user_id: z.uuid().nullable().optional(),
    parent_id: z.uuid().nullable().optional(),
    body: z.string(),
    search: z.string().optional(),
    created_at: z.coerce.date().optional(),
    updated_at: z.coerce.date().optional()
});

export type CommentInsert = z.infer<typeof CommentInsert>;

export const CommentUpdate = z.object({
    id: z.uuid().optional(),
    post_id: z.number().optional(),
    user_id: z.uuid().nullable().optional(),
    parent_id: z.uuid().nullable().optional(),
    body: z.string().optional(),
    search: z.string().optional(),
    created_at: z.coerce.date().optional(),
    updated_at: z.coerce.date().optional()
});

export type CommentUpdate = z.infer<typeof CommentUpdate>;

export const CommentsVote = z.object({
    comment_id: z.uuid(),
    user_id: z.uuid(),
    vote: VoteType,
    created_at: z.coerce.date()
});

export const CommentsVoteInsert = z.object({
    comment_id: z.uuid(),
    user_id: z.uuid().optional(),
    vote: VoteType,
    created_at: z.coerce.date().optional()
});

export type CommentsVoteInsert = z.infer<typeof CommentsVoteInsert>;

export const CommentsVoteUpdate = z.object({
    comment_id: z.uuid().optional(),
    user_id: z.uuid().optional(),
    vote: VoteType.optional(),
    created_at: z.coerce.date().optional()
});

export type CommentsVoteUpdate = z.infer<typeof CommentsVoteUpdate>;

export const Post = z.object({
    id: z.number(),
    user_id: z.uuid(),
    body: z.string(),
    tags: z.string().array().nullable().optional(),
    mentions: z.string().array().nullable().optional(),
    search: z.string(),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date()
});

export const PostInsert = z.object({
    id: z.number().optional(),
    user_id: z.uuid().optional(),
    body: z.string(),
    tags: z.string().array().nullable().optional(),
    mentions: z.string().array().nullable().optional(),
    search: z.string().optional(),
    created_at: z.coerce.date().optional(),
    updated_at: z.coerce.date().optional()
});

export type PostInsert = z.infer<typeof PostInsert>;

export const PostUpdate = z.object({
    id: z.number().optional(),
    user_id: z.uuid().optional(),
    body: z.string().optional(),
    tags: z.string().array().nullable().optional(),
    mentions: z.string().array().nullable().optional(),
    search: z.string().optional(),
    created_at: z.coerce.date().optional(),
    updated_at: z.coerce.date().optional()
});

export type PostUpdate = z.infer<typeof PostUpdate>;

export const PostsVote = z.object({
    post_id: z.number(),
    user_id: z.uuid(),
    vote: VoteType,
    created_at: z.coerce.date()
});

export const PostsVoteInsert = z.object({
    post_id: z.number(),
    user_id: z.uuid().optional(),
    vote: VoteType,
    created_at: z.coerce.date().optional()
});

export type PostsVoteInsert = z.infer<typeof PostsVoteInsert>;

export const PostsVoteUpdate = z.object({
    post_id: z.number().optional(),
    user_id: z.uuid().optional(),
    vote: VoteType.optional(),
    created_at: z.coerce.date().optional()
});

export type PostsVoteUpdate = z.infer<typeof PostsVoteUpdate>;

export const RecentPost = z.object({
    id: z.number().nullable().optional(),
    user_id: z.uuid().nullable().optional(),
    body: z.string().nullable().optional(),
    tags: z.string().array().nullable().optional(),
    mentions: z.string().array().nullable().optional(),
    search: z.string().nullable().optional(),
    created_at: z.coerce.date().nullable().optional(),
    updated_at: z.coerce.date().nullable().optional()
});

export const TopTag = z.object({
    tag: z.string().nullable().optional(),
    count: z.number().nullable().optional()
});

export const UserEmail = z.object({
    id: z.uuid(),
    user_id: z.uuid(),
    email: z.string(),
    is_verified: z.boolean(),
    is_primary: z.boolean(),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date()
});

export const UserEmailInsert = z.object({
    id: z.uuid().optional(),
    user_id: z.uuid().optional(),
    email: z.string(),
    is_verified: z.boolean().optional(),
    is_primary: z.boolean().optional(),
    created_at: z.coerce.date().optional(),
    updated_at: z.coerce.date().optional()
});

export type UserEmailInsert = z.infer<typeof UserEmailInsert>;

export const UserEmailUpdate = z.object({
    id: z.uuid().optional(),
    user_id: z.uuid().optional(),
    email: z.string().optional(),
    is_verified: z.boolean().optional(),
    is_primary: z.boolean().optional(),
    created_at: z.coerce.date().optional(),
    updated_at: z.coerce.date().optional()
});

export type UserEmailUpdate = z.infer<typeof UserEmailUpdate>;

export const User = z.object({
    id: z.uuid(),
    username: z.string(),
    name: z.string().nullable().optional(),
    avatar_url: z.string().nullable().optional(),
    role: UserRole,
    bio: z.string(),
    is_verified: z.boolean(),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date()
});

export const UserInsert = z.object({
    id: z.uuid().optional(),
    username: z.string(),
    name: z.string().nullable().optional(),
    avatar_url: z.string().nullable().optional(),
    role: UserRole.optional(),
    bio: z.string().optional(),
    is_verified: z.boolean().optional(),
    created_at: z.coerce.date().optional(),
    updated_at: z.coerce.date().optional()
});

export type UserInsert = z.infer<typeof UserInsert>;

export const UserUpdate = z.object({
    id: z.uuid().optional(),
    username: z.string().optional(),
    name: z.string().nullable().optional(),
    avatar_url: z.string().nullable().optional(),
    role: UserRole.optional(),
    bio: z.string().optional(),
    is_verified: z.boolean().optional(),
    created_at: z.coerce.date().optional(),
    updated_at: z.coerce.date().optional()
});

export type UserUpdate = z.infer<typeof UserUpdate>;
```

### `arktypePlugin` -- ArkType Validators

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

```typescript
import { type } from "arktype";

export const Comment = type({
    id: "string.uuid",
    post_id: "number",
    user_id: "string.uuid | null?",
    parent_id: "string.uuid | null?",
    body: "string",
    search: "string",
    created_at: "Date",
    updated_at: "Date"
});

export const CommentInsert = type({
    id: "string.uuid?",
    post_id: "number",
    user_id: "string.uuid | null?",
    parent_id: "string.uuid | null?",
    body: "string",
    search: "string?",
    created_at: "Date?",
    updated_at: "Date?"
});

export type CommentInsert = typeof CommentInsert.infer;

export const CommentUpdate = type({
    id: "string.uuid?",
    post_id: "number?",
    user_id: "string.uuid | null?",
    parent_id: "string.uuid | null?",
    body: "string?",
    search: "string?",
    created_at: "Date?",
    updated_at: "Date?"
});

export type CommentUpdate = typeof CommentUpdate.infer;

export const CommentUpdateInput = type({
    id: "string.uuid",
    post_id: "number?",
    user_id: "string.uuid | null?",
    parent_id: "string.uuid | null?",
    body: "string?",
    search: "string?",
    created_at: "Date?",
    updated_at: "Date?"
});

export type CommentUpdateInput = typeof CommentUpdateInput.infer;

export const CommentsVote = type({
    comment_id: "string.uuid",
    user_id: "string.uuid",
    vote: VoteType,
    created_at: "Date"
});

export const CommentsVoteInsert = type({
    comment_id: "string.uuid",
    user_id: "string.uuid?",
    vote: VoteType,
    created_at: "Date?"
});

export type CommentsVoteInsert = typeof CommentsVoteInsert.infer;

export const CommentsVoteUpdate = type({
    comment_id: "string.uuid?",
    user_id: "string.uuid?",
    vote: VoteType,
    created_at: "Date?"
});

export type CommentsVoteUpdate = typeof CommentsVoteUpdate.infer;

export const CommentsVoteUpdateInput = type({
    comment_id: "string.uuid",
    user_id: "string.uuid",
    vote: VoteType.optional(),
    created_at: "Date?"
});

export type CommentsVoteUpdateInput = typeof CommentsVoteUpdateInput.infer;

export const Post = type({
    id: "number",
    user_id: "string.uuid",
    body: "string",
    tags: "string[] | null?",
    mentions: "string[] | null?",
    search: "string",
    created_at: "Date",
    updated_at: "Date"
});

export const PostInsert = type({
    id: "number?",
    user_id: "string.uuid?",
    body: "string",
    tags: "string[] | null?",
    mentions: "string[] | null?",
    search: "string?",
    created_at: "Date?",
    updated_at: "Date?"
});

export type PostInsert = typeof PostInsert.infer;

export const PostUpdate = type({
    id: "number?",
    user_id: "string.uuid?",
    body: "string?",
    tags: "string[] | null?",
    mentions: "string[] | null?",
    search: "string?",
    created_at: "Date?",
    updated_at: "Date?"
});

export type PostUpdate = typeof PostUpdate.infer;

export const PostUpdateInput = type({
    id: "number",
    user_id: "string.uuid?",
    body: "string?",
    tags: "string[] | null?",
    mentions: "string[] | null?",
    search: "string?",
    created_at: "Date?",
    updated_at: "Date?"
});

export type PostUpdateInput = typeof PostUpdateInput.infer;

export const PostsVote = type({
    post_id: "number",
    user_id: "string.uuid",
    vote: VoteType,
    created_at: "Date"
});

export const PostsVoteInsert = type({
    post_id: "number",
    user_id: "string.uuid?",
    vote: VoteType,
    created_at: "Date?"
});

export type PostsVoteInsert = typeof PostsVoteInsert.infer;

export const PostsVoteUpdate = type({
    post_id: "number?",
    user_id: "string.uuid?",
    vote: VoteType,
    created_at: "Date?"
});

export type PostsVoteUpdate = typeof PostsVoteUpdate.infer;

export const PostsVoteUpdateInput = type({
    post_id: "number",
    user_id: "string.uuid",
    vote: VoteType.optional(),
    created_at: "Date?"
});

export type PostsVoteUpdateInput = typeof PostsVoteUpdateInput.infer;

export const RecentPost = type({
    id: "number | null?",
    user_id: "string.uuid | null?",
    body: "string | null?",
    tags: "string[] | null?",
    mentions: "string[] | null?",
    search: "string | null?",
    created_at: "Date | null?",
    updated_at: "Date | null?"
});

export const TopTag = type({
    tag: "string | null?",
    count: "number | null?"
});

export const UserEmail = type({
    id: "string.uuid",
    user_id: "string.uuid",
    email: "string",
    is_verified: "boolean",
    is_primary: "boolean",
    created_at: "Date",
    updated_at: "Date"
});

export const UserEmailInsert = type({
    id: "string.uuid?",
    user_id: "string.uuid?",
    email: "string",
    is_verified: "boolean?",
    is_primary: "boolean?",
    created_at: "Date?",
    updated_at: "Date?"
});

export type UserEmailInsert = typeof UserEmailInsert.infer;

export const UserEmailUpdate = type({
    id: "string.uuid?",
    user_id: "string.uuid?",
    email: "string?",
    is_verified: "boolean?",
    is_primary: "boolean?",
    created_at: "Date?",
    updated_at: "Date?"
});

export type UserEmailUpdate = typeof UserEmailUpdate.infer;

export const UserEmailUpdateInput = type({
    id: "string.uuid",
    user_id: "string.uuid?",
    email: "string?",
    is_verified: "boolean?",
    is_primary: "boolean?",
    created_at: "Date?",
    updated_at: "Date?"
});

export type UserEmailUpdateInput = typeof UserEmailUpdateInput.infer;

export const User = type({
    id: "string.uuid",
    username: "string",
    name: "string | null?",
    avatar_url: "string | null?",
    role: UserRole,
    bio: "string",
    is_verified: "boolean",
    created_at: "Date",
    updated_at: "Date"
});

export const UserInsert = type({
    id: "string.uuid?",
    username: "string",
    name: "string | null?",
    avatar_url: "string | null?",
    role: UserRole,
    bio: "string?",
    is_verified: "boolean?",
    created_at: "Date?",
    updated_at: "Date?"
});

export type UserInsert = typeof UserInsert.infer;

export const UserUpdate = type({
    id: "string.uuid?",
    username: "string?",
    name: "string | null?",
    avatar_url: "string | null?",
    role: UserRole,
    bio: "string?",
    is_verified: "boolean?",
    created_at: "Date?",
    updated_at: "Date?"
});

export type UserUpdate = typeof UserUpdate.infer;

export const UserUpdateInput = type({
    id: "string.uuid",
    username: "string?",
    name: "string | null?",
    avatar_url: "string | null?",
    role: UserRole.optional(),
    bio: "string?",
    is_verified: "boolean?",
    created_at: "Date?",
    updated_at: "Date?"
});

export type UserUpdateInput = typeof UserUpdateInput.infer;

export const SearchMatchType = type("'fuzzy' | 'exact'");

export type SearchMatchType = typeof SearchMatchType.infer;

export const UserRole = type("'admin' | 'moderator' | 'user'");

export type UserRole = typeof UserRole.infer;

export const VoteType = type("'down' | 'up'");

export type VoteType = typeof VoteType.infer;
```

### `valibotPlugin` -- Valibot Schemas

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

```typescript
import { v } from "valibot";

export const Comment = v.object({
    id: v.pipe(v.string(), v.uuid()),
    post_id: v.number(),
    user_id: v.optional(v.nullable(v.pipe(v.string(), v.uuid()))),
    parent_id: v.optional(v.nullable(v.pipe(v.string(), v.uuid()))),
    body: v.string(),
    search: v.string(),
    created_at: v.date(),
    updated_at: v.date()
});

export const CommentInsert = v.object({
    id: v.optional(v.pipe(v.string(), v.uuid())),
    post_id: v.number(),
    user_id: v.optional(v.nullable(v.pipe(v.string(), v.uuid()))),
    parent_id: v.optional(v.nullable(v.pipe(v.string(), v.uuid()))),
    body: v.string(),
    search: v.optional(v.string()),
    created_at: v.optional(v.date()),
    updated_at: v.optional(v.date())
});

export type CommentInsert = v.InferOutput<typeof CommentInsert>;

export const CommentUpdate = v.object({
    id: v.optional(v.pipe(v.string(), v.uuid())),
    post_id: v.optional(v.number()),
    user_id: v.optional(v.nullable(v.pipe(v.string(), v.uuid()))),
    parent_id: v.optional(v.nullable(v.pipe(v.string(), v.uuid()))),
    body: v.optional(v.string()),
    search: v.optional(v.string()),
    created_at: v.optional(v.date()),
    updated_at: v.optional(v.date())
});

export type CommentUpdate = v.InferOutput<typeof CommentUpdate>;

export const CommentsVote = v.object({
    comment_id: v.pipe(v.string(), v.uuid()),
    user_id: v.pipe(v.string(), v.uuid()),
    vote: VoteType,
    created_at: v.date()
});

export const CommentsVoteInsert = v.object({
    comment_id: v.pipe(v.string(), v.uuid()),
    user_id: v.optional(v.pipe(v.string(), v.uuid())),
    vote: VoteType,
    created_at: v.optional(v.date())
});

export type CommentsVoteInsert = v.InferOutput<typeof CommentsVoteInsert>;

export const CommentsVoteUpdate = v.object({
    comment_id: v.optional(v.pipe(v.string(), v.uuid())),
    user_id: v.optional(v.pipe(v.string(), v.uuid())),
    vote: v.optional(VoteType),
    created_at: v.optional(v.date())
});

export type CommentsVoteUpdate = v.InferOutput<typeof CommentsVoteUpdate>;

export const Post = v.object({
    id: v.number(),
    user_id: v.pipe(v.string(), v.uuid()),
    body: v.string(),
    tags: v.optional(v.nullable(v.array(v.string()))),
    mentions: v.optional(v.nullable(v.array(v.string()))),
    search: v.string(),
    created_at: v.date(),
    updated_at: v.date()
});

export const PostInsert = v.object({
    id: v.optional(v.number()),
    user_id: v.optional(v.pipe(v.string(), v.uuid())),
    body: v.string(),
    tags: v.optional(v.nullable(v.array(v.string()))),
    mentions: v.optional(v.nullable(v.array(v.string()))),
    search: v.optional(v.string()),
    created_at: v.optional(v.date()),
    updated_at: v.optional(v.date())
});

export type PostInsert = v.InferOutput<typeof PostInsert>;

export const PostUpdate = v.object({
    id: v.optional(v.number()),
    user_id: v.optional(v.pipe(v.string(), v.uuid())),
    body: v.optional(v.string()),
    tags: v.optional(v.nullable(v.array(v.string()))),
    mentions: v.optional(v.nullable(v.array(v.string()))),
    search: v.optional(v.string()),
    created_at: v.optional(v.date()),
    updated_at: v.optional(v.date())
});

export type PostUpdate = v.InferOutput<typeof PostUpdate>;

export const PostsVote = v.object({
    post_id: v.number(),
    user_id: v.pipe(v.string(), v.uuid()),
    vote: VoteType,
    created_at: v.date()
});

export const PostsVoteInsert = v.object({
    post_id: v.number(),
    user_id: v.optional(v.pipe(v.string(), v.uuid())),
    vote: VoteType,
    created_at: v.optional(v.date())
});

export type PostsVoteInsert = v.InferOutput<typeof PostsVoteInsert>;

export const PostsVoteUpdate = v.object({
    post_id: v.optional(v.number()),
    user_id: v.optional(v.pipe(v.string(), v.uuid())),
    vote: v.optional(VoteType),
    created_at: v.optional(v.date())
});

export type PostsVoteUpdate = v.InferOutput<typeof PostsVoteUpdate>;

export const RecentPost = v.object({
    id: v.optional(v.nullable(v.number())),
    user_id: v.optional(v.nullable(v.pipe(v.string(), v.uuid()))),
    body: v.optional(v.nullable(v.string())),
    tags: v.optional(v.nullable(v.array(v.string()))),
    mentions: v.optional(v.nullable(v.array(v.string()))),
    search: v.optional(v.nullable(v.string())),
    created_at: v.optional(v.nullable(v.date())),
    updated_at: v.optional(v.nullable(v.date()))
});

export const TopTag = v.object({
    tag: v.optional(v.nullable(v.string())),
    count: v.optional(v.nullable(v.number()))
});

export const UserEmail = v.object({
    id: v.pipe(v.string(), v.uuid()),
    user_id: v.pipe(v.string(), v.uuid()),
    email: v.string(),
    is_verified: v.boolean(),
    is_primary: v.boolean(),
    created_at: v.date(),
    updated_at: v.date()
});

export const UserEmailInsert = v.object({
    id: v.optional(v.pipe(v.string(), v.uuid())),
    user_id: v.optional(v.pipe(v.string(), v.uuid())),
    email: v.string(),
    is_verified: v.optional(v.boolean()),
    is_primary: v.optional(v.boolean()),
    created_at: v.optional(v.date()),
    updated_at: v.optional(v.date())
});

export type UserEmailInsert = v.InferOutput<typeof UserEmailInsert>;

export const UserEmailUpdate = v.object({
    id: v.optional(v.pipe(v.string(), v.uuid())),
    user_id: v.optional(v.pipe(v.string(), v.uuid())),
    email: v.optional(v.string()),
    is_verified: v.optional(v.boolean()),
    is_primary: v.optional(v.boolean()),
    created_at: v.optional(v.date()),
    updated_at: v.optional(v.date())
});

export type UserEmailUpdate = v.InferOutput<typeof UserEmailUpdate>;

export const User = v.object({
    id: v.pipe(v.string(), v.uuid()),
    username: v.string(),
    name: v.optional(v.nullable(v.string())),
    avatar_url: v.optional(v.nullable(v.string())),
    role: UserRole,
    bio: v.string(),
    is_verified: v.boolean(),
    created_at: v.date(),
    updated_at: v.date()
});

export const UserInsert = v.object({
    id: v.optional(v.pipe(v.string(), v.uuid())),
    username: v.string(),
    name: v.optional(v.nullable(v.string())),
    avatar_url: v.optional(v.nullable(v.string())),
    role: v.optional(UserRole),
    bio: v.optional(v.string()),
    is_verified: v.optional(v.boolean()),
    created_at: v.optional(v.date()),
    updated_at: v.optional(v.date())
});

export type UserInsert = v.InferOutput<typeof UserInsert>;

export const UserUpdate = v.object({
    id: v.optional(v.pipe(v.string(), v.uuid())),
    username: v.optional(v.string()),
    name: v.optional(v.nullable(v.string())),
    avatar_url: v.optional(v.nullable(v.string())),
    role: v.optional(UserRole),
    bio: v.optional(v.string()),
    is_verified: v.optional(v.boolean()),
    created_at: v.optional(v.date()),
    updated_at: v.optional(v.date())
});

export type UserUpdate = v.InferOutput<typeof UserUpdate>;

export const SearchMatchType = v.picklist(["fuzzy", "exact"]);

export type SearchMatchType = v.InferOutput<typeof SearchMatchType>;

export const UserRole = v.picklist(["admin", "moderator", "user"]);

export type UserRole = v.InferOutput<typeof UserRole>;

export const VoteType = v.picklist(["down", "up"]);

export type VoteType = v.InferOutput<typeof VoteType>;
```

### `kysely` -- Kysely Types + Query Builders

The unified `kysely` plugin generates both type definitions and query functions:

```typescript
// DB interface (db.ts)
import type { Generated, ColumnType } from "kysely";

export type UserRole = "admin" | "moderator" | "user";

export interface UsersTable {
  id: Generated<string>;
  username: string;
  name: string | null;
  avatar_url: string | null;
  role: UserRole;
  bio: string;
  is_verified: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DB {
  "app_public.users": UsersTable;
}

//
import { db } from "../../db.js";
import type { UsersTable } from "./db.js";
import type { Insertable, Updateable } from "kysely";

export const findById = ({ id }: { id: string }) =>
  db
    .selectFrom("app_public.users")
    .select([
      "id",
      "username",
      "name",
      "avatar_url",
      "role",
      "bio",
      "is_verified",
      "created_at",
      "updated_at",
    ])
    .where("id", "=", id)
    .executeTakeFirst();

export const create = ({ data }: { data: Insertable<UsersTable> }) =>
  db.insertInto("app_public.users").values(data).returningAll().executeTakeFirstOrThrow();

export const update = ({ id, data }: { id: string; data: Updateable<UsersTable> }) =>
  db
    .updateTable("app_public.users")
    .set(data)
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirstOrThrow();

export const findByUsername = ({ username }: { username: string }) =>
  db
    .selectFrom("app_public.users")
    .select([
      "id",
      "username",
      "name",
      "avatar_url",
      "role",
      "bio",
      "is_verified",
      "created_at",
      "updated_at",
    ])
    .where("username", "=", username)
    .executeTakeFirst();
```

### `sqlQueries` -- Raw SQL Query Functions

with `sqlQueries({ sqlStyle: "tag" })`

```typescript
import { sql } from "../../db.js";
import type { User } from "../types/User.js";

export const update = ({
  id,
  ...fields
}: Pick<User, "id"> & Partial<Pick<User, "username" | "name" | "bio" | "avatarUrl">>) =>
  sql`update users set ${sql(user, ["username" | "name" | "bio" | "avatarUrl"])} where id = ${id}`;

export const latest = ({ limit = 50, offset = 0 }: { limit?: number; offset?: number }) =>
  sql<User[]>`
    select id, username, name, avatar_url, role, bio, is_verified, created_at, updated_at
    from app_public.users order by created_at desc limit ${limit} offset ${offset}`;

export async function findByUsername({ username }: { username: NonNullable<User["username"]> }) {
  const [result] = await sql<User[]>`
    select id, username, name, avatar_url, role, bio, is_verified, created_at, updated_at
    from app_public.users where username = ${username}`;
  return result;
}
```

```typescript
import type { Comment, CommentsVote, Post, PostsVote, UserEmail, User } from "./queries.js";

export const commentFindById = (
    {
        id
    }: {
        id: string;
    }
) => {
    return sql`select id, post_id, user_id, parent_id, body, search, created_at, updated_at from comments where id = `;
};

export const commentCreate = (
    {
        data
    }: {
        data: Insertable<Comment>;
    }
) => {
    return sql`insert into comments (id, post_id, user_id, parent_id, body, search, created_at, updated_at) values (${data.id}${data.post_id}, ${data.user_id}, ${data.parent_id}, ${data.body}, ${data.search}, ${data.created_at}, ${data.updated_at}, ) returning *`;
};

export const commentUpdate = (
    {
        id,
        data
    }: {
        id: string;
        data: Updateable<Comment>;
    }
) => {
    return sql`update comments set ${data.id}id = ${data.post_id}, post_id = ${data.user_id}, user_id = ${data.parent_id}, parent_id = ${data.body}, body = ${data.search}, search = ${data.created_at}, created_at = ${data.updated_at}, updated_at = ${id} where id =  returning *`;
};

export const commentDelete = (
    {
        id
    }: {
        id: string;
    }
) => {
    return sql`delete from comments where id = `;
};

export const commentFindByParentId = (
    {
        parent_id
    }: {
        parent_id: string;
    }
) => {
    return sql`select id, post_id, user_id, parent_id, body, search, created_at, updated_at from comments where parent_id = `;
};

export const commentsVoteFindById = (
    {
        comment_id
    }: {
        comment_id: string;
    }
) => {
    return sql`select comment_id, user_id, vote, created_at from comments_votes where comment_id = `;
};

export const commentsVoteCreate = (
    {
        data
    }: {
        data: Insertable<CommentsVote>;
    }
) => {
    return sql`insert into comments_votes (comment_id, user_id, vote, created_at) values (${data.comment_id}${data.user_id}, ${data.vote}, ${data.created_at}, ) returning *`;
};

export const commentsVoteUpdate = (
    {
        comment_id,
        data
    }: {
        comment_id: string;
        data: Updateable<CommentsVote>;
    }
) => {
    return sql`update comments_votes set ${data.comment_id}comment_id = ${data.user_id}, user_id = ${data.vote}, vote = ${data.created_at}, created_at = ${comment_id} where comment_id =  returning *`;
};

export const commentsVoteDelete = (
    {
        comment_id
    }: {
        comment_id: string;
    }
) => {
    return sql`delete from comments_votes where comment_id = `;
};

export const postFindById = (
    {
        id
    }: {
        id: number;
    }
) => {
    return sql`select id, user_id, body, tags, mentions, search, created_at, updated_at from posts where id = `;
};

export const postCreate = (
    {
        data
    }: {
        data: Insertable<Post>;
    }
) => {
    return sql`insert into posts (id, user_id, body, tags, mentions, search, created_at, updated_at) values (${data.id}${data.user_id}, ${data.body}, ${data.tags}, ${data.mentions}, ${data.search}, ${data.created_at}, ${data.updated_at}, ) returning *`;
};

export const postUpdate = (
    {
        id,
        data
    }: {
        id: number;
        data: Updateable<Post>;
    }
) => {
    return sql`update posts set ${data.id}id = ${data.user_id}, user_id = ${data.body}, body = ${data.tags}, tags = ${data.mentions}, mentions = ${data.search}, search = ${data.created_at}, created_at = ${data.updated_at}, updated_at = ${id} where id =  returning *`;
};

export const postDelete = (
    {
        id
    }: {
        id: number;
    }
) => {
    return sql`delete from posts where id = `;
};

export const postFindByUserId = (
    {
        user_id
    }: {
        user_id: string;
    }
) => {
    return sql`select id, user_id, body, tags, mentions, search, created_at, updated_at from posts where user_id = `;
};

export const postFindByCreatedAt = (
    {
        created_at
    }: {
        created_at: Date;
    }
) => {
    return sql`select id, user_id, body, tags, mentions, search, created_at, updated_at from posts where created_at = `;
};

export const postListByCreatedAt = (
    {
        cursorCreatedAt,
        cursorId,
        limit = 50
    }: {
        cursorCreatedAt?: Date;
        cursorId?: number;
        limit?: number;
    }
) => {
    return sql`select id, user_id, body, tags, mentions, search, created_at, updated_at from posts where ($${cursorCreatedAt}::timestamptz IS NULL OR (created_at, id) < ($${cursorId}, ${limit})) order by created_at DESC, id DESC limit `;
};

export const postsVoteFindById = (
    {
        post_id
    }: {
        post_id: number;
    }
) => {
    return sql`select post_id, user_id, vote, created_at from posts_votes where post_id = `;
};

export const postsVoteCreate = (
    {
        data
    }: {
        data: Insertable<PostsVote>;
    }
) => {
    return sql`insert into posts_votes (post_id, user_id, vote, created_at) values (${data.post_id}${data.user_id}, ${data.vote}, ${data.created_at}, ) returning *`;
};

export const postsVoteUpdate = (
    {
        post_id,
        data
    }: {
        post_id: number;
        data: Updateable<PostsVote>;
    }
) => {
    return sql`update posts_votes set ${data.post_id}post_id = ${data.user_id}, user_id = ${data.vote}, vote = ${data.created_at}, created_at = ${post_id} where post_id =  returning *`;
};

export const postsVoteDelete = (
    {
        post_id
    }: {
        post_id: number;
    }
) => {
    return sql`delete from posts_votes where post_id = `;
};

export const userEmailFindById = (
    {
        id
    }: {
        id: string;
    }
) => {
    return sql`select id, user_id, email, is_verified, is_primary, created_at, updated_at from user_emails where id = `;
};

export const userEmailCreate = (
    {
        data
    }: {
        data: Insertable<UserEmail>;
    }
) => {
    return sql`insert into user_emails (id, user_id, email, is_verified, is_primary, created_at, updated_at) values (${data.id}${data.user_id}, ${data.email}, ${data.is_verified}, ${data.is_primary}, ${data.created_at}, ${data.updated_at}, ) returning *`;
};

export const userEmailUpdate = (
    {
        id,
        data
    }: {
        id: string;
        data: Updateable<UserEmail>;
    }
) => {
    return sql`update user_emails set ${data.id}id = ${data.user_id}, user_id = ${data.email}, email = ${data.is_verified}, is_verified = ${data.is_primary}, is_primary = ${data.created_at}, created_at = ${data.updated_at}, updated_at = ${id} where id =  returning *`;
};

export const userEmailDelete = (
    {
        id
    }: {
        id: string;
    }
) => {
    return sql`delete from user_emails where id = `;
};

export const userEmailFindByUserId = (
    {
        user_id
    }: {
        user_id: string;
    }
) => {
    return sql`select id, user_id, email, is_verified, is_primary, created_at, updated_at from user_emails where user_id = `;
};

export const userFindById = (
    {
        id
    }: {
        id: string;
    }
) => {
    return sql`select id, username, name, avatar_url, role, bio, is_verified, created_at, updated_at from users where id = `;
};

export const userCreate = (
    {
        data
    }: {
        data: Insertable<User>;
    }
) => {
    return sql`insert into users (id, username, name, avatar_url, role, bio, is_verified, created_at, updated_at) values (${data.id}${data.username}, ${data.name}, ${data.avatar_url}, ${data.role}, ${data.bio}, ${data.is_verified}, ${data.created_at}, ${data.updated_at}, ) returning *`;
};

export const userUpdate = (
    {
        id,
        data
    }: {
        id: string;
        data: Updateable<User>;
    }
) => {
    return sql`update users set ${data.id}id = ${data.username}, username = ${data.name}, name = ${data.avatar_url}, avatar_url = ${data.role}, role = ${data.bio}, bio = ${data.is_verified}, is_verified = ${data.created_at}, created_at = ${data.updated_at}, updated_at = ${id} where id =  returning *`;
};

export const userDelete = (
    {
        id
    }: {
        id: string;
    }
) => {
    return sql`delete from users where id = `;
};

export const userFindByUsername = (
    {
        username
    }: {
        username: string;
    }
) => {
    return sql`select id, username, name, avatar_url, role, bio, is_verified, created_at, updated_at from users where username = `;
};
```

not using tagged templates? got you covered with `sqlQueries({ sqlStyle: "string" })`

### `effect` -- Effect SQL Models + Repositories

The `effect` plugin generates Model classes, optional Repositories, and optional HTTP APIs.

Set `repoModel: false` (or `repos: false` for legacy configs) to skip `Model.makeRepository`
and expose query functions from the active `queries` plugin (kysely/sql-queries).

```typescript
// users/model.ts
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

// users/service.ts
import { Model, SqlClient } from "@effect/sql";
import { User } from "./User.js";

export class UserRepo extends Effect.Service<UserRepo>()("UserRepo", {
  effect: Effect.gen(function* () {
    const db = yield* KyselyDB
    const queries = {
      findById: ({ id }: { id: string }) => db
        .selectFrom("app_public.users")
        .select(["id", "username", "name", "avatar_url", "role", "bio", "is_verified", "created_at", "updated_at"])
        .where("id", "=", id),

      create: ({ data }: { data: Insertable<UsersTable> }) =>
        db.insertInto("app_public.users").values(data).returningAll(),

      update: ({ id, data }: { id: string; data: Updateable<UsersTable> }) =>
        db.updateTable("app_public.users").set(data).where("id", "=", id).returningAll(),,

      findByUsername: ({ username }: { username: string }) => db
        .selectFrom("app_public.users")
        .select(["id", "username", "name", "avatar_url", "role", "bio", "is_verified", "created_at", "updated_at"])
        .where("username", "=", username),

      latest: ({ offset = 0, limit = 50 }: { offset: number; limit: number }) => db
        .selectFrom("app_public.users")
        .select(["id", "username", "name", "avatar_url", "role", "bio", "is_verified", "created_at", "updated_at"])
        .orderBy("created_at", "desc")
        .limit(limit).offset(offset),
    }
    return { ...queries };
  }),
}) {}
```

```typescript
import { Model } from "@effect/sql";
import { Schema as S, Effect, Layer, Option } from "effect";

import {
    HttpApi,
    HttpApiBuilder,
    HttpApiEndpoint,
    HttpApiGroup,
    HttpApiSchema,
    HttpServer,
} from "@effect/platform";

import { UserRole } from "./userRole.js";

export class User extends Model.Class<User>("users")({
    id: Model.Generated(S.UUID),
    username: S.String,
    name: S.NullOr(S.String),
    avatar_url: S.NullOr(S.String),
    role: UserRole,
    bio: S.String,
    is_verified: S.Boolean,
    created_at: Model.DateTimeInsertFromDate,
    updated_at: Model.DateTimeUpdateFromDate
}) {}

export class UserRepo extends Effect.Service<UserRepo>()("UserRepo", {
    effect: Effect.gen(function*() {
        const repo = yield* Model.makeRepository(User, {
            tableName: "app_public.users",
            spanPrefix: "UserRepo",
            idColumn: "id"
        });

        return {
            ...repo
        };
    })
}) {}

export class UserNotFound extends S.TaggedError<UserNotFound>()("UserNotFound", {
    id: S.UUID
}) {}

export const UserApiGroup = HttpApiGroup.make("users").prefix("/api/users").add(
    HttpApiEndpoint.get("findById")`/${HttpApiSchema.param("id", S.UUID)}`.addSuccess(User).addError(UserNotFound, {
        status: 404
    })
).add(
    HttpApiEndpoint.post("insert", "/").setPayload(User.insert).addSuccess(User, {
        status: 201
    })
).add(
    HttpApiEndpoint.put("update")`/${HttpApiSchema.param("id", S.UUID)}`.setPayload(User.update).addSuccess(User).addError(UserNotFound, {
        status: 404
    })
).add(
    HttpApiEndpoint.del("delete")`/${HttpApiSchema.param("id", S.UUID)}`.addError(UserNotFound, {
        status: 404
    })
);

export const UserApi = HttpApi.make("UserApi").add(UserApiGroup);

export const UserApiGroupLive = HttpApiBuilder.group(UserApi, "users", handlers => Effect.gen(function*() {
    const repo = yield* UserRepo;

    return handlers.handle("findById", (
        {
            path: {
                id
            }
        }
    ) => repo.findById(id).pipe(Effect.flatMap(Option.match({
        onNone: () => Effect.fail(new UserNotFound({
            id: id
        })),

        onSome: Effect.succeed
    })))).handle("insert", (
        {
            payload
        }
    ) => repo.insert(payload)).handle("update", (
        {
            path: {
                id
            },

            payload
        }
    ) => repo.update({
        ...payload,
        id
    })).handle("delete", (
        {
            path: {
                id
            }
        }
    ) => repo.delete(id));
}));

export const UserApiLive = HttpApiBuilder.api(UserApi).pipe(Layer.provide(UserApiGroupLive), Layer.provide(UserRepo.Default));
```

### `httpElysia` -- Elysia REST Routes

```typescript
import { Elysia, t } from "elysia";
import { findUserById, findUserManys, getUserByUsername } from "../queries/User.js";

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
      return await latest({ limit: query.limit, offset: query.offset });
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

### `httpExpress` -- Express REST Routes

```typescript
import { Router } from "express";
import { findUserById, listUsers, updateUser } from "../sql-queries/User.js";
import { User, UserUpdate } from "../schemas/User.js";

export const userRoutes = Router();

userRoutes.get("/:id", async (req, res) => {
  const { params } = z.object({
    params: z.object({ id: User.shape.id })
  }).parse({ params: req.params }})
  const result = await findUserById({ id: params.id });
  if (!result) return res.status(404).json({ error: "Not found" });
  return res.json(result);
});

userRoutes.get("/", async (req, res) => {
  const { query } = z.object({
    query: z.object({
      limit: z.coerce.number().optional(),
      offset: z.coerce.number().optional(),
    })
  }).parse({ query: req.query }})
  return res.json(await latest(query);
});

userRoutes.put("/:id", async (req, res) => {
  const { success,  } = z.object({
    params: z.object({ id: User.shape.id })
    body: UserUpdate,
  }).safeParse({ params: req.params, body: req.body }})
  if (!success) return res.status(400);
  const result = await updateUser({ id, ...data });
  return res.json(result);
});
```

### `httpHono` -- Hono REST Routes

```typescript
import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { z } from "zod";
import { findUserById, listUsers, updateUser } from "../sql-queries/User.js";
import { UserUpdate } from "../schemas/User.js";

export const userRoutes = new Hono()
  .get("/:id", async c => {
    const id = c.req.param("id");
    const result = await findUserById({ id });
    if (!result) return c.json({ error: "Not found" }, 404);
    return c.json(result);
  })
  .get(
    "/",
    sValidator(
      "query",
      z.object({
        limit: z.coerce.number().optional(),
        offset: z.coerce.number().optional(),
      }),
    ),
    async c => {
      const { limit, offset } = c.req.valid("query");
      return c.json(await latest({ limit, offset }));
    },
  )
  .put("/:id", sValidator("json", UserUpdate), async c => {
    const id = c.req.param("id");
    const data = c.req.valid("json");
    const result = await updateUser({ id, ...data });
    return c.json(result);
  });
```

### `httpTrpc` -- tRPC Routers

```typescript
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { findUserById, listUsers, getUserByUsername } from "../sql-queries/User.js";

export const userRouter = router({
  findUserById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    return await findUserById({ id: input.id });
  }),

  listUsers: publicProcedure
    .input(z.object({ limit: z.coerce.number().optional(), offset: z.coerce.number().optional() }))
    .query(async ({ input }) => {
      return await listUsers({ limit: input.limit, offset: input.offset });
    }),

  getUserByUsername: publicProcedure
    .input(z.object({ username: z.string() }))
    .query(async ({ input }) => {
      return await getUserByUsername({ username: input.username });
    }),
});
```

### `httpOrpc` -- oRPC Handlers

```typescript
import { findUserById, listUsers, getUserByUsername } from "../sql-queries/User.js";
import { os, type } from "@orpc/server";

export const findById = os
  .input(type<{ id: string }>())
  .handler(async ({ input }) => await findUserById(input));

export const list = os
  .input(type<{ limit?: number; offset?: number }>())
  .handler(async ({ input }) => await listUsers(input));

export const findByUsername = os
  .input(type<{ username: string }>())
  .handler(async ({ input }) => await getUserByUsername(input));

export const userRouter = { findById, list, findByUsername };
```

## Smart Tags

Configure generation via PostgreSQL comments:

###

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

###

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

###

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
        .ast(conjure.symbolProgram(statement))
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

###

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

###

```typescript
definePlugin({
  name: "zod-schemas",
  requires: ["types"], // Must run after types plugin
  provides: ["schemas:zod"],
  // ...
});
```

Access upstream artifacts:

###

```typescript
run: ctx => {
  const typesArtifact = ctx.getArtifact("types");
  // Use data from types plugin
};
```

## Development

###

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

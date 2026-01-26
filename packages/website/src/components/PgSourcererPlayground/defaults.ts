export const defaultSchemaSql = `create extension if not exists pgcrypto;
create extension if not exists citext;

create schema if not exists app_public;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_visitor') then
    create role app_visitor;
  end if;
end
$$;

create type app_public.user_role as enum('admin', 'moderator', 'user');
create domain app_public.username as citext check(length(value) >= 2 and length(value) <= 24 and value ~ '^[a-zA-Z][a-zA-Z0-9_-]+$');
create domain app_public.url as text check(value ~ '^https?://\S+');

create table app_public.users (
  id uuid primary key default gen_random_uuid(),
  username app_public.username not null unique,
  role app_public.user_role not null default 'user',
  is_verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table app_public.users enable row level security;
create unique index on app_public.users (username);
create index on app_public.users (created_at desc);

grant
  select,
  update(username)
  on app_public.users to :DATABASE_VISITOR;
`;

export const defaultConfigSource = `import {
  defineConfig,
  userModule,
  zod,
  kysely,
  elysia,
} from "@danielfgray/pg-sourcerer";

export default defineConfig({
  connectionString: "pglite://",
  schemas: ["app_public"],
  outputDir: "./generated",
  plugins: [
    zod(),
    kysely(),
    elysia()
  ],
});
`;

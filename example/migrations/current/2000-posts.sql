-- create type app_public.privacy as enum(
--   'private',
--   'public'
-- );

create function app_hidden.array_regexp_matches (
  input_string text,
  pattern text
) returns text[] as $$
  select
    coalesce(array_agg(match[1]), '{}')
  from
    regexp_matches(input_string, pattern, 'g') as m(match)
$$ language sql immutable;

-- ─────────────────────────────────────────────────────────────────────────────

create table app_public.posts (
  id int primary key generated always as identity (start 1000),
  -- id text primary key not null generated always as (id_encode(int_id)) stored,
  -- int_id int generated always as identity (start 1000),
  user_id uuid not null default app_public.current_user_id() references app_public.users on delete cascade,
  -- privacy app_public.privacy not null default 'public',
  body text not null check(length(body) > 0),
  tags citext[] generated always as (app_hidden.array_regexp_matches(body, '\m(?<=#)[^[:digit:][:punct:]\s]+\M')) stored,
  mentions citext[] generated always as (app_hidden.array_regexp_matches(body, '\m(?<=@)[a-zA-Z][a-zA-Z0-9_-]+\M')) stored,
  search tsvector not null generated always as (
    to_tsvector('english', body)
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- comment on column app_public.posts.int_id is '@omit';
comment on column app_public.posts.tags is '@omit';

create index on app_public.posts (user_id);
create index on app_public.posts using gin (tags);
create index on app_public.posts using gist (search);
create index on app_public.posts (created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────

alter table app_public.posts enable row level security;

create policy select_own_and_public on app_public.posts
  for select using (true);

-- create policy select_own_and_public on app_public.posts
--   for select using (
--     user_id = app_public.current_user_id()
--       or privacy = 'public'
--   );

create policy insert_own on app_public.posts
  for insert with check (user_id = app_public.current_user_id());

create policy update_own on app_public.posts
  for update using (user_id = app_public.current_user_id());

create policy delete_own on app_public.posts
  for delete using (user_id = app_public.current_user_id());

create policy delete_as_mod on app_public.posts
  for delete using (exists (
    select 1 from app_public.users
    where id = app_public.current_user_id() and role = 'moderator'
  ));

create policy all_as_admin on app_public.posts
  for all using (exists (
    select 1 from app_public.users
    where id = app_public.current_user_id() and role = 'admin'
  ));

grant
  select,
  insert (body),
  update (body),
  delete
  on app_public.posts to :DATABASE_VISITOR;

-- ─────────────────────────────────────────────────────────────────────────────

create trigger _100_timestamps
  before insert or update
  on app_public.posts
  for each row
execute procedure app_private.tg__timestamps();

create trigger _500_gql_update
  after insert on app_public.posts
  for each row
  execute procedure app_public.tg__graphql_subscription(
    'postCreated',
    'graphql:post:$1',
    'id' -- If specified, `$1` above will be replaced with new.id or old.id from the trigger.
  );

-- ─────────────────────────────────────────────────────────────────────────────

create function app_public.posts_short_body(
  post app_public.posts
) returns text as $$
  select left(post.body, 320) || case length(post.body) > 320 when true then '…' else '' end
$$ language sql strict stable;

-- ─────────────────────────────────────────────────────────────────────────────

create function app_public.posts_with_tags(
  tags text[]
) returns setof app_public.posts as $$
  select * from app_public.posts p where p.tags @> posts_with_tags.tags::citext[]
$$ language sql stable set search_path to pg_catalog, public, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────────

create type tag_search_result as (tag text, count bigint);
create function app_public.search_tags(
  substr text
) returns setof tag_search_result as $$
  select tag::text, count(*) as count
  from (
      select unnest(tags) as tag
      from app_public.posts
  ) as _
  where tag % substr
  group by tag
  order by count desc
  limit 6;
$$ language sql stable strict set search_path to pg_catalog, public, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────────

create view app_public.recent_posts as
  select *
  from app_public.posts
  order by created_at desc
  limit 100;

create view app_public.top_tags as
  select
    unnest(tags) as tag,
    count(*)
  from
    app_public.posts
  group by
    tag
  order by
    count desc;


create type app_public.vote_type as enum ('down', 'up');

create table app_public.posts_votes (
  post_id int not null references app_public.posts on delete cascade,
  -- post_id text not null references app_public.posts on delete cascade,
  user_id uuid not null default app_public.current_user_id() references app_public.users on delete cascade,
  vote app_public.vote_type not null,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

comment on table app_public.posts_votes is E'@omit all';

create index on app_public.posts_votes (user_id);
create index on app_public.posts_votes (post_id);

alter table app_public.posts_votes enable row level security;

create policy select_all on app_public.posts_votes
  for select using (true);

create policy insert_own on app_public.posts_votes
  for insert with check (user_id = app_public.current_user_id());

create policy update_own on app_public.posts_votes
   for update using (user_id = app_public.current_user_id());

create policy delete_own on app_public.posts_votes
  for delete using (user_id = app_public.current_user_id());

grant
  select,
  insert (vote),
  update (vote),
  delete
  on app_public.posts_votes to :DATABASE_VISITOR;

/*
 * Users should automatically vote on their post
 */
create function app_private.tg_post_first_vote() returns trigger as $$
begin
  insert into app_public.posts_votes(post_id, user_id, vote) values(new.id, new.user_id, 'up');
  return new;
end;
$$ language plpgsql volatile security definer set search_path to pg_catalog, public, pg_temp;
create trigger _200_post_first_vote
  after insert on app_public.posts
  for each row
  execute procedure app_private.tg_post_first_vote();
comment on function app_private.tg_post_first_vote() is
  E'';

-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app_public.posts_current_user_voted(
  p app_public.posts
) returns app_public.vote_type as $$
  select
    vote
  from
    app_public.posts_votes v
  where
    v.post_id = p.id
    and v.user_id = app_public.current_user_id()
$$ language sql stable security definer set search_path to pg_catalog, public, pg_temp;

create or replace function app_public.posts_score(
  p app_public.posts
) returns int as $$
  select
    coalesce(sum(
       case vote
         when 'up' then 1
         when 'down' then -1
       end
     ), 0) as score
  from
    app_public.posts_votes v
  where
    v.post_id = p.id
$$ language sql stable set search_path to pg_catalog, public, pg_temp;

create or replace function app_public.posts_popularity(
  post app_public.posts
) returns float as $$
  -- https://medium.com/hacking-and-gonzo/how-hacker-news-ranking-algorithm-works-1d9b0cf2c08d
  select (app_public.posts_score(post) - 1) / pow((extract(epoch from (now() - post.created_at)) / 3600) + 2, 1.8)
$$ language sql stable;

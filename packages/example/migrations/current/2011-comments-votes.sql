create table app_public.comments_votes (
  comment_id uuid not null references app_public.comments on delete cascade,
  user_id uuid not null references app_public.users on delete set null default app_public.current_user_id(),
  vote app_public.vote_type not null,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

comment on table app_public.comments_votes is E'@omit all';

create index on app_public.comments_votes (user_id);
create index on app_public.comments_votes (comment_id);

alter table app_public.comments_votes enable row level security;

create policy select_all on app_public.comments_votes
  for select using (true);
create policy insert_own on app_public.comments_votes
  for insert with check (user_id = app_public.current_user_id());
create policy update_own on app_public.comments_votes
  for update using (user_id = app_public.current_user_id());
create policy delete_own on app_public.comments_votes
  for delete using (user_id = app_public.current_user_id());

grant
  select,
  insert (vote),
  update (vote),
  delete
  on app_public.comments_votes to :DATABASE_VISITOR;

/*
 * Users should automatically vote on their comment
 */
create function app_private.tg_comment_first_vote() returns trigger as $$
begin
  insert into app_public.comments_votes(comment_id, user_id, vote) values(new.id, new.user_id, 'up');
  return new;
end;
$$ language plpgsql volatile security definer set search_path to pg_catalog, public, pg_temp;

create trigger _200_comment_first_vote
  after insert on app_public.comments
  for each row
  execute procedure app_private.tg_comment_first_vote();
comment on function app_private.tg_comment_first_vote() is
  E'';

------------------------------------------------------------------------------------------------------------------------

create or replace function app_public.comments_current_user_voted(
  c app_public.comments
) returns app_public.vote_type as $$
  select
    vote
  from
    app_public.comments_votes v
  where
    v.comment_id = c.id
    and v.user_id = app_public.current_user_id()
$$ language sql stable security definer set search_path to pg_catalog, public, pg_temp;

create or replace function app_public.comments_score(
  c app_public.comments
) returns int as $$
  select
    coalesce(sum(
       case vote
         when 'up' then 1
         when 'down' then -1
       end
     ), 0) as score
  from
    app_public.comments_votes v
  where
    v.comment_id = c.id
$$ language sql stable set search_path to pg_catalog, public, pg_temp;

create or replace function app_public.comments_popularity(
  comment app_public.comments
) returns float as $$
  -- https://medium.com/hacking-and-gonzo/how-hacker-news-ranking-algorithm-works-1d9b0cf2c08d
  select (app_public.comments_score(comment) - 1) / pow((extract(epoch from (now() - comment.created_at)) / 3600) + 2, 1.8)
$$ language sql stable set search_path to pg_catalog, public, pg_temp;

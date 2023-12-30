create table app_public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id int not null references app_public.posts on delete cascade,
  -- post_id text not null references app_public.posts on delete cascade,
  user_id uuid references app_public.users on delete set null default app_public.current_user_id(),
  parent_id uuid references app_public.comments on delete cascade,
  body text not null,
  search tsvector not null generated always as (to_tsvector('english', body)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index on app_public.comments (post_id, user_id);
create index on app_public.comments (parent_id);

alter table app_public.comments enable row level security;

create policy delete_as_mod on app_public.comments
  for delete using (exists (
    select 1 from app_public.users
    where id = app_public.current_user_id() and role = 'moderator'
  ));

create policy all_as_admin on app_public.comments
  for all using (exists (
    select 1 from app_public.users
    where id = app_public.current_user_id() and role = 'admin'
  ));

create policy select_all on app_public.comments
  for select using (true);

create policy insert_own on app_public.comments
  for insert with check (user_id = app_public.current_user_id());

create policy update_own on app_public.comments
  for update using (user_id = app_public.current_user_id());

create policy delete_own on app_public.comments
  for delete using (user_id = app_public.current_user_id());

grant
  select,
  insert (body, parent_id),
  update (body),
  delete
  on app_public.comments to :DATABASE_VISITOR;

create trigger _100_timestamps
  before insert or update
  on app_public.comments
  for each row
execute procedure app_private.tg__timestamps();

create trigger _500_gql_update
  after update on app_public.comments
  for each row
  execute procedure app_public.tg__graphql_subscription(
    'commentChanged',
    'graphql:comment:$1',
    'id'
  );

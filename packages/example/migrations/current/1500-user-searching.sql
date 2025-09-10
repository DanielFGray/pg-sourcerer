create type app_public.search_match_type as enum('fuzzy', 'exact');
create type app_public.username_search as (username text, avatar_url text);
create function app_public.username_search(
  substr text,
  match_type app_public.search_match_type
) returns setof app_public.username_search as $$
  select username::text, avatar_url
  from app_public.users
  where
  case match_type
    when 'fuzzy' then levenshtein(substr, username) > 4
    else substr = username
  end
  limit 5
$$ language sql stable strict set search_path to pg_catalog, public, pg_temp;

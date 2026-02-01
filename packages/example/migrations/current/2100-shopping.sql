/*
 * Test table with various CHECK constraints to verify constraint introspection
 * and validation generation.
 */

create table app_public.products (
  id uuid primary key default uuidv7(),
  name text not null check(length(name) > 0 and length(name) <= 100),
  sku text not null check(sku ~ '^[A-Z]{3}-[0-9]{4}$'),
  price numeric(10,2) not null check(price >= 0),
  stock integer not null default 0 check(stock >= 0),
  discount_percent integer check(discount_percent >= 0 and discount_percent <= 100),
  status text not null check(status in ('draft', 'active', 'archived')),
  rating numeric(3,2) check(rating >= 0.0 and rating <= 5.0),
  -- Case-insensitive regex constraint (~*)
  username text check(username ~* '^[a-z][a-z0-9_]{2,19}$'),
  -- Exclusive range constraints (> and <)
  age integer check(age > 0 and age < 150),
  temperature numeric(5,2) check(temperature >= -273.15 and temperature < 1000),
  -- LIKE pattern constraint
  email text check(email like '%@%.%'),
  -- ILIKE pattern constraint (case-insensitive)
  domain text check(domain ilike '%.com' or domain ilike '%.org'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table app_public.products is
  E'Test table demonstrating various CHECK constraint patterns';
comment on column app_public.products.name is
  E'Product name (1-100 characters)';
comment on column app_public.products.sku is
  E'SKU in format ABC-1234 (3 uppercase letters, dash, 4 digits)';
comment on column app_public.products.price is
  E'Price must be non-negative';
comment on column app_public.products.stock is
  E'Stock quantity (non-negative)';
comment on column app_public.products.discount_percent is
  E'Discount percentage (0-100)';
comment on column app_public.products.status is
  E'Product status (draft, active, or archived)';
comment on column app_public.products.rating is
  E'Product rating (0.0 to 5.0)';
comment on column app_public.products.username is
  E'Username: 3-20 chars, starts with letter, case-insensitive validation';
comment on column app_public.products.age is
  E'Age in years (exclusive range: > 0 and < 150)';
comment on column app_public.products.temperature is
  E'Temperature in Celsius (inclusive min -273.15, exclusive max < 1000)';
comment on column app_public.products.email is
  E'Email address (LIKE pattern validation)';
comment on column app_public.products.domain is
  E'Domain name ending in .com or .org (case-insensitive)';

grant select on app_public.products to :DATABASE_VISITOR;

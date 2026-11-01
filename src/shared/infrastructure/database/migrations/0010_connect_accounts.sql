create table "ufit"."connect_accounts" (
  "id" uuid primary key default gen_random_uuid(),
  "brand_id" uuid references "ufit"."brand_profiles" ("id"),
  "creator_id" uuid references "ufit"."creator_profiles" ("id"),
  "country" text not null check ("country" ~ '^[A-Z]{2}$'),
  "live_mode" boolean not null,
  "stripe_account_id" text unique,
  "snapshot" jsonb,
  "synced_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "connect_accounts_one_owner_check" check (num_nonnulls("brand_id", "creator_id") = 1)
);
create unique index "connect_accounts_brand_mode_unique" on "ufit"."connect_accounts" ("brand_id", "live_mode");
create unique index "connect_accounts_creator_mode_unique" on "ufit"."connect_accounts" ("creator_id", "live_mode");

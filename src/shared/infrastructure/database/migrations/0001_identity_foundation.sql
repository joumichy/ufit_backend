do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'user_status'
      and n.nspname = 'ufit'
  ) then
    create type "ufit"."user_status" as enum ('active', 'onboarding', 'suspended', 'deleted');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'user_role'
      and n.nspname = 'ufit'
  ) then
    create type "ufit"."user_role" as enum (
      'customer',
      'creator',
      'brand_owner',
      'brand_manager',
      'admin',
      'super_admin'
    );
  end if;
end $$;

create table if not exists "ufit"."users" (
  "id" uuid primary key default gen_random_uuid(),
  "supabase_user_id" uuid not null,
  "email" text not null,
  "display_name" text,
  "avatar_url" text,
  "status" "ufit"."user_status" not null default 'active',
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create unique index if not exists "users_supabase_user_id_unique"
  on "ufit"."users" ("supabase_user_id");

create index if not exists "users_email_idx"
  on "ufit"."users" ("email");

create index if not exists "users_status_idx"
  on "ufit"."users" ("status");

create table if not exists "ufit"."user_roles" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" uuid not null references "ufit"."users" ("id") on delete cascade,
  "role" "ufit"."user_role" not null,
  "granted_at" timestamptz not null default now()
);

create unique index if not exists "user_roles_user_id_role_unique"
  on "ufit"."user_roles" ("user_id", "role");

create index if not exists "user_roles_user_id_idx"
  on "ufit"."user_roles" ("user_id");

create index if not exists "user_roles_role_idx"
  on "ufit"."user_roles" ("role");

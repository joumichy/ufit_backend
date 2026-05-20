create extension if not exists pgcrypto;

do $$ begin
  create type "ufit"."application_status" as enum (
    'submitted',
    'under_review',
    'accepted',
    'rejected',
    'waitlisted',
    'needs_more_info'
  );
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type "ufit"."application_decision" as enum (
    'accept',
    'reject',
    'waitlist',
    'needs_more_info'
  );
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type "ufit"."profile_status" as enum ('draft', 'active', 'paused', 'suspended');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type "ufit"."social_platform" as enum (
    'instagram',
    'tiktok',
    'youtube',
    'pinterest',
    'website',
    'other'
  );
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type "ufit"."brand_member_role" as enum ('owner', 'manager');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type "ufit"."brand_member_status" as enum ('active', 'invited', 'removed');
exception
  when duplicate_object then null;
end $$;

create table if not exists "ufit"."creator_applications" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" uuid not null references "ufit"."users" ("id"),
  "display_name" text not null,
  "email" text not null,
  "portfolio_url" text not null,
  "motivation" text not null,
  "audience_summary" text,
  "status" "ufit"."application_status" not null default 'submitted',
  "submitted_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create table if not exists "ufit"."brand_applications" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" uuid not null references "ufit"."users" ("id"),
  "brand_name" text not null,
  "email" text not null,
  "website_url" text not null,
  "product_category" text not null,
  "positioning" text not null,
  "status" "ufit"."application_status" not null default 'submitted',
  "submitted_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create table if not exists "ufit"."application_reviews" (
  "id" uuid primary key default gen_random_uuid(),
  "application_type" text not null check ("application_type" in ('creator', 'brand')),
  "application_id" uuid not null,
  "reviewer_user_id" uuid not null references "ufit"."users" ("id"),
  "decision" "ufit"."application_decision" not null,
  "notes" text,
  "created_at" timestamptz not null default now()
);

create table if not exists "ufit"."creator_grades" (
  "code" text primary key,
  "label" text not null,
  "rank" integer not null,
  "commission_bps" integer not null check ("commission_bps" >= 0),
  "criteria" jsonb not null default '{}'::jsonb,
  "created_at" timestamptz not null default now()
);

insert into "ufit"."creator_grades" ("code", "label", "rank", "commission_bps", "criteria")
values ('seed', 'Seed', 1, 500, '{}'::jsonb)
on conflict ("code") do nothing;

create table if not exists "ufit"."creator_profiles" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" uuid not null references "ufit"."users" ("id"),
  "application_id" uuid not null references "ufit"."creator_applications" ("id"),
  "display_name" text not null,
  "slug" text not null,
  "bio" text,
  "avatar_url" text,
  "status" "ufit"."profile_status" not null default 'active',
  "grade_code" text not null default 'seed' references "ufit"."creator_grades" ("code"),
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create table if not exists "ufit"."creator_social_accounts" (
  "id" uuid primary key default gen_random_uuid(),
  "creator_profile_id" uuid not null references "ufit"."creator_profiles" ("id"),
  "platform" "ufit"."social_platform" not null,
  "handle" text not null,
  "url" text,
  "created_at" timestamptz not null default now()
);

create table if not exists "ufit"."creator_grade_history" (
  "id" uuid primary key default gen_random_uuid(),
  "creator_profile_id" uuid not null references "ufit"."creator_profiles" ("id"),
  "from_grade_code" text,
  "to_grade_code" text not null references "ufit"."creator_grades" ("code"),
  "changed_by_user_id" uuid references "ufit"."users" ("id"),
  "reason" text,
  "created_at" timestamptz not null default now()
);

create table if not exists "ufit"."creator_score_snapshots" (
  "id" uuid primary key default gen_random_uuid(),
  "creator_profile_id" uuid not null references "ufit"."creator_profiles" ("id"),
  "score" integer not null,
  "metrics" jsonb not null default '{}'::jsonb,
  "captured_at" timestamptz not null default now()
);

create table if not exists "ufit"."brand_profiles" (
  "id" uuid primary key default gen_random_uuid(),
  "owner_user_id" uuid not null references "ufit"."users" ("id"),
  "application_id" uuid not null references "ufit"."brand_applications" ("id"),
  "brand_name" text not null,
  "slug" text not null,
  "website_url" text,
  "bio" text,
  "status" "ufit"."profile_status" not null default 'active',
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create table if not exists "ufit"."brand_members" (
  "id" uuid primary key default gen_random_uuid(),
  "brand_profile_id" uuid not null references "ufit"."brand_profiles" ("id"),
  "user_id" uuid not null references "ufit"."users" ("id"),
  "role" "ufit"."brand_member_role" not null,
  "status" "ufit"."brand_member_status" not null default 'active',
  "created_at" timestamptz not null default now()
);

create table if not exists "ufit"."brand_settings" (
  "brand_profile_id" uuid primary key references "ufit"."brand_profiles" ("id"),
  "fulfillment_email" text,
  "return_policy_url" text,
  "auto_approve_products" boolean not null default false,
  "metadata" jsonb not null default '{}'::jsonb,
  "updated_at" timestamptz not null default now()
);

create index if not exists "idx_creator_applications_user_status"
  on "ufit"."creator_applications" ("user_id", "status");

create unique index if not exists "uidx_creator_applications_active_user"
  on "ufit"."creator_applications" ("user_id")
  where "status" in ('submitted', 'under_review', 'waitlisted', 'needs_more_info');

create index if not exists "idx_brand_applications_user_status"
  on "ufit"."brand_applications" ("user_id", "status");

create unique index if not exists "uidx_brand_applications_active_user"
  on "ufit"."brand_applications" ("user_id")
  where "status" in ('submitted', 'under_review', 'waitlisted', 'needs_more_info');

create index if not exists "idx_application_reviews_application"
  on "ufit"."application_reviews" ("application_type", "application_id");

create unique index if not exists "uidx_creator_profiles_user"
  on "ufit"."creator_profiles" ("user_id");

create unique index if not exists "uidx_creator_profiles_application"
  on "ufit"."creator_profiles" ("application_id");

create unique index if not exists "uidx_creator_profiles_slug"
  on "ufit"."creator_profiles" ("slug");

create unique index if not exists "uidx_creator_social_accounts_creator_platform"
  on "ufit"."creator_social_accounts" ("creator_profile_id", "platform");

create index if not exists "idx_creator_grade_history_creator"
  on "ufit"."creator_grade_history" ("creator_profile_id");

create index if not exists "idx_creator_score_snapshots_creator_captured"
  on "ufit"."creator_score_snapshots" ("creator_profile_id", "captured_at");

create index if not exists "idx_brand_profiles_owner"
  on "ufit"."brand_profiles" ("owner_user_id");

create unique index if not exists "uidx_brand_profiles_application"
  on "ufit"."brand_profiles" ("application_id");

create unique index if not exists "uidx_brand_profiles_slug"
  on "ufit"."brand_profiles" ("slug");

create unique index if not exists "uidx_brand_members_brand_user"
  on "ufit"."brand_members" ("brand_profile_id", "user_id");

create index if not exists "idx_brand_members_user"
  on "ufit"."brand_members" ("user_id", "status");

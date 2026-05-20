alter table "ufit"."orders"
  add column if not exists "stripe_checkout_session_id" text;

create table if not exists "ufit"."stripe_webhook_events" (
  "id" uuid primary key default gen_random_uuid(),
  "stripe_event_id" text not null,
  "type" text not null,
  "payload" jsonb not null,
  "processed_at" timestamptz not null default now(),
  "created_at" timestamptz not null default now()
);

create unique index if not exists "stripe_webhook_events_stripe_event_id_unique"
  on "ufit"."stripe_webhook_events" ("stripe_event_id");

create index if not exists "stripe_webhook_events_type_idx"
  on "ufit"."stripe_webhook_events" ("type");

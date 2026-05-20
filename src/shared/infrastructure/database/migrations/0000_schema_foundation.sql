create schema if not exists "ufit";

create table if not exists "ufit"."schema_migrations" (
  "id" text primary key,
  "checksum" text not null,
  "executed_at" timestamptz not null default now()
);

alter table "ufit"."creator_applications"
  alter column "portfolio_url" drop not null,
  add column "dossier" jsonb check ("dossier" is null or jsonb_typeof("dossier") = 'object'),
  add column "version" integer not null default 1 check ("version" >= 1);
alter table "ufit"."brand_applications"
  add column "dossier" jsonb check ("dossier" is null or jsonb_typeof("dossier") = 'object'),
  add column "version" integer not null default 1 check ("version" >= 1);
create index "creator_applications_queue_idx" on "ufit"."creator_applications" ("status", "submitted_at" desc, "id" desc);
create index "brand_applications_queue_idx" on "ufit"."brand_applications" ("status", "submitted_at" desc, "id" desc);

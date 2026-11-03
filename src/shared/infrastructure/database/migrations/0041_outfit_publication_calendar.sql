alter table "ufit"."outfits"
  add column "scheduled_for" timestamptz,
  add column "publication_time_zone" text;
alter table "ufit"."outfits"
  add constraint "outfits_publication_date_pair" check (("scheduled_for" is null) = ("publication_time_zone" is null)),
  add constraint "outfits_scheduled_private" check ("status" <> 'scheduled' or
    ("scheduled_for" is not null and "visibility" = 'private' and "reviewed_at" is not null and "reviewed_by" is not null and "published_at" is null));
create index "outfits_publication_due_idx" on "ufit"."outfits" ("id") where "status" = 'scheduled';
create index "outfits_creator_calendar_idx" on "ufit"."outfits" ("creator_id", "scheduled_for", "id");
create index "outfits_brand_calendar_idx" on "ufit"."outfits" ("brand_id", "scheduled_for", "id");

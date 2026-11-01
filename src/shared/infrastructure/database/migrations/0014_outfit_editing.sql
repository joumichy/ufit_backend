alter table "ufit"."outfits"
  add column "version" integer not null default 1,
  add column "creation_request_id" uuid,
  add column "creation_fingerprint" text,
  add constraint "outfits_version_positive" check ("version" >= 1),
  add constraint "outfits_creation_request_pair" check (("creation_request_id" is null) = ("creation_fingerprint" is null)),
  add constraint "outfits_owner_exclusive" check ("creator_id" is null or "brand_id" is null);
create unique index "outfits_creator_creation_request_unique" on "ufit"."outfits" ("creator_id", "creation_request_id");
create unique index "outfits_brand_creation_request_unique" on "ufit"."outfits" ("brand_id", "creation_request_id");

insert into "ufit"."tags" ("type", "slug", "label") values
  ('style', 'minimal', 'Minimal'),
  ('style', 'streetwear', 'Streetwear'),
  ('style', 'chic', 'Chic'),
  ('style', 'vintage', 'Vintage'),
  ('style', 'tailoring', 'Tailoring'),
  ('occasion', 'work', 'Travail'),
  ('occasion', 'date', 'Rendez-vous'),
  ('occasion', 'weekend', 'Week-end'),
  ('occasion', 'evening', 'Soirée'),
  ('occasion', 'travel', 'Voyage'),
  ('occasion', 'daily', 'Quotidien'),
  ('season', 'spring', 'Printemps'),
  ('season', 'summer', 'Été'),
  ('season', 'autumn', 'Automne'),
  ('season', 'winter', 'Hiver')
on conflict ("type", "slug") do nothing;

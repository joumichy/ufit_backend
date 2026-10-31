alter table "ufit"."products"
  add column "version" integer not null default 1,
  add column "creation_request_id" uuid,
  add column "creation_fingerprint" text,
  add constraint "products_version_positive" check ("version" >= 1),
  add constraint "products_creation_request_pair" check (("creation_request_id" is null) = ("creation_fingerprint" is null));
create unique index "products_brand_creation_request_unique" on "ufit"."products" ("brand_id", "creation_request_id");

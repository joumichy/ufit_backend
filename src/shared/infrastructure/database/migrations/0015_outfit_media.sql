create table "ufit"."outfit_media_assets" (
  "id" uuid primary key,
  "creator_id" uuid references "ufit"."creator_profiles"("id"),
  "brand_id" uuid references "ufit"."brand_profiles"("id"),
  "uploaded_by" uuid not null references "ufit"."users"("id"),
  "request_id" uuid not null,
  "fingerprint" text not null,
  "byte_size" integer not null,
  "content_type" text not null,
  "object_path" text not null,
  "status" text not null default 'pending',
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "outfit_media_owner_required" check (("creator_id" is not null) <> ("brand_id" is not null)),
  constraint "outfit_media_size_valid" check ("byte_size" > 0 and "byte_size" <= 8388608),
  constraint "outfit_media_mime_valid" check ("content_type" = 'image/jpeg'),
  constraint "outfit_media_fingerprint_valid" check ("fingerprint" ~ '^[a-f0-9]{64}$'),
  constraint "outfit_media_status_valid" check ("status" in ('pending', 'ready'))
);
create unique index "outfit_media_creator_request_unique" on "ufit"."outfit_media_assets" ("creator_id", "request_id");
create unique index "outfit_media_brand_request_unique" on "ufit"."outfit_media_assets" ("brand_id", "request_id");
create unique index "outfit_media_object_path_unique" on "ufit"."outfit_media_assets" ("object_path");
create index "outfit_images_url_idx" on "ufit"."outfit_images" ("url");

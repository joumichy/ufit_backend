create table "ufit"."product_media_assets" (
  "id" uuid primary key,
  "brand_id" uuid not null references "ufit"."brand_profiles"("id"),
  "uploaded_by" uuid not null references "ufit"."users"("id"),
  "request_id" uuid not null,
  "fingerprint" text not null,
  "byte_size" integer not null,
  "content_type" text not null,
  "object_path" text not null,
  "status" text not null default 'pending',
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "product_media_size_valid" check ("byte_size" > 0 and "byte_size" <= 8388608),
  constraint "product_media_mime_valid" check ("content_type" = 'image/jpeg'),
  constraint "product_media_fingerprint_valid" check ("fingerprint" ~ '^[a-f0-9]{64}$'),
  constraint "product_media_status_valid" check ("status" in ('pending', 'ready'))
);
create unique index "product_media_brand_request_unique" on "ufit"."product_media_assets" ("brand_id", "request_id");
create unique index "product_media_object_path_unique" on "ufit"."product_media_assets" ("object_path");

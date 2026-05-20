do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typname = 'gender_target' and n.nspname = 'ufit') then
    create type "ufit"."gender_target" as enum ('male', 'female', 'unisex');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typname = 'product_status' and n.nspname = 'ufit') then
    create type "ufit"."product_status" as enum ('draft', 'under_review', 'active', 'rejected', 'archived');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typname = 'product_variant_status' and n.nspname = 'ufit') then
    create type "ufit"."product_variant_status" as enum ('active', 'out_of_stock', 'archived');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typname = 'product_image_kind' and n.nspname = 'ufit') then
    create type "ufit"."product_image_kind" as enum ('product', 'worn', 'detail', 'lookbook');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typname = 'outfit_status' and n.nspname = 'ufit') then
    create type "ufit"."outfit_status" as enum ('draft', 'submitted', 'under_review', 'published', 'rejected', 'archived');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typname = 'outfit_visibility' and n.nspname = 'ufit') then
    create type "ufit"."outfit_visibility" as enum ('public', 'private', 'featured');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typname = 'outfit_item_type' and n.nspname = 'ufit') then
    create type "ufit"."outfit_item_type" as enum ('top', 'bottom', 'shoes', 'bag', 'accessory', 'outerwear');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typname = 'tag_type' and n.nspname = 'ufit') then
    create type "ufit"."tag_type" as enum ('style', 'occasion', 'season');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typname = 'editorial_collection_status' and n.nspname = 'ufit') then
    create type "ufit"."editorial_collection_status" as enum ('draft', 'published', 'archived');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typname = 'editorial_item_type' and n.nspname = 'ufit') then
    create type "ufit"."editorial_item_type" as enum ('outfit', 'product');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typname = 'featured_slot_surface' and n.nspname = 'ufit') then
    create type "ufit"."featured_slot_surface" as enum ('home', 'feed', 'collection');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typname = 'featured_slot_content_type' and n.nspname = 'ufit') then
    create type "ufit"."featured_slot_content_type" as enum ('outfit', 'product', 'collection');
  end if;
end $$;

create table if not exists "ufit"."product_categories" (
  "id" uuid primary key default gen_random_uuid(),
  "parent_id" uuid references "ufit"."product_categories" ("id") on delete set null,
  "slug" text not null,
  "name" text not null,
  "position" integer not null default 0,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create unique index if not exists "product_categories_slug_unique" on "ufit"."product_categories" ("slug");

create table if not exists "ufit"."products" (
  "id" uuid primary key default gen_random_uuid(),
  "brand_id" uuid not null,
  "category_id" uuid references "ufit"."product_categories" ("id") on delete set null,
  "name" text not null,
  "slug" text not null,
  "description" text not null,
  "category" text not null,
  "gender_target" "ufit"."gender_target",
  "status" "ufit"."product_status" not null default 'draft',
  "base_price" integer not null check ("base_price" >= 0),
  "currency" text not null default 'CHF',
  "material" text,
  "care_instructions" text,
  "commission_rate_override" numeric(5, 4),
  "reviewed_by" uuid references "ufit"."users" ("id") on delete set null,
  "reviewed_at" timestamptz,
  "rejection_reason" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create unique index if not exists "products_brand_slug_unique" on "ufit"."products" ("brand_id", "slug");
create index if not exists "products_brand_status_idx" on "ufit"."products" ("brand_id", "status");
create index if not exists "products_status_id_idx" on "ufit"."products" ("status", "id");

create table if not exists "ufit"."product_variants" (
  "id" uuid primary key default gen_random_uuid(),
  "product_id" uuid not null references "ufit"."products" ("id") on delete cascade,
  "size" text,
  "color" text,
  "sku" text not null,
  "stock_quantity" integer not null default 0 check ("stock_quantity" >= 0),
  "price_override" integer check ("price_override" is null or "price_override" >= 0),
  "status" "ufit"."product_variant_status" not null default 'active',
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create unique index if not exists "product_variants_sku_unique" on "ufit"."product_variants" ("sku");
create index if not exists "product_variants_product_idx" on "ufit"."product_variants" ("product_id");

create table if not exists "ufit"."product_images" (
  "id" uuid primary key default gen_random_uuid(),
  "product_id" uuid not null references "ufit"."products" ("id") on delete cascade,
  "url" text not null,
  "position" integer not null default 0,
  "kind" "ufit"."product_image_kind" not null default 'product',
  "created_at" timestamptz not null default now()
);

create table if not exists "ufit"."outfits" (
  "id" uuid primary key default gen_random_uuid(),
  "creator_id" uuid,
  "brand_id" uuid,
  "title" text not null,
  "description" text not null,
  "cover_image_url" text not null,
  "status" "ufit"."outfit_status" not null default 'draft',
  "visibility" "ufit"."outfit_visibility" not null default 'private',
  "gender_target" "ufit"."gender_target",
  "total_price_min" integer not null default 0 check ("total_price_min" >= 0),
  "total_price_max" integer not null default 0 check ("total_price_max" >= 0),
  "reviewed_by" uuid references "ufit"."users" ("id") on delete set null,
  "reviewed_at" timestamptz,
  "rejection_reason" text,
  "published_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "outfits_owner_required_check" check ("creator_id" is not null or "brand_id" is not null),
  constraint "outfits_price_range_check" check ("total_price_max" >= "total_price_min")
);

create index if not exists "outfits_status_id_idx" on "ufit"."outfits" ("status", "id");
create index if not exists "outfits_creator_idx" on "ufit"."outfits" ("creator_id");
create index if not exists "outfits_brand_idx" on "ufit"."outfits" ("brand_id");

create table if not exists "ufit"."outfit_items" (
  "id" uuid primary key default gen_random_uuid(),
  "outfit_id" uuid not null references "ufit"."outfits" ("id") on delete cascade,
  "product_id" uuid references "ufit"."products" ("id") on delete set null,
  "external_label" text,
  "item_type" "ufit"."outfit_item_type" not null,
  "position" integer not null default 0,
  "is_required" boolean not null default true,
  "is_shoppable" boolean not null default false,
  "styling_note" text,
  "created_at" timestamptz not null default now(),
  constraint "outfit_items_content_check" check (
    ("is_shoppable" = true and "product_id" is not null)
    or ("is_shoppable" = false and ("product_id" is not null or "external_label" is not null))
  )
);

create index if not exists "outfit_items_outfit_position_idx" on "ufit"."outfit_items" ("outfit_id", "position");
create index if not exists "outfit_items_product_idx" on "ufit"."outfit_items" ("product_id");

create table if not exists "ufit"."outfit_images" (
  "id" uuid primary key default gen_random_uuid(),
  "outfit_id" uuid not null references "ufit"."outfits" ("id") on delete cascade,
  "url" text not null,
  "position" integer not null default 0,
  "created_at" timestamptz not null default now()
);

create table if not exists "ufit"."tags" (
  "id" uuid primary key default gen_random_uuid(),
  "type" "ufit"."tag_type" not null,
  "slug" text not null,
  "label" text not null,
  "created_at" timestamptz not null default now()
);

create unique index if not exists "tags_type_slug_unique" on "ufit"."tags" ("type", "slug");

create table if not exists "ufit"."outfit_tags" (
  "outfit_id" uuid not null references "ufit"."outfits" ("id") on delete cascade,
  "tag_id" uuid not null references "ufit"."tags" ("id") on delete cascade
);

create unique index if not exists "outfit_tags_unique" on "ufit"."outfit_tags" ("outfit_id", "tag_id");

create table if not exists "ufit"."editorial_collections" (
  "id" uuid primary key default gen_random_uuid(),
  "title" text not null,
  "subtitle" text,
  "description" text not null,
  "cover_image_url" text,
  "status" "ufit"."editorial_collection_status" not null default 'draft',
  "created_by" uuid not null references "ufit"."users" ("id") on delete restrict,
  "published_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create table if not exists "ufit"."editorial_collection_items" (
  "id" uuid primary key default gen_random_uuid(),
  "collection_id" uuid not null references "ufit"."editorial_collections" ("id") on delete cascade,
  "item_type" "ufit"."editorial_item_type" not null,
  "outfit_id" uuid references "ufit"."outfits" ("id") on delete cascade,
  "product_id" uuid references "ufit"."products" ("id") on delete cascade,
  "position" integer not null default 0,
  "created_at" timestamptz not null default now(),
  constraint "editorial_collection_items_target_check" check (
    ("item_type" = 'outfit' and "outfit_id" is not null and "product_id" is null)
    or ("item_type" = 'product' and "product_id" is not null and "outfit_id" is null)
  )
);

create index if not exists "editorial_collection_items_collection_position_idx"
  on "ufit"."editorial_collection_items" ("collection_id", "position");

create table if not exists "ufit"."featured_slots" (
  "id" uuid primary key default gen_random_uuid(),
  "surface" "ufit"."featured_slot_surface" not null,
  "slot_key" text not null,
  "content_type" "ufit"."featured_slot_content_type" not null,
  "outfit_id" uuid references "ufit"."outfits" ("id") on delete cascade,
  "product_id" uuid references "ufit"."products" ("id") on delete cascade,
  "collection_id" uuid references "ufit"."editorial_collections" ("id") on delete cascade,
  "starts_at" timestamptz,
  "ends_at" timestamptz,
  "created_at" timestamptz not null default now(),
  constraint "featured_slots_target_check" check (
    ("content_type" = 'outfit' and "outfit_id" is not null and "product_id" is null and "collection_id" is null)
    or ("content_type" = 'product' and "product_id" is not null and "outfit_id" is null and "collection_id" is null)
    or ("content_type" = 'collection' and "collection_id" is not null and "outfit_id" is null and "product_id" is null)
  )
);

create unique index if not exists "featured_slots_surface_slot_unique"
  on "ufit"."featured_slots" ("surface", "slot_key");

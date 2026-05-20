create extension if not exists "pgcrypto";

create table if not exists "ufit"."saved_outfits" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" uuid not null references "ufit"."users" ("id") on delete cascade,
  "outfit_id" uuid not null references "ufit"."outfits" ("id") on delete cascade,
  "created_at" timestamptz not null default now()
);

create unique index if not exists "saved_outfits_user_outfit_unique" on "ufit"."saved_outfits" ("user_id", "outfit_id");
create index if not exists "saved_outfits_user_id_idx" on "ufit"."saved_outfits" ("user_id");

create table if not exists "ufit"."creator_follows" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" uuid not null references "ufit"."users" ("id") on delete cascade,
  "creator_id" uuid not null references "ufit"."creator_profiles" ("id") on delete cascade,
  "created_at" timestamptz not null default now()
);

create unique index if not exists "creator_follows_user_creator_unique" on "ufit"."creator_follows" ("user_id", "creator_id");
create index if not exists "creator_follows_user_id_idx" on "ufit"."creator_follows" ("user_id");

create table if not exists "ufit"."carts" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" uuid not null references "ufit"."users" ("id") on delete cascade,
  "status" text not null default 'active' check ("status" in ('active', 'checked_out', 'abandoned')),
  "brand_id" uuid,
  "source_outfit_id" uuid references "ufit"."outfits" ("id") on delete set null,
  "source_creator_id" uuid references "ufit"."creator_profiles" ("id") on delete set null,
  "currency" text not null default 'CHF',
  "subtotal_amount" integer not null default 0 check ("subtotal_amount" >= 0),
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create index if not exists "carts_user_status_idx" on "ufit"."carts" ("user_id", "status");

create table if not exists "ufit"."cart_items" (
  "id" uuid primary key default gen_random_uuid(),
  "cart_id" uuid not null references "ufit"."carts" ("id") on delete cascade,
  "product_id" uuid not null references "ufit"."products" ("id") on delete restrict,
  "product_variant_id" uuid not null references "ufit"."product_variants" ("id") on delete restrict,
  "quantity" integer not null check ("quantity" > 0),
  "unit_price" integer not null check ("unit_price" >= 0),
  "currency" text not null default 'CHF',
  "brand_id" uuid not null,
  "source_outfit_id" uuid references "ufit"."outfits" ("id") on delete set null,
  "source_creator_id" uuid references "ufit"."creator_profiles" ("id") on delete set null,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create unique index if not exists "cart_items_cart_variant_outfit_unique" on "ufit"."cart_items" ("cart_id", "product_variant_id", "source_outfit_id");
create index if not exists "cart_items_cart_id_idx" on "ufit"."cart_items" ("cart_id");

create table if not exists "ufit"."orders" (
  "id" uuid primary key default gen_random_uuid(),
  "order_number" text not null unique,
  "customer_id" uuid not null references "ufit"."users" ("id") on delete restrict,
  "brand_id" uuid not null,
  "source_creator_id" uuid references "ufit"."creator_profiles" ("id") on delete set null,
  "source_outfit_id" uuid references "ufit"."outfits" ("id") on delete set null,
  "status" text not null default 'pending_payment' check ("status" in ('pending_payment', 'paid', 'preparing', 'shipped', 'delivered', 'cancelled', 'refunded')),
  "subtotal_amount" integer not null check ("subtotal_amount" >= 0),
  "shipping_amount" integer not null default 0 check ("shipping_amount" >= 0),
  "total_amount" integer not null check ("total_amount" >= 0),
  "currency" text not null default 'CHF',
  "shipping_address" jsonb not null,
  "payment_provider" text not null default 'placeholder' check ("payment_provider" in ('placeholder', 'stripe')),
  "stripe_payment_intent_id" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create index if not exists "orders_customer_id_idx" on "ufit"."orders" ("customer_id");
create index if not exists "orders_brand_id_status_idx" on "ufit"."orders" ("brand_id", "status");
create index if not exists "orders_created_at_idx" on "ufit"."orders" ("created_at" desc);

create table if not exists "ufit"."order_items" (
  "id" uuid primary key default gen_random_uuid(),
  "order_id" uuid not null references "ufit"."orders" ("id") on delete cascade,
  "product_id" uuid not null references "ufit"."products" ("id") on delete restrict,
  "product_variant_id" uuid not null references "ufit"."product_variants" ("id") on delete restrict,
  "product_snapshot" jsonb not null,
  "quantity" integer not null check ("quantity" > 0),
  "unit_price" integer not null check ("unit_price" >= 0),
  "total_price" integer not null check ("total_price" >= 0),
  "commission_rate" numeric(5, 4) not null default 0 check ("commission_rate" >= 0),
  "source_creator_id" uuid references "ufit"."creator_profiles" ("id") on delete set null,
  "source_outfit_id" uuid references "ufit"."outfits" ("id") on delete set null,
  "created_at" timestamptz not null default now()
);

create index if not exists "order_items_order_id_idx" on "ufit"."order_items" ("order_id");

create table if not exists "ufit"."order_status_history" (
  "id" uuid primary key default gen_random_uuid(),
  "order_id" uuid not null references "ufit"."orders" ("id") on delete cascade,
  "from_status" text,
  "to_status" text not null,
  "changed_by" uuid references "ufit"."users" ("id") on delete set null,
  "reason" text,
  "created_at" timestamptz not null default now()
);

create table if not exists "ufit"."payments" (
  "id" uuid primary key default gen_random_uuid(),
  "order_id" uuid not null references "ufit"."orders" ("id") on delete cascade,
  "provider" text not null default 'placeholder' check ("provider" in ('placeholder', 'stripe')),
  "provider_payment_intent_id" text,
  "status" text not null default 'disabled' check ("status" in ('disabled', 'requires_payment', 'succeeded', 'failed', 'refunded')),
  "amount" integer not null check ("amount" >= 0),
  "currency" text not null default 'CHF',
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create index if not exists "payments_order_id_idx" on "ufit"."payments" ("order_id");

create table if not exists "ufit"."commission_rules" (
  "id" uuid primary key default gen_random_uuid(),
  "brand_id" uuid,
  "product_id" uuid references "ufit"."products" ("id") on delete cascade,
  "creator_grade_code" text references "ufit"."creator_grades" ("code") on delete cascade,
  "base_rate" numeric(5, 4) not null check ("base_rate" >= 0),
  "bonus_rate" numeric(5, 4) not null default 0 check ("bonus_rate" >= 0),
  "max_rate" numeric(5, 4),
  "active" boolean not null default true,
  "created_at" timestamptz not null default now()
);

create table if not exists "ufit"."commissions" (
  "id" uuid primary key default gen_random_uuid(),
  "order_item_id" uuid not null references "ufit"."order_items" ("id") on delete cascade,
  "creator_id" uuid not null references "ufit"."creator_profiles" ("id") on delete restrict,
  "brand_id" uuid not null,
  "source_outfit_id" uuid not null references "ufit"."outfits" ("id") on delete restrict,
  "base_amount" integer not null check ("base_amount" >= 0),
  "commission_rate" numeric(5, 4) not null check ("commission_rate" >= 0),
  "commission_amount" integer not null check ("commission_amount" >= 0),
  "status" text not null default 'estimated' check ("status" in ('estimated', 'pending', 'validated', 'paid', 'cancelled')),
  "validation_date" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create index if not exists "commissions_creator_status_idx" on "ufit"."commissions" ("creator_id", "status");
create index if not exists "commissions_order_item_id_idx" on "ufit"."commissions" ("order_item_id");

create table if not exists "ufit"."commission_events" (
  "id" uuid primary key default gen_random_uuid(),
  "commission_id" uuid not null references "ufit"."commissions" ("id") on delete cascade,
  "event_type" text not null,
  "from_status" text,
  "to_status" text,
  "payload" jsonb not null default '{}'::jsonb,
  "created_by" uuid references "ufit"."users" ("id") on delete set null,
  "created_at" timestamptz not null default now()
);

create table if not exists "ufit"."creator_payouts" (
  "id" uuid primary key default gen_random_uuid(),
  "creator_id" uuid not null references "ufit"."creator_profiles" ("id") on delete restrict,
  "status" text not null default 'pending' check ("status" in ('pending', 'processing', 'paid', 'failed', 'cancelled')),
  "amount" integer not null check ("amount" >= 0),
  "currency" text not null default 'CHF',
  "period_start" date not null,
  "period_end" date not null,
  "paid_at" timestamptz,
  "created_at" timestamptz not null default now()
);

create table if not exists "ufit"."shipments" (
  "id" uuid primary key default gen_random_uuid(),
  "order_id" uuid not null references "ufit"."orders" ("id") on delete cascade unique,
  "brand_id" uuid not null,
  "status" text not null default 'pending' check ("status" in ('pending', 'preparing', 'shipped', 'delivered', 'failed')),
  "carrier" text,
  "tracking_number" text,
  "tracking_url" text,
  "label_url" text,
  "shipped_at" timestamptz,
  "delivered_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create index if not exists "shipments_brand_status_idx" on "ufit"."shipments" ("brand_id", "status");

create table if not exists "ufit"."shipment_events" (
  "id" uuid primary key default gen_random_uuid(),
  "shipment_id" uuid not null references "ufit"."shipments" ("id") on delete cascade,
  "from_status" text,
  "to_status" text not null,
  "payload" jsonb not null default '{}'::jsonb,
  "created_by" uuid references "ufit"."users" ("id") on delete set null,
  "created_at" timestamptz not null default now()
);

create table if not exists "ufit"."admin_action_logs" (
  "id" uuid primary key default gen_random_uuid(),
  "admin_user_id" uuid not null references "ufit"."users" ("id") on delete restrict,
  "action" text not null,
  "target_type" text not null,
  "target_id" uuid,
  "payload" jsonb not null default '{}'::jsonb,
  "created_at" timestamptz not null default now()
);

create index if not exists "admin_action_logs_target_idx" on "ufit"."admin_action_logs" ("target_type", "target_id");

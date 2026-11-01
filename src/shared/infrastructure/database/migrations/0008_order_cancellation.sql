alter table "ufit"."orders" drop constraint "orders_status_check";
alter table "ufit"."orders" add constraint "orders_status_check"
  check ("status" in ('pending_payment','paid','cancelling','preparing','shipped','delivered','cancelled','refunded'));
alter table "ufit"."shipments" drop constraint "shipments_status_check";
alter table "ufit"."shipments" add constraint "shipments_status_check"
  check ("status" in ('pending','preparing','shipped','delivered','failed','cancelled'));
create table "ufit"."order_cancellations" (
  "id" uuid primary key default gen_random_uuid(),
  "order_id" uuid not null unique references "ufit"."orders" ("id") on delete cascade,
  "requested_by" uuid references "ufit"."users" ("id") on delete set null,
  "original_status" text not null check ("original_status" in ('pending_payment','paid')),
  "status" text not null check ("status" in ('requested','succeeded')),
  "payment_outcome" text check ("payment_outcome" in ('not_charged','refunded')),
  "stripe_refund_id" text unique,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

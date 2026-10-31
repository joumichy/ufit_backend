alter table "ufit"."orders"
  add column "tax_amount" integer not null default 0 check ("tax_amount" >= 0),
  add column "cart_id" uuid references "ufit"."carts" ("id"),
  add column "checkout_request_id" uuid,
  add column "checkout_fingerprint" text,
  add column "commerce_snapshot" jsonb;

create unique index "orders_customer_checkout_request_unique"
  on "ufit"."orders" ("customer_id", "checkout_request_id");

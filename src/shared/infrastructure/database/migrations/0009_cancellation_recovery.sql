alter table "ufit"."order_cancellations"
  add column "reason" text,
  add column "next_recovery_at" timestamptz not null default now();

-- Before this migration, the only producer was the authenticated customer cancellation route.
update "ufit"."order_cancellations" set "reason" = 'customer_requested';
alter table "ufit"."order_cancellations"
  alter column "reason" set not null,
  add constraint "order_cancellations_reason_check"
    check ("reason" in ('customer_requested', 'stock_unavailable'));
create index "order_cancellations_recovery_idx"
  on "ufit"."order_cancellations" ("next_recovery_at", "id") where "status" = 'requested';

-- The old completion transaction applied stock/shipment effects atomically.
-- Refuse an unfinished legacy refund: its current provider facts must be
-- reconciled before removing the old financial reference.
do $$ begin
  if exists(select 1 from ufit.order_cancellations where status <> 'succeeded'
    or payment_outcome is null or (payment_outcome = 'refunded') <> (stripe_refund_id is not null)) then
    raise exception 'Resolve existing cancellation settlements before migration 0036';
  end if;
end $$;

alter table ufit.order_cancellations add column effects_applied boolean not null default false;
update ufit.order_cancellations set effects_applied = true where status = 'succeeded';
alter table ufit.order_cancellations drop constraint order_cancellations_status_check;
alter table ufit.order_cancellations add constraint order_cancellations_status_check check(status in ('requested','succeeded','failed'));
alter table ufit.order_cancellations drop constraint order_cancellations_payment_outcome_check;
alter table ufit.order_cancellations add constraint order_cancellations_payment_outcome_check check(payment_outcome in ('not_charged','refunded','refund_failed','refund_canceled','refund_blocked'));

create table ufit.order_cancellation_refunds (
  id uuid primary key default gen_random_uuid(),
  cancellation_id uuid not null references ufit.order_cancellations(id) on delete cascade,
  attempt_number integer not null,
  payment_intent_id text not null,
  amount integer not null,
  currency text not null,
  state text not null,
  provider_status text,
  stripe_refund_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_cancellation_refunds_amount_valid check(amount > 0 and attempt_number >= 1),
  constraint order_cancellation_refunds_currency_valid check(currency ~ '^[A-Z]{3}$'),
  constraint order_cancellation_refunds_state_valid check(state in ('queued','pending','succeeded','failed','blocked')),
  constraint order_cancellation_refunds_provider_valid check((
    (state in ('queued','blocked') and stripe_refund_id is null and provider_status is null)
    or (stripe_refund_id is not null and (
      (state = 'pending' and provider_status in ('pending','requires_action'))
      or (state = 'succeeded' and provider_status = 'succeeded')
      or (state = 'failed' and provider_status in ('failed','canceled'))
    ))
  ) is true)
);
create unique index order_cancellation_refunds_attempt_unique on ufit.order_cancellation_refunds(cancellation_id, attempt_number);
create unique index order_cancellation_refunds_one_active on ufit.order_cancellation_refunds(cancellation_id) where state in ('queued','pending');

-- The first attempt keeps the original idempotency identity. Provider metadata
-- must be backfilled with cancellation_refund_attempt_id = cancellation id
-- using scripts/prepare-cancellation-refund-migration.ts before API restart.
insert into ufit.order_cancellation_refunds(id,cancellation_id,attempt_number,payment_intent_id,amount,currency,state,provider_status,stripe_refund_id,created_at,updated_at)
select c.id,c.id,1,o.stripe_payment_intent_id,o.total_amount,o.currency,'succeeded','succeeded',c.stripe_refund_id,c.created_at,c.updated_at
from ufit.order_cancellations c join ufit.orders o on o.id=c.order_id where c.payment_outcome='refunded';
alter table ufit.order_cancellations drop column stripe_refund_id;

-- Durable instructions precede provider side effects; immutable receipts represent actual money.
create table ufit.payment_disbursement_jobs (
  payment_id uuid primary key references ufit.payment_settlements(payment_id), status text not null,
  next_attempt_at timestamptz, lease_token uuid, lease_until timestamptz, failure_code text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint payment_disbursement_jobs_state check (
    (status='processing' and lease_token is not null and lease_until is not null and next_attempt_at is null)
    or (status in ('queued','waiting') and lease_token is null and lease_until is null and next_attempt_at is not null)
    or (status='needs_review' and lease_token is null and lease_until is null and next_attempt_at is null and failure_code is not null))
);
create index payment_disbursement_jobs_due on ufit.payment_disbursement_jobs(status,next_attempt_at,lease_until);
create table ufit.payment_disbursement_targets (
  id uuid primary key, payment_id uuid not null references ufit.payment_allocations(payment_id), fingerprint text not null,
  assessment jsonb not null, created_at timestamptz not null,
  constraint payment_disbursement_targets_fingerprint_valid check (fingerprint ~ '^[a-f0-9]{64}$'),
  unique(id,payment_id), unique(payment_id,fingerprint)
);
create table ufit.payment_transfer_operations (
  id uuid primary key, payment_id uuid not null, target_id uuid not null, kind text not null, state text not null,
  allocation_key text not null, original_operation_id uuid references ufit.payment_transfer_operations(id),
  instruction jsonb not null, created_at timestamptz not null,
  foreign key(target_id,payment_id) references ufit.payment_disbursement_targets(id,payment_id), unique(id,payment_id),
  constraint payment_transfer_operations_kind check (kind in ('transfer','reversal')),
  constraint payment_transfer_operations_state check (state in ('open','recorded','superseded')),
  constraint payment_transfer_operations_original check ((kind='transfer' and original_operation_id is null)
    or (kind='reversal' and original_operation_id is not null and original_operation_id<>id))
);
create unique index payment_transfer_operations_one_open on ufit.payment_transfer_operations(payment_id) where state='open';
create table ufit.payment_transfer_receipts (
  operation_id uuid primary key, payment_id uuid not null, provider_id text not null unique, kind text not null,
  amount integer not null, currency text not null, snapshot jsonb not null, recorded_at timestamptz not null,
  foreign key(operation_id,payment_id) references ufit.payment_transfer_operations(id,payment_id),
  constraint payment_transfer_receipts_money check (amount>0 and currency ~ '^[A-Z]{3}$')
);

create function ufit.guard_disbursement_target() returns trigger language plpgsql as $$
declare p ufit.payment_allocations%rowtype; a jsonb; l jsonb; n integer; gross bigint; fee bigint; net bigint; scan uuid; actual_gross bigint; actual_fee bigint; actual_net bigint;
begin
  if TG_OP<>'INSERT' then raise exception 'Disbursement targets are immutable'; end if;
  select * into strict p from ufit.payment_allocations where payment_id=NEW.payment_id;
  a:=NEW.assessment;
  if (jsonb_typeof(a)='object' and a->>'phase' in ('settled','return_reservation')
    and a->>'algorithm'='original_share_cumulative_return_v1' and a->>'paymentId'=p.payment_id::text
    and a->>'orderId'=p.order_id::text and a->>'brandId'=p.brand_id::text and a->>'policyId'=p.policy_id::text
    and a->>'currency'=p.settlement_currency and a->>'purchaseCurrency'=p.presentment_currency
    and jsonb_typeof(a->'lines')='array' and jsonb_array_length(a->'lines')=p.line_count) is not true then
    raise exception 'Disbursement target source mismatch';
  end if;
  n:=0;gross:=0;fee:=0;net:=0;
  for l in select value from jsonb_array_elements(a->'lines') loop
    if (jsonb_typeof(l)='object' and (l->>'remainingPurchaseAmount')::bigint>=0
      and (l->>'grossAmount')::integer::bigint-(l->>'feeAmount')::integer::bigint=(l->>'netAmount')::integer::bigint
      and exists(select 1 from ufit.payment_allocation_lines x where x.payment_id=p.payment_id and x.kind=l->'recipient'->>'kind'
        and (l->>'remainingPurchaseAmount')::bigint<=x.presentment_amount::bigint
        and case x.kind when 'brand' then l->'recipient'->>'beneficiaryId'=x.brand_id::text and l->>'key'='brand/'||x.brand_id::text
          when 'creator' then l->'recipient'->>'beneficiaryId'=x.creator_id::text and l->'recipient'->>'commissionId'=x.commission_id::text
            and l->>'key'='creator/'||x.creator_id::text||'/'||x.commission_id::text
          when 'platform' then l->'recipient'->'beneficiaryId'='null'::jsonb and l->>'key'='platform' else false end)) is not true then
      raise exception 'Disbursement line mismatch';
    end if;
    n:=n+1;gross:=gross+(l->>'grossAmount')::bigint;fee:=fee+(l->>'feeAmount')::bigint;net:=net+(l->>'netAmount')::bigint;
  end loop;
  if (select count(distinct value->>'key') from jsonb_array_elements(a->'lines'))<>n then raise exception 'Duplicate disbursement line'; end if;
  if a->>'phase'='settled' then
    scan:=(a->>'refundScanId')::uuid;
    select p.settlement_amount::bigint+coalesce(sum(b.amount::bigint),0),p.fee_amount::bigint+coalesce(sum(b.fee_amount::bigint),0),
      p.net_amount::bigint+coalesce(sum(b.net_amount::bigint),0) into actual_gross,actual_fee,actual_net
      from ufit.payment_refund_scan_items i join ufit.payment_refund_balances b on b.id=i.debit_id or b.id=i.failure_id
      where i.scan_id=scan and i.payment_id=p.payment_id;
    if (gross=actual_gross and fee=actual_fee and net=actual_net and gross=(a->>'sourceGrossAmount')::integer::bigint and fee=(a->>'sourceFeeAmount')::integer::bigint
      and net=(a->>'sourceNetAmount')::integer::bigint and gross-fee=net and exists(select 1 from ufit.payment_refund_scans s
        where s.id=scan and s.payment_id=p.payment_id)) is not true then raise exception 'Unbalanced disbursement target'; end if;
  elsif (a ? 'sourceNetAmount' or a ? 'refundScanId') then raise exception 'Reservation is not settled money'; end if;
  return NEW;
end $$;
create trigger payment_disbursement_target_guard before insert or update or delete on ufit.payment_disbursement_targets
  for each row execute function ufit.guard_disbursement_target();

create function ufit.guard_transfer_operation() returns trigger language plpgsql as $$
declare a jsonb; i jsonb; base jsonb; l jsonb; prior ufit.payment_transfer_operations%rowtype;
  receipt ufit.payment_transfer_receipts%rowtype; amount bigint; reversed bigint; sent bigint; all_sent bigint; charge_sent bigint;
begin
  if TG_OP='DELETE' then raise exception 'Transfer operations cannot be deleted'; end if;
  if TG_OP='UPDATE' then
    if (to_jsonb(NEW)-'state') is distinct from (to_jsonb(OLD)-'state') or OLD.state<>'open'
      or NEW.state not in ('recorded','superseded') then raise exception 'Transfer instruction is immutable'; end if;
    return NEW;
  end if;
  if NEW.state<>'open' then raise exception 'New transfer operations must be open'; end if;
  select assessment into strict a from ufit.payment_disbursement_targets where id=NEW.target_id and payment_id=NEW.payment_id;
  i:=NEW.instruction; amount:=(i->>'amount')::integer;
  if NEW.kind='transfer' then base:=i; else base:=i->'original'; end if;
  select value into strict l from jsonb_array_elements(a->'lines') where value->>'key'=NEW.allocation_key;
  if (i->>'id'=NEW.id::text and base->>'paymentId'=NEW.payment_id::text and base->>'orderId'=a->>'orderId'
    and base->>'allocationKey'=NEW.allocation_key and base->'recipient'=l->'recipient'
    and base->>'currency'=a->>'currency' and amount>0 and base->'account'->>'profileId'=l->'recipient'->>'beneficiaryId'
    and base->'account'->>'kind'=l->'recipient'->>'kind' and base->'account'->'liveMode'=base->'capture'->'liveMode'
    and base->'refunds'->'source'->>'paymentId'=NEW.payment_id::text
    and base->'refunds'->'source'->'capture'=base->'capture'
    and exists(select 1 from ufit.payment_settlements s join ufit.payments p on p.id=s.payment_id where s.payment_id=NEW.payment_id
      and p.provider_payment_intent_id=base->>'paymentIntentId' and s.charge_id=base->'capture'->>'chargeId'
      and s.balance_transaction_id=base->'capture'->>'balanceTransactionId'
      and s.charge_amount=(base->'capture'->>'chargeAmount')::integer and s.charge_currency=base->'capture'->>'chargeCurrency'
      and s.settlement_amount=(base->'capture'->>'settlementAmount')::integer and s.settlement_currency=base->'capture'->>'settlementCurrency'
      and s.fee_amount=(base->'capture'->>'feeAmount')::integer and s.net_amount=(base->'capture'->>'netAmount')::integer
      and s.live_mode=(base->'capture'->>'liveMode')::boolean)) is not true then raise exception 'Transfer instruction source mismatch'; end if;
  select coalesce(sum(case when r.kind='transfer' then r.amount::bigint else -r.amount::bigint end),0) into sent
    from ufit.payment_transfer_receipts r join ufit.payment_transfer_operations o on o.id=r.operation_id
    where r.payment_id=NEW.payment_id and o.allocation_key=NEW.allocation_key;
  if NEW.kind='transfer' then
    select coalesce(sum(case when r.kind='transfer' then r.amount::bigint else -r.amount::bigint end),0) into all_sent
      from ufit.payment_transfer_receipts r where r.payment_id=NEW.payment_id;
    select coalesce(sum(r.amount::bigint),0) into charge_sent from ufit.payment_transfer_receipts r
      join ufit.payment_transfer_operations o on o.id=r.operation_id where r.payment_id=NEW.payment_id
      and r.kind='transfer' and o.instruction->>'funding'='charge';
    if (a->>'phase'='settled' and not exists(select 1 from jsonb_array_elements(a->'lines') x where (x->>'netAmount')::bigint<0)
      and sent+amount<=(l->>'netAmount')::bigint and all_sent+amount<=(a->>'sourceNetAmount')::bigint
      and ((i->>'funding'='charge' and charge_sent+amount<=(i->'capture'->>'settlementAmount')::bigint)
        or i->>'funding'='available_balance')) is not true then raise exception 'Transfer exceeds settled entitlement'; end if;
  else
    select * into strict prior from ufit.payment_transfer_operations where id=NEW.original_operation_id;
    select * into strict receipt from ufit.payment_transfer_receipts where operation_id=prior.id;
    select coalesce(sum(r.amount::bigint),0) into reversed from ufit.payment_transfer_receipts r join ufit.payment_transfer_operations o on o.id=r.operation_id
      where o.original_operation_id=prior.id;
    if (prior.kind='transfer' and prior.state='recorded' and prior.payment_id=NEW.payment_id and prior.instruction=i->'original'
      and receipt.provider_id=i->>'transferId' and reversed=(i->>'expectedReversedAmount')::bigint
      and reversed+amount<=receipt.amount::bigint and amount<=sent-greatest(0,(l->>'netAmount')::bigint)) is not true then
      raise exception 'Reversal exceeds known transfer or target adjustment'; end if;
  end if;
  return NEW;
end $$;
create trigger payment_transfer_operation_guard before insert or update or delete on ufit.payment_transfer_operations
  for each row execute function ufit.guard_transfer_operation();

create function ufit.guard_transfer_receipt() returns trigger language plpgsql as $$
declare o ufit.payment_transfer_operations%rowtype; i jsonb; s jsonb; base jsonb;
begin
  if TG_OP<>'INSERT' then raise exception 'Transfer receipts are immutable'; end if;
  select * into strict o from ufit.payment_transfer_operations where id=NEW.operation_id and payment_id=NEW.payment_id;
  i:=o.instruction;s:=NEW.snapshot;
  if (o.state='open' and NEW.kind=o.kind and NEW.provider_id=s->>'id' and NEW.amount=(i->>'amount')::integer
    and NEW.amount=(s->>'amount')::integer and NEW.currency=s->>'currency') is not true then raise exception 'Transfer receipt mismatch'; end if;
  if NEW.kind='transfer' then
    if (NEW.provider_id ~ '^tr_[A-Za-z0-9_]+$' and NEW.currency=i->>'currency' and s->>'destination'=i->'account'->>'stripeAccountId'
      and s->'liveMode'=i->'capture'->'liveMode' and s->>'transferGroup'='order:'||(i->>'orderId')
      and (s->>'reversedAmount')::bigint between 0 and NEW.amount
      and ((i->>'funding'='charge' and s->>'sourceChargeId'=i->'capture'->>'chargeId')
        or (i->>'funding'='available_balance' and s->'sourceChargeId'='null'::jsonb))) is not true then raise exception 'Transfer provider source mismatch'; end if;
  else
    if (NEW.provider_id ~ '^trr_[A-Za-z0-9_]+$' and s->>'transferId'=i->>'transferId' and NEW.currency=i->'original'->>'currency') is not true then
      raise exception 'Reversal provider source mismatch'; end if;
  end if;
  return NEW;
end $$;
create trigger payment_transfer_receipt_guard before insert or update or delete on ufit.payment_transfer_receipts
  for each row execute function ufit.guard_transfer_receipt();
create function ufit.assert_transfer_receipt_state() returns trigger language plpgsql as $$
declare operation uuid; state text; receipt boolean;
begin
  if TG_TABLE_NAME='payment_transfer_operations' then operation:=NEW.id;else operation:=NEW.operation_id;end if;
  select o.state into strict state from ufit.payment_transfer_operations o where id=operation;
  select exists(select 1 from ufit.payment_transfer_receipts where operation_id=operation) into receipt;
  if (state='recorded')<>receipt then raise exception 'Transfer receipt and operation state must commit together'; end if;
  return null;
end $$;
create constraint trigger payment_transfer_operation_receipt after insert or update on ufit.payment_transfer_operations
  deferrable initially deferred for each row execute function ufit.assert_transfer_receipt_state();
create constraint trigger payment_transfer_receipt_state after insert on ufit.payment_transfer_receipts
  deferrable initially deferred for each row execute function ufit.assert_transfer_receipt_state();

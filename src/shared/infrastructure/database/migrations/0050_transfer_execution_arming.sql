-- Existing instructions may already have reached Stripe. Never backfill them as definitely unsent.
alter table ufit.payment_transfer_operations add column armed boolean not null default true;
alter table ufit.payment_transfer_operations alter column armed set default false;

create or replace function ufit.guard_transfer_operation() returns trigger language plpgsql as $$
declare a jsonb; i jsonb; base jsonb; l jsonb; prior ufit.payment_transfer_operations%rowtype;
  receipt ufit.payment_transfer_receipts%rowtype; amount bigint; reversed bigint; sent bigint; all_sent bigint; charge_sent bigint;
begin
  if TG_OP='DELETE' then raise exception 'Transfer operations cannot be deleted'; end if;
  if TG_OP='UPDATE' then
    if (to_jsonb(NEW)-'state'-'armed') is distinct from (to_jsonb(OLD)-'state'-'armed') or OLD.state<>'open' then
      raise exception 'Transfer instruction is immutable';
    end if;
    if NEW.state='open' then
      if OLD.armed or not NEW.armed then raise exception 'Transfer execution arming is monotonic'; end if;
    elsif NEW.state in ('recorded','superseded') then
      if NEW.armed<>OLD.armed or (NEW.state='superseded' and OLD.armed) then raise exception 'An armed transfer cannot be superseded'; end if;
    else raise exception 'Invalid transfer instruction state'; end if;
    return NEW;
  end if;
  if NEW.state<>'open' or NEW.armed then raise exception 'New transfer operations must be open'; end if;
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

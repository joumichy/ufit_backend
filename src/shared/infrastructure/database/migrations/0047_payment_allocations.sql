create table ufit.payment_allocations (
  payment_id uuid primary key references ufit.payment_settlements(payment_id),
  order_id uuid not null references ufit.orders(id),
  brand_id uuid not null references ufit.brand_profiles(id),
  policy_id uuid not null references ufit.payment_distribution_policies(id),
  algorithm text not null,
  charge_id text not null,
  balance_transaction_id text not null,
  presentment_amount integer not null,
  presentment_currency text not null,
  settlement_amount integer not null,
  settlement_currency text not null,
  fee_amount integer not null,
  net_amount integer not null,
  fee_bearer text not null,
  line_count integer not null,
  created_at timestamptz not null,
  constraint payment_allocations_amounts check(presentment_amount>0 and settlement_amount>0 and fee_amount>=0
    and settlement_amount::bigint-fee_amount::bigint=net_amount::bigint),
  constraint payment_allocations_algorithm check(algorithm='source_gross_largest_remainder_v1'),
  constraint payment_allocations_line_count check(line_count>1)
);
create table ufit.payment_allocation_lines (
  id uuid primary key,
  payment_id uuid not null references ufit.payment_allocations(payment_id),
  kind text not null,
  brand_id uuid references ufit.brand_profiles(id),
  creator_id uuid references ufit.creator_profiles(id),
  commission_id uuid references ufit.commissions(id),
  presentment_amount integer not null,
  gross_amount integer not null,
  fee_amount integer not null,
  net_amount integer not null,
  constraint payment_allocation_lines_recipient check(
    (kind='brand' and brand_id is not null and creator_id is null and commission_id is null)
    or (kind='creator' and brand_id is null and creator_id is not null and commission_id is not null)
    or (kind='platform' and brand_id is null and creator_id is null and commission_id is null)),
  constraint payment_allocation_lines_amounts check(presentment_amount>=0 and gross_amount>=0 and fee_amount>=0
    and gross_amount::bigint-fee_amount::bigint=net_amount::bigint)
);
create unique index payment_allocation_lines_brand_unique on ufit.payment_allocation_lines(payment_id) where kind='brand';
create unique index payment_allocation_lines_platform_unique on ufit.payment_allocation_lines(payment_id) where kind='platform';
create unique index payment_allocation_lines_creator_unique on ufit.payment_allocation_lines(payment_id,commission_id) where kind='creator';

create function ufit.immutable_payment_allocation() returns trigger language plpgsql as $$
begin
  raise check_violation using message='Initial payment allocation is immutable';
end $$;
create trigger payment_allocations_immutable before update or delete on ufit.payment_allocations
  for each row execute function ufit.immutable_payment_allocation();
create trigger payment_allocation_lines_immutable before update or delete on ufit.payment_allocation_lines
  for each row execute function ufit.immutable_payment_allocation();

create function ufit.validate_payment_allocation() returns trigger language plpgsql as $$
declare a ufit.payment_allocations; p ufit.payments; o ufit.orders; r ufit.payment_settlements;
  policy ufit.payment_distribution_policies; totals record; expected_platform bigint;
begin
  select * into a from ufit.payment_allocations where payment_id=new.payment_id;
  select * into p from ufit.payments where id=a.payment_id;
  select * into o from ufit.orders where id=a.order_id;
  select * into r from ufit.payment_settlements where payment_id=a.payment_id;
  select d.* into policy from ufit.order_distribution_terms t
    join ufit.payment_distribution_policies d on d.id=t.policy_id where t.order_id=a.order_id;
  if a.payment_id is null or p.id is null or o.id is null or r.payment_id is null or policy.id is null
    or p.order_id<>a.order_id or a.brand_id<>o.brand_id or a.policy_id<>policy.id or policy.brand_id<>o.brand_id or not policy.active
    or p.provider<>'stripe' or p.status not in ('succeeded','refunded')
    or p.provider_payment_intent_id is distinct from o.stripe_payment_intent_id or p.provider_payment_intent_id is null
    or p.amount<>o.total_amount or p.currency<>o.currency
    or a.presentment_amount<>p.amount or a.presentment_currency<>p.currency
    or a.presentment_amount<>r.charge_amount or a.presentment_currency<>r.charge_currency
    or a.settlement_amount<>r.settlement_amount or a.settlement_currency<>r.settlement_currency
    or a.charge_id<>r.charge_id or a.balance_transaction_id<>r.balance_transaction_id
    or a.fee_amount<>r.fee_amount or a.net_amount<>r.net_amount or a.fee_bearer<>policy.fee_bearer then
    raise check_violation using message='Allocation must match its purchased terms and captured payment';
  end if;
  select count(*) as n, sum(presentment_amount::bigint) as presentment, sum(gross_amount::bigint) as gross,
    sum(fee_amount::bigint) as fee, sum(net_amount::bigint) as net,
    count(*)filter(where kind='brand') as brands,count(*)filter(where kind='platform') as platforms into totals
    from ufit.payment_allocation_lines where payment_id=a.payment_id;
  if totals.n<>a.line_count or totals.brands<>1 or totals.platforms<>1
    or totals.presentment is distinct from a.presentment_amount::bigint or totals.gross is distinct from a.settlement_amount::bigint
    or totals.fee is distinct from a.fee_amount::bigint or totals.net is distinct from a.net_amount::bigint
    or exists(select 1 from ufit.payment_allocation_lines l where l.payment_id=a.payment_id
      and ((l.kind='brand' and l.brand_id<>o.brand_id) or l.fee_amount<>case when l.kind=a.fee_bearer then a.fee_amount else 0 end)) then
    raise check_violation using message='Allocation components must exactly conserve their source';
  end if;
  expected_platform=(o.subtotal_amount::bigint*policy.platform_rate_bps::bigint+5000)/10000;
  if not exists(select 1 from ufit.payment_allocation_lines where payment_id=a.payment_id and kind='platform' and presentment_amount=expected_platform)
    or exists(select 1 from ufit.payment_allocation_lines l where l.payment_id=a.payment_id and l.kind='creator'
      and not exists(select 1 from ufit.commissions cm join ufit.order_items oi on oi.id=cm.order_item_id
        where oi.order_id=a.order_id and cm.creator_id=l.creator_id and cm.id=l.commission_id and cm.commission_amount=l.presentment_amount))
    or exists(select cm.id from ufit.commissions cm join ufit.order_items oi on oi.id=cm.order_item_id
      where oi.order_id=a.order_id and not exists(
        select 1 from ufit.payment_allocation_lines l where l.payment_id=a.payment_id and l.kind='creator' and l.commission_id=cm.id)) then
    raise check_violation using message='Allocation obligations must match frozen commissions';
  end if;
  return null;
end $$;
create constraint trigger payment_allocations_balanced after insert on ufit.payment_allocations
  deferrable initially deferred for each row execute function ufit.validate_payment_allocation();
create constraint trigger payment_allocation_lines_balanced after insert on ufit.payment_allocation_lines
  deferrable initially deferred for each row execute function ufit.validate_payment_allocation();

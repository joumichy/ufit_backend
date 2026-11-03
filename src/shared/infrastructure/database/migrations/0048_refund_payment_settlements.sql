create table ufit.payment_refund_scans (
  id uuid primary key, payment_id uuid not null references ufit.payment_settlements(payment_id),
  generation integer not null check(generation>=1), observed_at timestamptz not null, amount_refunded integer not null check(amount_refunded>=0),
  disputed boolean not null, item_count integer not null check(item_count>=0), recorded_at timestamptz not null default now(),
  unique(id,payment_id), unique(id,payment_id,generation)
);
create table ufit.payment_refund_balances (
  id text primary key check(id~'^txn_[A-Za-z0-9]+$'), payment_id uuid not null references ufit.payment_settlements(payment_id),
  refund_id text not null check(refund_id~'^re_[A-Za-z0-9]+$'), kind text not null,
  amount integer not null, currency text not null check(currency~'^[A-Z]{3}$'), fee_amount integer not null, net_amount integer not null,
  created_at timestamptz not null, available_at timestamptz not null, recorded_at timestamptz not null default now(),
  unique(id,payment_id,refund_id), unique(refund_id,kind),
  check(amount::bigint-fee_amount::bigint=net_amount::bigint and amount>=-2147483647 and fee_amount>=-2147483647 and net_amount>=-2147483647),
  check((kind='refund' and amount<0) or (kind='refund_failure' and amount>0))
);
create table ufit.payment_refund_scan_items (
  scan_id uuid not null, payment_id uuid not null, refund_id text not null check(refund_id~'^re_[A-Za-z0-9]+$'),
  amount integer not null check(amount>0), currency text not null check(currency~'^[A-Z]{3}$'),
  status text not null check(status in ('succeeded','pending','requires_action','failed','canceled')), created_at timestamptz not null,
  debit_id text, failure_id text,
  primary key(scan_id,refund_id),
  foreign key(scan_id,payment_id) references ufit.payment_refund_scans(id,payment_id),
  foreign key(debit_id,payment_id,refund_id) references ufit.payment_refund_balances(id,payment_id,refund_id),
  foreign key(failure_id,payment_id,refund_id) references ufit.payment_refund_balances(id,payment_id,refund_id),
  check(failure_id is null or (debit_id is not null and debit_id<>failure_id and status in ('failed','canceled')))
);
create table ufit.payment_refund_jobs (
  payment_id uuid primary key references ufit.payment_settlements(payment_id), status text not null,
  generation integer not null, observed_generation integer not null, latest_scan_id uuid,
  attempts integer not null default 0 check(attempts>=0), next_attempt_at timestamptz,
  lease_token uuid, lease_until timestamptz, failure_code text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(latest_scan_id,payment_id,observed_generation) references ufit.payment_refund_scans(id,payment_id,generation),
  check(generation>=1 and observed_generation>=0 and observed_generation<=generation),
  check((latest_scan_id is null)=(observed_generation=0)),
  check(status in ('queued','processing','synced','needs_review')),
  check((status='queued')=(next_attempt_at is not null)),
  check((status='processing')=(lease_token is not null and lease_until is not null) and ((lease_token is null)=(lease_until is null))),
  check(status<>'synced' or (latest_scan_id is not null and observed_generation=generation and failure_code is null)),
  check((failure_code is null or failure_code in ('refund_source_missing','refund_source_changed','refund_settlement_invalid',
    'refund_balance_pending','refund_provider_unavailable','refund_balance_already_linked'))
    and (status<>'needs_review' or failure_code is not null) and (failure_code is null or status in ('queued','needs_review')))
);
create index payment_refund_jobs_due on ufit.payment_refund_jobs(status,next_attempt_at,lease_until,created_at);

create function ufit.guard_refund_settlement_immutable() returns trigger language plpgsql as $$
begin raise exception 'Refund settlement observations are immutable' using errcode='23514'; end $$;
create trigger payment_refund_scans_immutable before update or delete on ufit.payment_refund_scans
  for each row execute function ufit.guard_refund_settlement_immutable();
create trigger payment_refund_balances_immutable before update or delete on ufit.payment_refund_balances
  for each row execute function ufit.guard_refund_settlement_immutable();
create trigger payment_refund_scan_items_immutable before update or delete on ufit.payment_refund_scan_items
  for each row execute function ufit.guard_refund_settlement_immutable();

create function ufit.guard_refund_balance_source() returns trigger language plpgsql as $$
begin
  if not exists(select 1 from ufit.payment_settlements p where p.payment_id=new.payment_id and p.settlement_currency=new.currency) then
    raise exception 'Refund balance currency must match its captured settlement' using errcode='23514';
  end if;
  return new;
end $$;
create trigger payment_refund_balances_source before insert on ufit.payment_refund_balances
  for each row execute function ufit.guard_refund_balance_source();

create function ufit.guard_refund_scan_balanced() returns trigger language plpgsql as $$
declare scan_key uuid; s ufit.payment_refund_scans%rowtype; p ufit.payment_settlements%rowtype; n bigint; active_amount bigint;
begin
  if tg_table_name='payment_refund_scans' then scan_key:=new.id; else scan_key:=new.scan_id; end if;
  select * into strict s from ufit.payment_refund_scans where id=scan_key;
  select * into strict p from ufit.payment_settlements where payment_id=s.payment_id;
  select count(*),coalesce(sum(amount) filter(where status not in ('failed','canceled')),0) into n,active_amount
    from ufit.payment_refund_scan_items where scan_id=scan_key;
  if n<>s.item_count or s.amount_refunded>p.charge_amount or active_amount>p.charge_amount or s.observed_at<p.captured_at
    or exists(select 1 from ufit.payment_refund_scan_items i
      left join ufit.payment_refund_balances d on d.id=i.debit_id left join ufit.payment_refund_balances f on f.id=i.failure_id
      where i.scan_id=scan_key and (i.payment_id<>s.payment_id or i.currency<>p.charge_currency or i.amount>p.charge_amount
        or (d.id is not null and d.kind<>'refund') or (f.id is not null and f.kind<>'refund_failure')))
    or exists(select 1 from (
      select sum(b.amount::bigint) amount,sum(b.fee_amount::bigint) fee,sum(b.net_amount::bigint) net
      from ufit.payment_refund_scan_items i join ufit.payment_refund_balances b on b.id=i.debit_id or b.id=i.failure_id where i.scan_id=scan_key
    ) totals where amount not between -2147483647 and 2147483647 or fee not between -2147483647 and 2147483647 or net not between -2147483647 and 2147483647)
  then raise exception 'Refund scan sources or totals do not match' using errcode='23514'; end if;
  return null;
end $$;
create constraint trigger payment_refund_scans_balanced after insert on ufit.payment_refund_scans
  deferrable initially deferred for each row execute function ufit.guard_refund_scan_balanced();
create constraint trigger payment_refund_scan_items_balanced after insert on ufit.payment_refund_scan_items
  deferrable initially deferred for each row execute function ufit.guard_refund_scan_balanced();

create function ufit.guard_refund_job_current() returns trigger language plpgsql as $$
declare refunded bigint; succeeded bigint;
begin
  if new.status='synced' then
    select amount_refunded into strict refunded from ufit.payment_refund_scans where id=new.latest_scan_id and payment_id=new.payment_id;
    select coalesce(sum(amount) filter(where status='succeeded'),0) into succeeded from ufit.payment_refund_scan_items where scan_id=new.latest_scan_id;
    if refunded<>succeeded or exists(select 1 from ufit.payment_refund_scan_items where scan_id=new.latest_scan_id
      and (status in ('pending','requires_action') or (status='succeeded' and (debit_id is null or failure_id is not null))
        or (status in ('failed','canceled') and ((debit_id is null)<>(failure_id is null))))) then
      raise exception 'An incomplete refund observation cannot be current' using errcode='23514';
    end if;
  end if;
  return new;
end $$;
create trigger payment_refund_jobs_current before insert or update on ufit.payment_refund_jobs
  for each row execute function ufit.guard_refund_job_current();

-- Existing immutable capture receipts receive an initial read request, never an inferred refund.
insert into ufit.payment_refund_jobs(payment_id,status,generation,observed_generation,next_attempt_at)
  select payment_id,'queued',1,0,now() from ufit.payment_settlements;

create table ufit.payment_distribution_policies (
  id uuid primary key,
  brand_id uuid not null references ufit.brand_profiles(id),
  revision integer not null,
  previous_id uuid references ufit.payment_distribution_policies(id),
  request_id uuid not null,
  request_hash text not null,
  platform_rate_bps integer not null,
  fee_bearer text not null,
  active boolean not null,
  reason text not null,
  created_by_user_id uuid references ufit.users(id),
  created_at timestamptz not null default now(),
  superseded_at timestamptz,
  constraint payment_distribution_brand_revision_unique unique(brand_id,revision),
  constraint payment_distribution_request_unique unique(request_id),
  constraint payment_distribution_previous_unique unique(previous_id),
  constraint payment_distribution_rate_valid check(platform_rate_bps between 0 and 10000),
  constraint payment_distribution_bearer_valid check(fee_bearer in ('brand','platform')),
  constraint payment_distribution_parent_valid check(revision>=1 and ((revision=1)=(previous_id is null))),
  constraint payment_distribution_reason_valid check(char_length(btrim(reason)) between 1 and 500),
  constraint payment_distribution_request_hash_valid check(request_hash~'^[a-f0-9]{64}$'),
  constraint payment_distribution_chronology_valid check(superseded_at is null or superseded_at>=created_at)
);
create unique index payment_distribution_current_brand_unique on ufit.payment_distribution_policies(brand_id) where superseded_at is null;
create index payment_distribution_history_idx on ufit.payment_distribution_policies(brand_id,revision desc);

create table ufit.order_distribution_terms (
  order_id uuid primary key references ufit.orders(id),
  policy_id uuid not null references ufit.payment_distribution_policies(id)
);

create function ufit.enforce_payment_distribution_revision() returns trigger language plpgsql as $$
declare previous ufit.payment_distribution_policies;
begin
  if tg_op='DELETE' then
    raise check_violation using message='Distribution revisions cannot be deleted';
  end if;
  if tg_op='UPDATE' then
    if old.superseded_at is not null or new.superseded_at is null
      or (to_jsonb(new)-'superseded_at') is distinct from (to_jsonb(old)-'superseded_at') then
      raise check_violation using message='Distribution conditions are immutable';
    end if;
    return new;
  end if;
  if new.superseded_at is not null then
    raise check_violation using message='A new distribution revision must be current';
  end if;
  if new.previous_id is not null then
    select * into previous from ufit.payment_distribution_policies where id=new.previous_id;
    if previous.id is null or previous.brand_id<>new.brand_id or previous.revision+1<>new.revision
      or previous.superseded_at is distinct from new.created_at then
      raise check_violation using message='Distribution revision must replace its exact predecessor';
    end if;
  end if;
  return new;
end $$;
create trigger payment_distribution_revision_guard before insert or update or delete on ufit.payment_distribution_policies
  for each row execute function ufit.enforce_payment_distribution_revision();

create function ufit.enforce_order_distribution_terms() returns trigger language plpgsql as $$
declare order_brand uuid; order_state text; policy ufit.payment_distribution_policies;
begin
  if tg_op<>'INSERT' then
    raise check_violation using message='Purchased distribution terms are immutable';
  end if;
  select brand_id,status into order_brand,order_state from ufit.orders where id=new.order_id;
  select * into policy from ufit.payment_distribution_policies where id=new.policy_id;
  if order_brand is null or policy.id is null or order_brand<>policy.brand_id
    or order_state<>'pending_payment' or not policy.active or policy.superseded_at is not null then
    raise check_violation using message='Order distribution must match its active brand conditions';
  end if;
  return new;
end $$;
create trigger order_distribution_terms_guard before insert or update or delete on ufit.order_distribution_terms
  for each row execute function ufit.enforce_order_distribution_terms();

-- A reception reserves physical units and their rounding allocation even if
-- Stripe later reports a failed refund. Do not infer its order from refund state.
alter table ufit.order_returns add column allocation_number integer;

do $$
begin
  if exists (
    select 1 from ufit.order_returns where received_at is not null
    group by order_id, received_at having count(*) > 1
  ) then
    raise exception 'Ambiguous historical return reception order';
  end if;
end $$;

with receptions as (
  select id, row_number() over (partition by order_id order by received_at)::integer as allocation_number
  from ufit.order_returns where received_at is not null
)
update ufit.order_returns r set allocation_number = receptions.allocation_number
from receptions where receptions.id = r.id;

alter table ufit.order_returns add constraint order_returns_allocation_valid
  check (((received_at is null and allocation_number is null)
    or (received_at is not null and allocation_number >= 1)) is true);
create unique index order_returns_order_allocation_unique
  on ufit.order_returns(order_id, allocation_number) where allocation_number is not null;

-- A received return can fail financially after a later request was created.
-- Protect the single physical request without blocking that provider correction.
drop index ufit.order_returns_one_open_unique;
create unique index order_returns_one_open_unique on ufit.order_returns(order_id)
  where received_at is null and status not in ('refunded', 'closed', 'withdrawn');

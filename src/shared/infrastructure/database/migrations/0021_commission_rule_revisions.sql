-- Preserve recorded rates. Historical purchases have no invented rule/grade provenance.
do $$ begin
  if exists (select 1 from ufit.commission_rules where brand_id is null
    or base_rate not between 0 and 1 or bonus_rate not between 0 and 1
    or (max_rate is not null and max_rate not between 0 and 1)) then
    raise exception 'Commission rules need an explicit valid brand and rates before migration';
  end if;
  if exists (select 1 from ufit.commission_rules group by brand_id, product_id, creator_grade_code having count(*) > 1) then
    raise exception 'Duplicate commission rule scopes must be resolved explicitly before migration';
  end if;
end $$;

alter table ufit.commission_rules
  add column scope_id uuid,
  add column revision integer,
  add column previous_rule_id uuid references ufit.commission_rules(id),
  add column reason text,
  add column created_by_user_id uuid references ufit.users(id),
  add column superseded_at timestamptz;
update ufit.commission_rules set scope_id = id, revision = 1;
alter table ufit.commission_rules
  alter column scope_id set not null,
  alter column revision set not null,
  alter column brand_id set not null,
  alter column bonus_rate drop default,
  alter column active drop default,
  add constraint commission_rules_brand_id_fkey foreign key (brand_id) references ufit.brand_profiles(id),
  add constraint commission_rules_rate_range check (base_rate between 0 and 1 and bonus_rate between 0 and 1 and (max_rate is null or max_rate between 0 and 1)),
  add constraint commission_rules_revision_positive check (revision >= 1),
  add constraint commission_rules_revision_parent check ((revision = 1) = (previous_rule_id is null));
alter table ufit.commission_rules drop constraint commission_rules_product_id_fkey;
alter table ufit.commission_rules drop constraint commission_rules_creator_grade_code_fkey;
alter table ufit.commission_rules
  add constraint commission_rules_product_id_fkey foreign key (product_id) references ufit.products(id),
  add constraint commission_rules_creator_grade_code_fkey foreign key (creator_grade_code) references ufit.creator_grades(code);

create unique index commission_rules_scope_revision_unique on ufit.commission_rules(scope_id, revision);
create unique index commission_rules_previous_unique on ufit.commission_rules(previous_rule_id);
create index commission_rules_scope_history_idx on ufit.commission_rules(scope_id, created_at desc, id desc);
create unique index commission_rules_current_scope_unique on ufit.commission_rules(scope_id) where superseded_at is null;
create unique index commission_rules_current_brand_unique on ufit.commission_rules(brand_id) where superseded_at is null and product_id is null and creator_grade_code is null;
create unique index commission_rules_current_grade_unique on ufit.commission_rules(brand_id, creator_grade_code) where superseded_at is null and product_id is null and creator_grade_code is not null;
create unique index commission_rules_current_product_unique on ufit.commission_rules(brand_id, product_id) where superseded_at is null and product_id is not null and creator_grade_code is null;
create unique index commission_rules_current_product_grade_unique on ufit.commission_rules(brand_id, product_id, creator_grade_code) where superseded_at is null and product_id is not null and creator_grade_code is not null;

create function ufit.enforce_commission_rule_revision() returns trigger language plpgsql as $$
declare previous ufit.commission_rules; product_brand uuid;
begin
  if tg_op = 'DELETE' then raise exception 'Commission rule history cannot be deleted' using errcode = '23514'; end if;
  if tg_op = 'UPDATE' then
    if old.superseded_at is not null or new.superseded_at is null
      or (to_jsonb(new) - 'superseded_at') is distinct from (to_jsonb(old) - 'superseded_at') then
      raise exception 'Commission rule revisions are immutable' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.product_id is not null then
    select brand_id into product_brand from ufit.products where id = new.product_id for key share;
    if product_brand is distinct from new.brand_id then
      raise exception 'Commission article must belong to the rule brand' using errcode = '23514';
    end if;
  end if;
  if new.previous_rule_id is not null then
    select * into previous from ufit.commission_rules where id = new.previous_rule_id;
    if not found or previous.scope_id <> new.scope_id or previous.revision + 1 <> new.revision
      or previous.superseded_at is null or previous.brand_id <> new.brand_id
      or previous.product_id is distinct from new.product_id or previous.creator_grade_code is distinct from new.creator_grade_code then
      raise exception 'Commission revision must extend its own scope' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger commission_rule_revision_guard before insert or update or delete on ufit.commission_rules
  for each row execute function ufit.enforce_commission_rule_revision();

alter table ufit.order_items
  add column commission_rule_id uuid references ufit.commission_rules(id),
  add column commission_creator_grade_code text references ufit.creator_grades(code),
  add constraint order_items_commission_provenance_pair check ((commission_rule_id is null) = (commission_creator_grade_code is null));
-- NOT VALID deliberately preserves unknown historical provenance; all new writes are checked.
alter table ufit.order_items add constraint order_items_attributed_commission_required
  check (source_creator_id is null or commission_rule_id is not null) not valid;

create function ufit.enforce_order_commission_snapshot() returns trigger language plpgsql as $$
declare rule ufit.commission_rules; order_brand uuid; effective_rate numeric;
begin
  if tg_op = 'UPDATE' and old.commission_rule_id is not null and
    row(new.commission_rule_id, new.commission_creator_grade_code, new.commission_rate, new.product_id, new.order_id, new.source_creator_id, new.source_outfit_id)
      is distinct from row(old.commission_rule_id, old.commission_creator_grade_code, old.commission_rate, old.product_id, old.order_id, old.source_creator_id, old.source_outfit_id) then
    raise exception 'Purchased commission snapshot is immutable' using errcode = '23514';
  end if;
  if new.commission_rule_id is null then return new; end if;
  select * into rule from ufit.commission_rules where id = new.commission_rule_id;
  select brand_id into order_brand from ufit.orders where id = new.order_id;
  effective_rate := least(rule.base_rate + rule.bonus_rate, coalesce(rule.max_rate, 1));
  if rule.id is null or rule.brand_id is distinct from order_brand
    or (rule.product_id is not null and rule.product_id <> new.product_id)
    or (rule.creator_grade_code is not null and rule.creator_grade_code is distinct from new.commission_creator_grade_code)
    or effective_rate is distinct from new.commission_rate then
    raise exception 'Purchased commission must match its recorded rule' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger order_commission_snapshot_guard before insert or update on ufit.order_items
  for each row execute function ufit.enforce_order_commission_snapshot();

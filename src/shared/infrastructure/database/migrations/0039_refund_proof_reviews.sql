do $$ begin
  if exists(select 1 from ufit.refund_payment_proofs where state='pending') then
    raise exception 'Resolve pending refund proof uploads before migration 0039';
  end if;
end $$;
alter table ufit.refund_organization_cases add column current_proof_id uuid;
alter table ufit.refund_organization_cases add constraint refund_organization_case_order_identity unique(id,order_id);
alter table ufit.refund_payment_proofs add column sequence integer;
alter table ufit.refund_payment_proofs add column replaces_proof_id uuid;
with ranked as (
  select id,row_number() over(partition by case_id order by submitted_at nulls last,id)::integer as sequence
  from ufit.refund_payment_proofs
)
update ufit.refund_payment_proofs p set sequence=r.sequence from ranked r where r.id=p.id;
alter table ufit.refund_payment_proofs alter column sequence set not null;
drop index ufit.refund_proof_submitted_unique;
alter table ufit.refund_payment_proofs add constraint refund_proof_sequence_unique unique(case_id,sequence);
alter table ufit.refund_payment_proofs add constraint refund_proof_case_identity unique(case_id,id);
alter table ufit.refund_payment_proofs add constraint refund_proof_review_identity unique(case_id,id,organization_version);
alter table ufit.refund_payment_proofs add constraint refund_proof_money_identity unique(id,case_id,amount,currency,transferred_on);
alter table ufit.refund_payment_proofs add constraint refund_proof_replaces_same_case_fk foreign key(case_id,replaces_proof_id) references ufit.refund_payment_proofs(case_id,id);
alter table ufit.refund_payment_proofs add constraint refund_proof_sequence_positive check(sequence>=1);
update ufit.refund_payment_proofs set request_fingerprint=encode(extensions.digest(convert_to(array_to_json(array[
  request_id::text,organization_version::text,replaces_proof_id::text,transfer_reference,transferred_on::text,content_type,byte_size::text,sha256
])::text,'UTF8'),'sha256'),'hex');
update ufit.refund_organization_cases c set current_proof_id=p.id
from ufit.refund_payment_proofs p where p.case_id=c.id and p.state='submitted';
alter table ufit.refund_organization_cases add constraint refund_organization_current_proof_fk
  foreign key(id,current_proof_id) references ufit.refund_payment_proofs(case_id,id);

create table ufit.refund_proof_reviews (
  id uuid primary key,case_id uuid not null,proof_id uuid not null,organization_version integer not null,
  request_id uuid not null,request_fingerprint text not null,reviewed_by uuid references ufit.users(id),
  decision text not null,reason text not null,verification_reference text,reviewed_at timestamptz not null,
  constraint refund_review_proof_revision_fk foreign key(case_id,proof_id,organization_version) references ufit.refund_payment_proofs(case_id,id,organization_version),
  constraint refund_review_proof_unique unique(proof_id),
  constraint refund_review_request_unique unique(case_id,request_id),
  constraint refund_review_settlement_identity unique(case_id,proof_id,id,decision),
  constraint refund_review_fingerprint_valid check(request_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint refund_review_reason_valid check(char_length(btrim(reason)) between 1 and 2000),
  constraint refund_review_decision_valid check(((decision='reject' and verification_reference is null) or (decision='confirm' and char_length(btrim(verification_reference)) between 1 and 160)) is true)
);
create table ufit.external_refund_settlements (
  id uuid primary key,case_id uuid not null,order_id uuid not null,proof_id uuid not null,review_id uuid not null,review_decision text not null,
  amount integer not null,currency text not null,settled_on date not null,confirmed_at timestamptz not null,
  constraint external_refund_case_unique unique(case_id),
  constraint external_refund_proof_unique unique(proof_id),
  constraint external_refund_review_unique unique(review_id),
  constraint external_refund_case_order_fk foreign key(case_id,order_id) references ufit.refund_organization_cases(id,order_id),
  constraint external_refund_confirmed_review_fk foreign key(case_id,proof_id,review_id,review_decision) references ufit.refund_proof_reviews(case_id,proof_id,id,decision),
  constraint external_refund_proof_money_fk foreign key(proof_id,case_id,amount,currency,settled_on) references ufit.refund_payment_proofs(id,case_id,amount,currency,transferred_on),
  constraint external_refund_confirm_required check(review_decision='confirm'),
  constraint external_refund_amount_valid check(amount>=1 and currency ~ '^[A-Z]{3}$')
);
alter table ufit.order_cancellations drop constraint order_cancellations_payment_outcome_check;
alter table ufit.order_cancellations add constraint order_cancellations_payment_outcome_check
  check(payment_outcome in ('not_charged','refunded','refunded_externally','refund_failed','refund_canceled','refund_blocked'));

create view ufit.return_refund_financial_facts as
with stripe as (
  select return_id,coalesce(sum(amount) filter(where state='succeeded'),0)::bigint stripe_amount,
    count(*) filter(where state='succeeded')::integer stripe_count
  from ufit.order_return_refunds group by return_id
), facts as (
  select r.id return_id,r.order_id,r.status,r.total_amount,
    coalesce(s.stripe_amount,0)::bigint stripe_amount,
    (coalesce(s.stripe_amount,0)+coalesce(e.amount,0))::bigint amount,
    (coalesce(s.stripe_count,0)+case when e.id is null then 0 else 1 end)::integer confirmation_count,
    e.id external_settlement_id,(e.currency is not null and e.currency<>o.currency) invalid_currency
  from ufit.order_returns r join ufit.orders o on o.id=r.order_id
  left join stripe s on s.return_id=r.id
  left join ufit.refund_organization_cases c on c.return_id=r.id
  left join ufit.external_refund_settlements e on e.case_id=c.id
)
select return_id,order_id,stripe_amount,amount,confirmation_count,external_settlement_id,
  (invalid_currency or case when status='refunded' then confirmation_count<>1 or amount<>total_amount else confirmation_count<>0 end) invalid
from facts;

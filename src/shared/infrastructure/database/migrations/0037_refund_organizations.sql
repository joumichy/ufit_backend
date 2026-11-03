create table ufit.refund_organization_cases (
  id uuid primary key,
  order_id uuid not null references ufit.orders(id),
  return_id uuid,
  cancellation_id uuid,
  version integer not null,
  constraint refund_organization_return_unique unique(return_id),
  constraint refund_organization_cancellation_unique unique(cancellation_id),
  constraint refund_organization_origin_required check((return_id is null) <> (cancellation_id is null)),
  constraint refund_organization_version_positive check(version >= 1),
  constraint refund_organization_return_order_fk foreign key(return_id,order_id) references ufit.order_returns(id,order_id)
);
create unique index order_cancellations_id_order_unique on ufit.order_cancellations(id,order_id);
alter table ufit.refund_organization_cases add constraint refund_organization_cancellation_order_fk
  foreign key(cancellation_id,order_id) references ufit.order_cancellations(id,order_id);
create table ufit.refund_organization_revisions (
  id uuid primary key,
  case_id uuid not null references ufit.refund_organization_cases(id),
  version integer not null,
  previous_revision_id uuid,
  request_id uuid not null,
  request_fingerprint text not null,
  action text not null,
  changed_by uuid references ufit.users(id),
  status text not null,
  method_label text not null,
  instructions text not null,
  customer_details text,
  recorded_at timestamptz not null,
  constraint refund_organization_revision_version_unique unique(case_id,version),
  constraint refund_organization_revision_request_unique unique(case_id,request_id),
  constraint refund_organization_revision_identity unique(case_id,id),
  constraint refund_organization_revision_previous_unique unique(previous_revision_id),
  constraint refund_organization_revision_parent_fk foreign key(case_id,previous_revision_id) references ufit.refund_organization_revisions(case_id,id),
  constraint refund_organization_revision_version_valid check(version >= 1 and ((version = 1) = (previous_revision_id is null))),
  constraint refund_organization_revision_fingerprint_valid check(request_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint refund_organization_revision_action_valid check(action in ('arrange','provide_details')),
  constraint refund_organization_revision_fields_valid check(char_length(btrim(method_label)) between 1 and 120 and char_length(btrim(instructions)) between 1 and 4000),
  constraint refund_organization_revision_state_valid check(((status = 'awaiting_customer' and customer_details is null and action = 'arrange') or (status = 'ready' and char_length(btrim(customer_details)) between 1 and 2000 and action = 'provide_details')) is true)
);
alter table ufit.refund_organization_cases add constraint refund_organization_current_revision_fk
  foreign key(id,version) references ufit.refund_organization_revisions(case_id,version) deferrable initially deferred;

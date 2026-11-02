-- New notification intents only; no historical emails are invented or backfilled.
create table ufit.notifications (
  id uuid primary key default gen_random_uuid(),
  event_key text not null constraint notification_key_valid check(event_key=btrim(event_key) and length(event_key) between 1 and 256),
  recipient_user_id uuid not null references ufit.users(id),
  resource_type text not null constraint notification_resource_valid check(resource_type in ('creator_application','brand_application','order','shipment','order_return')),
  resource_id uuid not null,
  audience text not null constraint notification_audience_valid check(audience in ('applicant','customer','brand')),
  brand_id uuid references ufit.brand_profiles(id),
  subject text not null,body_text text not null,
  created_at timestamptz not null default now(),
  constraint notification_event_recipient_unique unique(event_key,recipient_user_id),
  constraint notification_content_valid check(length(subject)>0 and length(body_text)>0),
  constraint notification_context_valid check(
    (resource_type in ('creator_application','brand_application') and audience='applicant' and brand_id is null) or
    (resource_type not in ('creator_application','brand_application') and
      ((audience='customer' and brand_id is null) or (audience='brand' and brand_id is not null))))
);
create index notification_recipient_idx on ufit.notifications(recipient_user_id,created_at,id);
create index notification_resource_idx on ufit.notifications(resource_type,resource_id);
create function ufit.protect_notification_intent() returns trigger language plpgsql as $$
begin raise exception 'Notification intent is immutable' using errcode='23514'; end $$;
create trigger notification_intent_guard before update on ufit.notifications for each row execute function ufit.protect_notification_intent();

create table ufit.notification_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references ufit.notifications(id) on delete cascade,
  recipient_address text not null constraint notification_email_recipient_valid check (recipient_address=btrim(recipient_address) and length(recipient_address)>0),
  subject text not null, body_text text not null,
  constraint notification_email_content_valid check (length(subject)>0 and length(body_text)>0),
  sender_name text, sender_address text,
  status text not null default 'pending' constraint notification_email_status_valid check (status in ('pending','processing','retry','accepted','rejected','uncertain','cancelled')),
  attempts integer not null default 0 constraint notification_email_attempts_valid check (attempts>=0),
  first_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid, lease_until timestamptz,
  provider_message_id uuid, accepted_at timestamptz,
  last_failure text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint notification_email_notification_unique unique(notification_id),
  constraint notification_email_anchor_valid check (
    (first_attempt_at is null and sender_name is null and sender_address is null and attempts=0) or
    (first_attempt_at is not null and sender_name is not null and sender_address is not null and attempts>0)),
  constraint notification_email_lease_valid check (
    (status='processing' and lease_token is not null and lease_until is not null) or
    (status<>'processing' and lease_token is null and lease_until is null)),
  constraint notification_email_acceptance_valid check (
    (status='accepted' and provider_message_id is not null and accepted_at is not null and last_failure is null) or
    (status<>'accepted' and provider_message_id is null and accepted_at is null)),
  constraint notification_email_attempt_state_valid check (
    (status='pending' and attempts=0) or status='cancelled' or (status<>'pending' and first_attempt_at is not null))
);
create unique index notification_email_provider_message_unique on ufit.notification_email_deliveries(provider_message_id);
create index notification_email_due_idx on ufit.notification_email_deliveries(next_attempt_at,id);

create function ufit.protect_notification_email_envelope() returns trigger language plpgsql as $$
begin
  if row(new.id,new.notification_id,new.recipient_address,new.subject,new.body_text,new.created_at)
    is distinct from row(old.id,old.notification_id,old.recipient_address,old.subject,old.body_text,old.created_at) then
    raise exception 'Notification intent is immutable' using errcode='23514';
  end if;
  if old.first_attempt_at is not null and row(new.first_attempt_at,new.sender_name,new.sender_address)
    is distinct from row(old.first_attempt_at,old.sender_name,old.sender_address) then
    raise exception 'Notification retry must retain its first envelope' using errcode='23514';
  end if;
  if old.status='accepted' and row(new.status,new.provider_message_id,new.accepted_at) is distinct from row(old.status,old.provider_message_id,old.accepted_at) then
    raise exception 'An accepted notification cannot be sent again' using errcode='23514';
  end if;
  return new;
end $$;
create trigger notification_email_envelope_guard before update on ufit.notification_email_deliveries
  for each row execute function ufit.protect_notification_email_envelope();

-- Existing attempted deliveries used the sole Resend transport. Freeze that provider.
alter table ufit.notification_email_deliveries
  alter column provider_message_id type text using provider_message_id::text,
  add column provider text;

update ufit.notification_email_deliveries
set provider = 'resend'
where first_attempt_at is not null;

alter table ufit.notification_email_deliveries
  drop constraint notification_email_anchor_valid,
  add constraint notification_email_provider_valid check (provider is null or provider in ('resend', 'mailpit')),
  add constraint notification_email_provider_receipt_valid check (
    provider_message_id is null or (provider_message_id !~ '\s' and length(provider_message_id) between 1 and 256)
  ),
  add constraint notification_email_anchor_valid check (
    (first_attempt_at is null and sender_name is null and sender_address is null and provider is null and attempts = 0)
    or (first_attempt_at is not null and sender_name is not null and sender_address is not null and provider is not null and attempts > 0)
  );

drop index ufit.notification_email_provider_message_unique;
create unique index notification_email_provider_message_unique
  on ufit.notification_email_deliveries(provider, provider_message_id);

create or replace function ufit.protect_notification_email_envelope() returns trigger language plpgsql as $$
begin
  if row(new.id,new.notification_id,new.recipient_address,new.subject,new.body_text,new.created_at)
    is distinct from row(old.id,old.notification_id,old.recipient_address,old.subject,old.body_text,old.created_at) then
    raise exception 'Notification intent is immutable' using errcode='23514';
  end if;
  if old.first_attempt_at is not null and row(new.first_attempt_at,new.sender_name,new.sender_address,new.provider)
    is distinct from row(old.first_attempt_at,old.sender_name,old.sender_address,old.provider) then
    raise exception 'Notification retry must retain its first envelope and provider' using errcode='23514';
  end if;
  if old.status='accepted' and row(new.status,new.provider_message_id,new.accepted_at) is distinct from row(old.status,old.provider_message_id,old.accepted_at) then
    raise exception 'An accepted notification cannot be sent again' using errcode='23514';
  end if;
  return new;
end $$;

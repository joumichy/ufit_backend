create table ufit.notification_installations (
  id uuid primary key,
  credential_hash text not null constraint notification_installation_credential_valid check(credential_hash~'^[0-9a-f]{64}$'),
  version integer not null constraint notification_installation_version_positive check(version>=1),
  state text not null constraint notification_installation_state_valid check(state in ('registered','detached','invalidated')),
  current_association_id uuid,
  registration_id uuid,
  device_token text constraint notification_installation_token_valid check(device_token is null or device_token~'^([0-9a-f]{2})+$'),
  environment text constraint notification_installation_environment_valid check(environment is null or environment in ('development','production')),
  registered_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint notification_installation_shape_valid check(
    (state='detached' and current_association_id is null and registration_id is null and device_token is null and environment is null and registered_at is null and invalidated_at is null)
    or (state in ('registered','invalidated') and current_association_id is not null and registration_id is not null and device_token is not null and environment is not null and registered_at is not null and (state<>'registered' or invalidated_at is null))
  ),
  constraint notification_installation_chronology check(updated_at>=created_at and (registered_at is null or registered_at>=created_at))
);
create table ufit.notification_device_associations (
  id uuid primary key,
  installation_id uuid not null references ufit.notification_installations(id),
  user_id uuid not null references ufit.users(id),
  opened_at timestamptz not null,
  closed_at timestamptz,
  constraint notification_association_chronology check(closed_at is null or closed_at>=opened_at)
);
create unique index notification_association_installation_identity on ufit.notification_device_associations(id,installation_id);
create unique index notification_association_active_installation_unique on ufit.notification_device_associations(installation_id) where closed_at is null;
create index notification_association_recipient_idx on ufit.notification_device_associations(user_id,installation_id) where closed_at is null;
create table ufit.notification_installation_registrations (
  id uuid primary key,
  association_id uuid not null,
  installation_id uuid not null,
  request_hash text not null constraint notification_registration_request_valid check(request_hash~'^[0-9a-f]{64}$'),
  constraint notification_registration_association_fk foreign key(association_id,installation_id) references ufit.notification_device_associations(id,installation_id)
);
create unique index notification_registration_identity on ufit.notification_installation_registrations(id,association_id,installation_id);
alter table ufit.notification_installations add constraint notification_installation_association_fk foreign key(current_association_id,id) references ufit.notification_device_associations(id,installation_id);
alter table ufit.notification_installations add constraint notification_installation_registration_fk foreign key(registration_id,current_association_id,id) references ufit.notification_installation_registrations(id,association_id,installation_id);
create unique index notification_installation_active_token_unique on ufit.notification_installations(environment,device_token) where state='registered';


create function ufit.protect_notification_installation_identity() returns trigger language plpgsql as $$
begin
  if TG_OP='DELETE' then raise exception 'Installation identity cannot be removed' using errcode='23514',constraint='notification_installation_identity'; end if;
  if (new.id,new.credential_hash,new.created_at) is distinct from (old.id,old.credential_hash,old.created_at) then
    raise exception 'Installation identity is immutable' using errcode='23514',constraint='notification_installation_identity';
  end if;
  return new;
end $$;
create trigger notification_installation_identity before update or delete on ufit.notification_installations for each row execute function ufit.protect_notification_installation_identity();

create function ufit.protect_notification_registration_identity() returns trigger language plpgsql as $$
begin
  raise exception 'Registration operation is immutable' using errcode='23514',constraint='notification_registration_identity';
end $$;
create trigger notification_registration_identity before update or delete on ufit.notification_installation_registrations for each row execute function ufit.protect_notification_registration_identity();

create function ufit.protect_notification_association() returns trigger language plpgsql as $$
begin
  if TG_OP='DELETE' then
    raise exception 'Consumed device association cannot be removed' using errcode='23514',constraint='notification_association_identity';
  end if;
  if (new.id,new.installation_id,new.user_id,new.opened_at) is distinct from (old.id,old.installation_id,old.user_id,old.opened_at)
    or (old.closed_at is not null and new.closed_at is distinct from old.closed_at) then
    raise exception 'Device association identity or closure is immutable' using errcode='23514',constraint='notification_association_identity';
  end if;
  return new;
end $$;
create trigger notification_association_identity before update or delete on ufit.notification_device_associations for each row execute function ufit.protect_notification_association();

create function ufit.check_notification_installation_relation() returns trigger language plpgsql as $$
declare target uuid;
begin
  if TG_TABLE_NAME='notification_installations' then target:=new.id; else target:=new.installation_id; end if;
  if exists(
    select 1 from ufit.notification_installations i left join ufit.notification_device_associations a on a.id=i.current_association_id and a.installation_id=i.id
    where i.id=target and (
      (i.current_association_id is not null and (a.id is null or a.closed_at is not null))
      or exists(select 1 from ufit.notification_device_associations other where other.installation_id=i.id and other.closed_at is null and other.id is distinct from i.current_association_id)
    )
  ) then raise exception 'Current device association must be open and unique' using errcode='23514',constraint='notification_installation_relation'; end if;
  return new;
end $$;
create constraint trigger notification_installation_relation after insert or update on ufit.notification_installations deferrable initially deferred for each row execute function ufit.check_notification_installation_relation();
create constraint trigger notification_association_relation after insert or update on ufit.notification_device_associations deferrable initially deferred for each row execute function ufit.check_notification_installation_relation();

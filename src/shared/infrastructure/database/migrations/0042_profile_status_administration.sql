-- An epoch for the current state; it does not manufacture past moderation decisions.
alter table ufit.creator_profiles add column status_version integer not null default 1,
  add constraint creator_profiles_status_version_valid check(status_version >= 1);
alter table ufit.brand_profiles add column status_version integer not null default 1,
  add constraint brand_profiles_status_version_valid check(status_version >= 1);

create function ufit.advance_profile_status_version() returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status and new.status_version = old.status_version then
    new.status_version := old.status_version + 1;
  end if;
  if new.status_version <> old.status_version and new.status_version <> old.status_version + 1 then
    raise exception 'Profile status requires its next concurrency version' using errcode = '23514';
  end if;
  if new.status is distinct from old.status and new.status_version <> old.status_version + 1 then
    raise exception 'A profile status change must advance its version' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger creator_profile_status_version_guard before update of status, status_version on ufit.creator_profiles
  for each row execute function ufit.advance_profile_status_version();
create trigger brand_profile_status_version_guard before update of status, status_version on ufit.brand_profiles
  for each row execute function ufit.advance_profile_status_version();

create table ufit.profile_status_changes (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid references ufit.creator_profiles(id),
  brand_id uuid references ufit.brand_profiles(id),
  version integer not null check(version > 1),
  from_status ufit.profile_status not null,
  to_status ufit.profile_status not null,
  decided_by_user_id uuid not null references ufit.users(id),
  reason text not null check(reason = btrim(reason) and length(reason) between 1 and 500),
  created_at timestamptz not null default now(),
  constraint profile_status_change_profile_required check((creator_id is not null) <> (brand_id is not null)),
  constraint profile_status_change_changed check(from_status <> to_status)
);
create unique index profile_status_creator_version_unique on ufit.profile_status_changes(creator_id, version);
create unique index profile_status_brand_version_unique on ufit.profile_status_changes(brand_id, version);
create index profile_status_creator_history_idx on ufit.profile_status_changes(creator_id, version desc);
create index profile_status_brand_history_idx on ufit.profile_status_changes(brand_id, version desc);

create function ufit.enforce_profile_status_change() returns trigger language plpgsql as $$
declare current_version integer; current_status ufit.profile_status;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Profile decisions are immutable' using errcode = '23514';
  end if;
  if new.creator_id is not null then
    select status_version, status into current_version, current_status from ufit.creator_profiles where id = new.creator_id;
  else
    select status_version, status into current_version, current_status from ufit.brand_profiles where id = new.brand_id;
  end if;
  if current_version is null or new.version <> current_version or new.to_status <> current_status then
    raise exception 'A profile decision must match the applied status' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger profile_status_change_guard before insert or update or delete on ufit.profile_status_changes
  for each row execute function ufit.enforce_profile_status_change();

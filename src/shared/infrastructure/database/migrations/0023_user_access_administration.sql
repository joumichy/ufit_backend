-- Version one is the current concurrency epoch, not an invented past access decision.
alter table ufit.users add column access_version integer not null default 1,
  add constraint users_access_version_valid check (access_version >= 1);

create table ufit.user_access_changes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references ufit.users(id),
  version integer not null check (version >= 2),
  kind text not null check (kind in ('status', 'admin_access')),
  from_status ufit.user_status not null,
  to_status ufit.user_status not null,
  admin_before boolean not null,
  admin_after boolean not null,
  decided_by_user_id uuid not null references ufit.users(id),
  reason text not null check (reason = btrim(reason) and length(reason) between 1 and 500),
  created_at timestamptz not null default now(),
  constraint user_access_changes_version_unique unique (user_id, version),
  constraint user_access_changes_shape check
    ((kind = 'status' and from_status <> to_status and admin_before = admin_after) or
     (kind = 'admin_access' and from_status = to_status and admin_before <> admin_after))
);
create index user_access_changes_history_idx on ufit.user_access_changes(user_id, version desc);

create function ufit.advance_user_access_version() returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status and new.access_version = old.access_version then
    new.access_version := old.access_version + 1;
  end if;
  if new.access_version <> old.access_version and new.access_version <> old.access_version + 1 then
    raise exception 'User access requires its next concurrency version' using errcode = '23514';
  end if;
  if new.status is distinct from old.status and new.access_version <> old.access_version + 1 then
    raise exception 'A user status change must advance its access version' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger user_access_version_guard before update of status, access_version on ufit.users
  for each row execute function ufit.advance_user_access_version();

-- Privileged membership changes share the same counter, including supported bootstrap paths.
create function ufit.advance_privileged_user_access_version() returns trigger language plpgsql as $$
declare previous_user uuid; next_user uuid; subject_id uuid;
begin
  if tg_op = 'UPDATE' and row(old.user_id, old.role) is not distinct from row(new.user_id, new.role) then
    return null;
  end if;
  if tg_op <> 'INSERT' and old.role in ('admin', 'super_admin') then previous_user := old.user_id; end if;
  if tg_op <> 'DELETE' and new.role in ('admin', 'super_admin') then next_user := new.user_id; end if;
  for subject_id in select distinct value from unnest(array[previous_user, next_user]) as related(value)
    where value is not null order by value loop
    update ufit.users set access_version = access_version + 1, updated_at = clock_timestamp() where id = subject_id;
  end loop;
  return null;
end $$;
create trigger privileged_user_access_version after insert or delete or update of role, user_id on ufit.user_roles
  for each row execute function ufit.advance_privileged_user_access_version();

create function ufit.enforce_user_access_change() returns trigger language plpgsql as $$
declare subject ufit.users; has_admin boolean;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Access decisions are immutable' using errcode = '23514';
  end if;
  select * into subject from ufit.users where id = new.user_id;
  select exists(select 1 from ufit.user_roles where user_id = new.user_id and role = 'admin') into has_admin;
  if subject.id is null or new.version <> subject.access_version or new.to_status <> subject.status or new.admin_after <> has_admin then
    raise exception 'An access decision must match the applied account state' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger user_access_change_guard before insert or update or delete on ufit.user_access_changes
  for each row execute function ufit.enforce_user_access_change();

-- Keep the historical global rate as recorded data; new grades have no global rate.
do $$ begin
  if not exists (select 1 from ufit.creator_grades where code = 'seed') then
    raise exception 'The configured initial creator grade is missing';
  end if;
  if exists (select 1 from ufit.creator_grades where code !~ '^[a-z][a-z0-9-]*$'
    or length(code) > 80 or label <> btrim(label) or length(label) not between 1 and 120 or rank < 0) then
    raise exception 'Existing grade metadata must be resolved before migration';
  end if;
end $$;

alter table ufit.creator_grades
  alter column commission_bps drop not null,
  add column assignable boolean not null default true,
  add column version integer not null default 1,
  add column updated_at timestamptz,
  add constraint creator_grades_code_valid check (code ~ '^[a-z][a-z0-9-]*$' and length(code) <= 80),
  add constraint creator_grades_label_valid check (label = btrim(label) and length(label) between 1 and 120),
  add constraint creator_grades_rank_valid check (rank >= 0),
  add constraint creator_grades_version_valid check (version >= 1),
  add constraint creator_grades_initial_assignable check (code <> 'seed' or assignable);

create table ufit.creator_grade_revisions (
  id uuid primary key default gen_random_uuid(),
  code text not null references ufit.creator_grades(code),
  version integer not null check (version >= 1),
  previous_revision_id uuid,
  label text not null check (label = btrim(label) and length(label) between 1 and 120),
  rank integer not null check (rank >= 0),
  assignable boolean not null,
  changed_by_user_id uuid references ufit.users(id),
  reason text,
  recorded_at timestamptz not null default now(),
  constraint creator_grade_revisions_version_unique unique (code, version),
  constraint creator_grade_revisions_code_id_unique unique (code, id),
  constraint creator_grade_revisions_parent_scope foreign key (code, previous_revision_id)
    references ufit.creator_grade_revisions(code, id),
  constraint creator_grade_revisions_parent_required check ((version = 1) = (previous_revision_id is null)),
  constraint creator_grade_revisions_reason_valid check
    ((changed_by_user_id is null) = (reason is null) and
     (reason is null or (reason = btrim(reason) and length(reason) between 1 and 500)) and
     (version = 1 or changed_by_user_id is not null))
);
create unique index creator_grade_revisions_previous_unique on ufit.creator_grade_revisions(previous_revision_id);
create index creator_grade_revisions_history_idx on ufit.creator_grade_revisions(code, version desc);

-- This is an observed baseline, with no invented past editor or modification time.
insert into ufit.creator_grade_revisions(code, version, label, rank, assignable)
  select code, version, label, rank, assignable from ufit.creator_grades;
alter table ufit.creator_grades add constraint creator_grades_current_revision
  foreign key (code, version) references ufit.creator_grade_revisions(code, version)
  deferrable initially deferred;

alter table ufit.creator_profiles add column grade_version integer not null default 1,
  add constraint creator_profiles_grade_version_valid check (grade_version >= 1);
alter table ufit.creator_grade_history
  add column version integer,
  add column source text,
  add column from_grade_label text,
  add column to_grade_label text,
  add constraint creator_grade_history_from_grade foreign key (from_grade_code) references ufit.creator_grades(code),
  add constraint creator_grade_history_source_valid check
    ((source is null and version is null and from_grade_label is null and to_grade_label is null) or
     (source is not null and version is not null and source in ('application', 'administration') and version >= 1 and to_grade_label is not null and
      length(btrim(to_grade_label)) > 0 and reason is not null and length(btrim(reason)) between 1 and 500 and
      ((source = 'application' and version = 1 and from_grade_code is null and from_grade_label is null) or
       (source = 'administration' and version >= 2 and from_grade_code is not null and from_grade_label is not null and
        length(btrim(from_grade_label)) > 0 and changed_by_user_id is not null)))) ;
create unique index creator_grade_history_version_unique on ufit.creator_grade_history(creator_profile_id, version)
  where version is not null;

create function ufit.enforce_creator_grade_revision() returns trigger language plpgsql as $$
declare previous ufit.creator_grade_revisions;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Creator grade revisions are immutable' using errcode = '23514';
  end if;
  if new.previous_revision_id is not null then
    select * into previous from ufit.creator_grade_revisions where id = new.previous_revision_id;
    if not found or previous.code <> new.code or previous.version + 1 <> new.version then
      raise exception 'Creator grade revisions must extend their own sequence' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger creator_grade_revision_guard before insert or update or delete on ufit.creator_grade_revisions
  for each row execute function ufit.enforce_creator_grade_revision();

create function ufit.enforce_creator_grade_definition() returns trigger language plpgsql as $$
begin
  if new.code <> old.code or new.created_at <> old.created_at
    or new.commission_bps is distinct from old.commission_bps
    or new.criteria is distinct from old.criteria
    or new.version <> old.version + 1 or new.updated_at is null then
    raise exception 'Grade metadata requires a new immutable revision' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger creator_grade_definition_guard before update on ufit.creator_grades
  for each row execute function ufit.enforce_creator_grade_definition();

create function ufit.verify_creator_grade_definition() returns trigger language plpgsql as $$
declare revision ufit.creator_grade_revisions;
begin
  select * into revision from ufit.creator_grade_revisions where code = new.code and version = new.version;
  if not found or row(revision.label, revision.rank, revision.assignable) is distinct from row(new.label, new.rank, new.assignable) then
    raise exception 'Grade metadata must match its immutable revision' using errcode = '23514';
  end if;
  return new;
end $$;
create constraint trigger creator_grade_definition_revision_match after insert or update on ufit.creator_grades
  deferrable initially deferred for each row execute function ufit.verify_creator_grade_definition();

create function ufit.verify_creator_grade_revision_applied() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from ufit.creator_grades where code = new.code and version >= new.version) then
    raise exception 'A grade revision must belong to an applied definition' using errcode = '23514';
  end if;
  return new;
end $$;
create constraint trigger creator_grade_revision_applied after insert on ufit.creator_grade_revisions
  deferrable initially deferred for each row execute function ufit.verify_creator_grade_revision_applied();

create function ufit.enforce_creator_grade_change() returns trigger language plpgsql as $$
begin
  if row(new.grade_code, new.grade_version) is distinct from row(old.grade_code, old.grade_version) then
    if new.grade_code = old.grade_code or new.grade_version <> old.grade_version + 1 then
      raise exception 'A creator grade change requires the next version' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger creator_grade_change_guard before update of grade_code, grade_version on ufit.creator_profiles
  for each row execute function ufit.enforce_creator_grade_change();

create function ufit.verify_creator_grade_change_history() returns trigger language plpgsql as $$
begin
  if row(new.grade_code, new.grade_version) is distinct from row(old.grade_code, old.grade_version) and
    not exists (select 1 from ufit.creator_grade_history where creator_profile_id = new.id and version = new.grade_version
      and source = 'administration' and from_grade_code = old.grade_code and to_grade_code = new.grade_code) then
    raise exception 'A creator grade change requires its recorded history' using errcode = '23514';
  end if;
  return new;
end $$;
create constraint trigger creator_grade_change_history_required after update on ufit.creator_profiles
  deferrable initially deferred for each row execute function ufit.verify_creator_grade_change_history();

create function ufit.enforce_creator_grade_history() returns trigger language plpgsql as $$
declare profile ufit.creator_profiles;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Creator grade history is immutable' using errcode = '23514';
  end if;
  if new.version is null or new.source is null then
    raise exception 'New grade history requires its canonical version and source' using errcode = '23514';
  end if;
  if new.version is not null then
    select * into profile from ufit.creator_profiles where id = new.creator_profile_id;
    if not found or new.version <> profile.grade_version or new.to_grade_code <> profile.grade_code then
      raise exception 'A grade history entry must match an applied assignment' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger creator_grade_history_guard before insert or update or delete on ufit.creator_grade_history
  for each row execute function ufit.enforce_creator_grade_history();

-- Existing accounts retain the explicit transactional-channel defaults; no historical delivery is replayed.
create table ufit.notification_preferences (
  user_id uuid primary key references ufit.users(id) on delete cascade,
  version integer not null constraint notification_preferences_version_positive check(version>=1),
  email_enabled boolean not null default true,
  push_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

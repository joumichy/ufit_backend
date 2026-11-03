create table ufit.payment_settlement_jobs (
  payment_id uuid primary key references ufit.payments(id),
  status text not null,
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_settlement_jobs_status check (status in ('queued','processing','recorded','needs_review')),
  constraint payment_settlement_jobs_attempts check (attempts >= 0),
  constraint payment_settlement_jobs_next check ((status='queued')=(next_attempt_at is not null)),
  constraint payment_settlement_jobs_lease check (
    (status='processing')=(lease_token is not null and lease_until is not null)
    and ((lease_token is null)=(lease_until is null))
  ),
  constraint payment_settlement_jobs_failure check (
    (failure_code is null or failure_code in ('stripe_capture_missing','stripe_capture_mismatch','stripe_capture_invalid',
      'stripe_balance_pending','stripe_temporarily_unavailable','stripe_capture_already_linked','payment_capture_changed'))
    and (status<>'needs_review' or failure_code is not null)
    and (failure_code is null or status in ('queued','needs_review'))
  )
);
create index payment_settlement_jobs_due_idx on ufit.payment_settlement_jobs(status,next_attempt_at,lease_until,created_at);

create table ufit.payment_settlements (
  payment_id uuid primary key references ufit.payment_settlement_jobs(payment_id),
  charge_id text not null unique,
  balance_transaction_id text not null unique,
  charge_amount integer not null,
  charge_currency text not null,
  settlement_amount integer not null,
  settlement_currency text not null,
  fee_amount integer not null,
  net_amount integer not null,
  captured_at timestamptz not null,
  available_at timestamptz not null,
  live_mode boolean not null,
  recorded_at timestamptz not null default now(),
  constraint payment_settlements_amounts check (
    charge_amount>0 and settlement_amount>0 and fee_amount>=0
    and settlement_amount::bigint-fee_amount::bigint=net_amount::bigint
  ),
  constraint payment_settlements_currencies check (charge_currency~'^[A-Z]{3}$' and settlement_currency~'^[A-Z]{3}$')
);

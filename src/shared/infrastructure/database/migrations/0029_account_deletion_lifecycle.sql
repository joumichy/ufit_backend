CREATE TABLE ufit.account_deletions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES ufit.users(id),
  auth_user_id uuid NOT NULL,
  proof_hash text NOT NULL CONSTRAINT account_deletion_proof_valid CHECK (proof_hash ~ '^[0-9a-f]{64}$'),
  phase text NOT NULL CONSTRAINT account_deletion_phase_valid CHECK (phase IN ('purging_media','revoking_auth','completed')),
  requested_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  next_attempt_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CONSTRAINT account_deletion_attempts_valid CHECK (attempts >= 0),
  lease_token uuid,
  lease_until timestamptz,
  last_failure text CONSTRAINT account_deletion_failure_valid CHECK (last_failure IS NULL OR last_failure IN ('storage_unavailable','auth_unavailable','apple_revocation_required')),
  CONSTRAINT account_deletion_lease_valid CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CONSTRAINT account_deletion_completion_valid CHECK ((phase='completed')=(completed_at IS NOT NULL)
    AND (phase<>'completed' OR (lease_token IS NULL AND last_failure IS NULL))),
  CONSTRAINT account_deletion_chronology_valid CHECK (updated_at >= requested_at AND (completed_at IS NULL OR completed_at >= requested_at))
);
CREATE UNIQUE INDEX account_deletion_user_unique ON ufit.account_deletions(user_id);
CREATE INDEX account_deletion_due_idx ON ufit.account_deletions(next_attempt_at,id) WHERE phase<>'completed';

CREATE TABLE ufit.account_deletion_media (
  request_id uuid NOT NULL REFERENCES ufit.account_deletions(id),
  asset_id uuid NOT NULL,
  kind text NOT NULL CONSTRAINT account_deletion_media_kind_valid CHECK (kind IN ('product','outfit')),
  object_path text NOT NULL CONSTRAINT account_deletion_media_path_valid CHECK (length(object_path)>0 AND object_path=btrim(object_path)),
  PRIMARY KEY (request_id,kind,asset_id)
);

CREATE FUNCTION ufit.protect_account_deletion_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Account deletion receipt is durable' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.phase<>'purging_media' OR NEW.attempts<>0 OR NEW.lease_token IS NOT NULL OR NEW.completed_at IS NOT NULL
      OR NEW.last_failure IS NOT NULL OR NOT EXISTS (SELECT 1 FROM ufit.users
        WHERE id=NEW.user_id AND supabase_user_id=NEW.auth_user_id AND status='deleted')
    THEN RAISE EXCEPTION 'Invalid initial account deletion' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.user_id,NEW.auth_user_id,NEW.proof_hash,NEW.requested_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.auth_user_id,OLD.proof_hash,OLD.requested_at)
  THEN RAISE EXCEPTION 'Account deletion identity is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.phase<>OLD.phase AND NOT ((OLD.phase='purging_media' AND NEW.phase='revoking_auth')
    OR (OLD.phase='revoking_auth' AND NEW.phase='completed'))
  THEN RAISE EXCEPTION 'Invalid account deletion progression' USING ERRCODE='23514'; END IF;
  IF OLD.phase='completed' AND NEW IS DISTINCT FROM OLD
  THEN RAISE EXCEPTION 'Completed account deletion cannot change' USING ERRCODE='23514'; END IF;
  IF NEW.attempts<OLD.attempts
  THEN RAISE EXCEPTION 'Account deletion attempts cannot decrease' USING ERRCODE='23514'; END IF;
  IF OLD.phase='purging_media' AND NEW.phase='revoking_auth' AND EXISTS(
    SELECT 1 FROM ufit.account_deletion_media WHERE request_id=OLD.id)
  THEN RAISE EXCEPTION 'Account deletion media remains' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_deletion_request_boundary BEFORE INSERT OR UPDATE OR DELETE ON ufit.account_deletions
  FOR EACH ROW EXECUTE FUNCTION ufit.protect_account_deletion_request();

CREATE FUNCTION ufit.protect_account_deletion_media() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW IS DISTINCT FROM OLD
  THEN RAISE EXCEPTION 'Account deletion media target is immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM ufit.account_deletions WHERE id=NEW.request_id AND phase='purging_media' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Account deletion media phase is closed' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_deletion_media_boundary BEFORE INSERT OR UPDATE ON ufit.account_deletion_media
  FOR EACH ROW EXECUTE FUNCTION ufit.protect_account_deletion_media();

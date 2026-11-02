CREATE TABLE ufit.notification_push_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES ufit.notifications(id),
  installation_id uuid NOT NULL, association_id uuid NOT NULL, environment text NOT NULL,
  status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid, lease_until timestamptz,
  registration_id uuid, device_token text, attempted_at timestamptz, cancel_requested_at timestamptz,
  provider_message_id uuid, accepted_at timestamptz, last_failure text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_push_notification_association_unique UNIQUE(notification_id,installation_id,association_id),
  CONSTRAINT notification_push_association_fk FOREIGN KEY(association_id,installation_id)
    REFERENCES ufit.notification_device_associations(id,installation_id),
  CONSTRAINT notification_push_registration_fk FOREIGN KEY(registration_id,association_id,installation_id)
    REFERENCES ufit.notification_installation_registrations(id,association_id,installation_id),
  CONSTRAINT notification_push_status_valid CHECK(status IN ('pending','reserved','sending','retry','accepted','rejected','uncertain','cancelled','expired')),
  CONSTRAINT notification_push_environment_valid CHECK(environment IN ('development','production')),
  CONSTRAINT notification_push_attempt_valid CHECK(attempts>=0 AND
    ((attempts=0 AND registration_id IS NULL AND device_token IS NULL AND attempted_at IS NULL)
      OR (attempts>0 AND registration_id IS NOT NULL AND device_token IS NOT NULL AND attempted_at IS NOT NULL))),
  CONSTRAINT notification_push_token_valid CHECK(device_token IS NULL OR device_token~'^([0-9a-f]{2})+$'),
  CONSTRAINT notification_push_lease_valid CHECK(
    (status IN ('reserved','sending') AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (status NOT IN ('reserved','sending') AND lease_token IS NULL AND lease_until IS NULL)),
  CONSTRAINT notification_push_attempt_state_valid CHECK((status<>'pending' OR attempts=0)
    AND (status NOT IN ('sending','retry','accepted','rejected','uncertain') OR attempts>0)),
  CONSTRAINT notification_push_acceptance_valid CHECK(
    (status='accepted' AND provider_message_id=id AND provider_message_id IS NOT NULL AND accepted_at IS NOT NULL AND last_failure IS NULL)
    OR (status<>'accepted' AND provider_message_id IS NULL AND accepted_at IS NULL)),
  CONSTRAINT notification_push_chronology CHECK(expires_at>created_at AND updated_at>=created_at)
);
CREATE INDEX notification_push_due_idx ON ufit.notification_push_deliveries(environment,next_attempt_at,id) WHERE status IN ('pending','retry');
CREATE INDEX notification_push_lease_idx ON ufit.notification_push_deliveries(environment,lease_until,id) WHERE status IN ('reserved','sending');

CREATE FUNCTION ufit.protect_notification_push_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'pending' OR NEW.attempts<>0 OR NEW.cancel_requested_at IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM ufit.notifications n JOIN ufit.notification_device_associations a ON a.user_id=n.recipient_user_id
      WHERE n.id=NEW.notification_id AND a.id=NEW.association_id AND a.installation_id=NEW.installation_id
    ) THEN RAISE EXCEPTION 'Invalid notification push recipient or initial state' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.notification_id,NEW.installation_id,NEW.association_id,NEW.environment,NEW.expires_at,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.notification_id,OLD.installation_id,OLD.association_id,OLD.environment,OLD.expires_at,OLD.created_at)
  THEN RAISE EXCEPTION 'Notification push identity is immutable' USING ERRCODE='23514'; END IF;
  IF OLD.status='reserved' AND NEW.status='sending' THEN
    IF NEW.attempts<>OLD.attempts+1 THEN RAISE EXCEPTION 'Invalid notification push attempt' USING ERRCODE='23514'; END IF;
  ELSIF ROW(NEW.attempts,NEW.registration_id,NEW.device_token,NEW.attempted_at)
    IS DISTINCT FROM ROW(OLD.attempts,OLD.registration_id,OLD.device_token,OLD.attempted_at)
  THEN RAISE EXCEPTION 'Notification push attempt is frozen' USING ERRCODE='23514'; END IF;
  IF NEW.status<>OLD.status AND NOT (
    (OLD.status IN ('pending','retry') AND NEW.status IN ('reserved','cancelled','expired')) OR
    (OLD.status='reserved' AND NEW.status IN ('sending','cancelled','expired')) OR
    (OLD.status='sending' AND NEW.status IN ('accepted','retry','rejected','uncertain','cancelled','expired'))
  ) THEN RAISE EXCEPTION 'Invalid notification push transition' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_push_delivery_boundary BEFORE INSERT OR UPDATE ON ufit.notification_push_deliveries
  FOR EACH ROW EXECUTE FUNCTION ufit.protect_notification_push_delivery();

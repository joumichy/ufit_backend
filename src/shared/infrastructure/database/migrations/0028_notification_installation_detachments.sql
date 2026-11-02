CREATE TABLE ufit.notification_installation_detachments (
  installation_id uuid NOT NULL,
  association_id uuid NOT NULL,
  CONSTRAINT notification_installation_detachment_identity PRIMARY KEY(installation_id,association_id),
  CONSTRAINT notification_installation_detachment_installation_fk FOREIGN KEY(installation_id)
    REFERENCES ufit.notification_installations(id)
);
CREATE FUNCTION ufit.protect_notification_installation_detachment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A detached session target cannot be reopened' USING ERRCODE='23514';
END $$;
CREATE TRIGGER notification_installation_detachment_boundary
  BEFORE UPDATE OR DELETE ON ufit.notification_installation_detachments
  FOR EACH ROW EXECUTE FUNCTION ufit.protect_notification_installation_detachment();

CREATE FUNCTION ufit.reject_detached_notification_association() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM ufit.notification_installation_detachments d
    WHERE d.installation_id=NEW.installation_id AND d.association_id=NEW.id)
  THEN RAISE EXCEPTION 'A detached session target cannot register' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_association_detachment_boundary BEFORE INSERT ON ufit.notification_device_associations
  FOR EACH ROW EXECUTE FUNCTION ufit.reject_detached_notification_association();

CREATE FUNCTION ufit.validate_notification_detachment_relation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM ufit.notification_device_associations a
    WHERE a.installation_id=NEW.installation_id AND a.id=NEW.association_id AND a.closed_at IS NULL)
  THEN RAISE EXCEPTION 'A detached session association must be closed' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER notification_detachment_relation AFTER INSERT ON ufit.notification_installation_detachments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ufit.validate_notification_detachment_relation();

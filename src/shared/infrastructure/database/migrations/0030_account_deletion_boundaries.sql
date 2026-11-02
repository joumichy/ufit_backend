ALTER TABLE ufit.product_media_assets DROP CONSTRAINT product_media_status_valid;
ALTER TABLE ufit.product_media_assets ADD CONSTRAINT product_media_status_valid CHECK (status IN ('pending','ready','retired'));
ALTER TABLE ufit.outfit_media_assets DROP CONSTRAINT outfit_media_status_valid;
ALTER TABLE ufit.outfit_media_assets ADD CONSTRAINT outfit_media_status_valid CHECK (status IN ('pending','ready','retired'));

CREATE FUNCTION ufit.protect_retired_media() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='retired' AND NEW IS DISTINCT FROM OLD
  THEN RAISE EXCEPTION 'A retired media reservation cannot be reused' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER product_media_retirement_boundary BEFORE UPDATE ON ufit.product_media_assets
  FOR EACH ROW EXECUTE FUNCTION ufit.protect_retired_media();
CREATE TRIGGER outfit_media_retirement_boundary BEFORE UPDATE ON ufit.outfit_media_assets
  FOR EACH ROW EXECUTE FUNCTION ufit.protect_retired_media();

CREATE FUNCTION ufit.protect_deleted_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='deleted' THEN
    IF ROW(NEW.id,NEW.supabase_user_id,NEW.status) IS DISTINCT FROM ROW(OLD.id,OLD.supabase_user_id,OLD.status)
    THEN RAISE EXCEPTION 'A deleted identity cannot reactivate' USING ERRCODE='23514'; END IF;
    IF ROW(NEW.email,NEW.display_name,NEW.avatar_url) IS DISTINCT FROM ROW(OLD.email,OLD.display_name,OLD.avatar_url)
      AND NOT (NEW.email='deleted+'||OLD.id::text||'@account.invalid' AND NEW.display_name IS NULL AND NEW.avatar_url IS NULL)
    THEN RAISE EXCEPTION 'A deleted identity cannot regain personal data' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deleted_identity_boundary BEFORE UPDATE ON ufit.users
  FOR EACH ROW EXECUTE FUNCTION ufit.protect_deleted_identity();

CREATE FUNCTION ufit.reject_deleted_account_resource() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_state ufit.user_status;
BEGIN
  SELECT status INTO account_state FROM ufit.users WHERE id=(to_jsonb(NEW)->>TG_ARGV[0])::uuid FOR SHARE;
  IF account_state='deleted'
  THEN RAISE EXCEPTION 'A deleted identity cannot create account resources' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deleted_identity_role_boundary BEFORE INSERT OR UPDATE ON ufit.user_roles
  FOR EACH ROW EXECUTE FUNCTION ufit.reject_deleted_account_resource('user_id');
CREATE TRIGGER deleted_account_cart_boundary BEFORE INSERT ON ufit.carts
  FOR EACH ROW EXECUTE FUNCTION ufit.reject_deleted_account_resource('user_id');
CREATE TRIGGER deleted_account_saved_boundary BEFORE INSERT ON ufit.saved_outfits
  FOR EACH ROW EXECUTE FUNCTION ufit.reject_deleted_account_resource('user_id');
CREATE TRIGGER deleted_account_follow_boundary BEFORE INSERT ON ufit.creator_follows
  FOR EACH ROW EXECUTE FUNCTION ufit.reject_deleted_account_resource('user_id');
CREATE TRIGGER deleted_account_order_boundary BEFORE INSERT ON ufit.orders
  FOR EACH ROW EXECUTE FUNCTION ufit.reject_deleted_account_resource('customer_id');
CREATE TRIGGER deleted_creator_application_boundary BEFORE INSERT ON ufit.creator_applications
  FOR EACH ROW EXECUTE FUNCTION ufit.reject_deleted_account_resource('user_id');
CREATE TRIGGER deleted_brand_application_boundary BEFORE INSERT ON ufit.brand_applications
  FOR EACH ROW EXECUTE FUNCTION ufit.reject_deleted_account_resource('user_id');
CREATE TRIGGER deleted_creator_profile_boundary BEFORE INSERT ON ufit.creator_profiles
  FOR EACH ROW EXECUTE FUNCTION ufit.reject_deleted_account_resource('user_id');
CREATE TRIGGER deleted_brand_profile_boundary BEFORE INSERT ON ufit.brand_profiles
  FOR EACH ROW EXECUTE FUNCTION ufit.reject_deleted_account_resource('owner_user_id');
CREATE TRIGGER deleted_brand_membership_boundary BEFORE INSERT ON ufit.brand_members
  FOR EACH ROW EXECUTE FUNCTION ufit.reject_deleted_account_resource('user_id');
CREATE TRIGGER deleted_product_upload_boundary BEFORE INSERT ON ufit.product_media_assets
  FOR EACH ROW EXECUTE FUNCTION ufit.reject_deleted_account_resource('uploaded_by');
CREATE TRIGGER deleted_outfit_upload_boundary BEFORE INSERT ON ufit.outfit_media_assets
  FOR EACH ROW EXECUTE FUNCTION ufit.reject_deleted_account_resource('uploaded_by');
CREATE TRIGGER deleted_notification_association_boundary BEFORE INSERT ON ufit.notification_device_associations
  FOR EACH ROW EXECUTE FUNCTION ufit.reject_deleted_account_resource('user_id');
CREATE TRIGGER deleted_notification_intent_boundary BEFORE INSERT ON ufit.notifications
  FOR EACH ROW EXECUTE FUNCTION ufit.reject_deleted_account_resource('recipient_user_id');

CREATE FUNCTION ufit.require_closed_deletion_devices() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.phase IN ('revoking_auth','completed') AND EXISTS (SELECT 1 FROM ufit.notification_device_associations
    WHERE user_id=NEW.user_id AND closed_at IS NULL)
  THEN RAISE EXCEPTION 'Account deletion devices remain active' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_deletion_device_boundary BEFORE UPDATE OF phase ON ufit.account_deletions
  FOR EACH ROW EXECUTE FUNCTION ufit.require_closed_deletion_devices();

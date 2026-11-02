ALTER TABLE ufit.users ADD COLUMN image_version integer NOT NULL DEFAULT 0 CHECK (image_version>=0);
ALTER TABLE ufit.creator_profiles ADD COLUMN image_version integer NOT NULL DEFAULT 0 CHECK (image_version>=0);
ALTER TABLE ufit.brand_profiles ADD COLUMN image_version integer NOT NULL DEFAULT 0 CHECK (image_version>=0);
ALTER TABLE ufit.brand_profiles ADD COLUMN logo_url text;

CREATE TABLE ufit.profile_media_assets (
  id uuid PRIMARY KEY, user_id uuid REFERENCES ufit.users(id), creator_id uuid REFERENCES ufit.creator_profiles(id),
  brand_id uuid REFERENCES ufit.brand_profiles(id), uploaded_by uuid NOT NULL REFERENCES ufit.users(id), request_id uuid NOT NULL,
  fingerprint text NOT NULL, byte_size integer NOT NULL, content_type text NOT NULL, object_path text NOT NULL,
  status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profile_media_owner_required CHECK (num_nonnulls(user_id,creator_id,brand_id)=1),
  CONSTRAINT profile_media_size_valid CHECK (byte_size>0 AND byte_size<=8388608),
  CONSTRAINT profile_media_mime_valid CHECK (content_type='image/jpeg'),
  CONSTRAINT profile_media_fingerprint_valid CHECK (fingerprint~'^[a-f0-9]{64}$'),
  CONSTRAINT profile_media_status_valid CHECK (status IN ('pending','ready','retired'))
);
CREATE UNIQUE INDEX profile_media_request_unique ON ufit.profile_media_assets(request_id);
CREATE UNIQUE INDEX profile_media_path_unique ON ufit.profile_media_assets(object_path);
CREATE TABLE ufit.profile_image_changes (
  request_id uuid PRIMARY KEY, user_id uuid REFERENCES ufit.users(id), creator_id uuid REFERENCES ufit.creator_profiles(id),
  brand_id uuid REFERENCES ufit.brand_profiles(id), changed_by uuid NOT NULL REFERENCES ufit.users(id),
  expected_version integer NOT NULL, version integer NOT NULL, asset_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profile_image_change_owner_required CHECK (num_nonnulls(user_id,creator_id,brand_id)=1),
  CONSTRAINT profile_image_change_version_valid CHECK (expected_version>=0 AND expected_version<2147483647 AND version=expected_version+1)
);
CREATE TRIGGER profile_media_retirement_boundary BEFORE UPDATE ON ufit.profile_media_assets
  FOR EACH ROW EXECUTE FUNCTION ufit.protect_retired_media();
CREATE TRIGGER deleted_profile_upload_boundary BEFORE INSERT ON ufit.profile_media_assets
  FOR EACH ROW EXECUTE FUNCTION ufit.reject_deleted_account_resource('uploaded_by');
ALTER TABLE ufit.account_deletion_media DROP CONSTRAINT account_deletion_media_kind_valid;
ALTER TABLE ufit.account_deletion_media ADD CONSTRAINT account_deletion_media_kind_valid CHECK (kind IN ('product','outfit','profile'));

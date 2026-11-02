CREATE UNIQUE INDEX tags_identity_type_unique ON ufit.tags(id,type);

CREATE TABLE ufit.style_preferences (
  user_id uuid PRIMARY KEY REFERENCES ufit.users(id) ON DELETE CASCADE,
  version integer NOT NULL CONSTRAINT style_preferences_version_positive CHECK(version>=1),
  updated_at timestamptz NOT NULL
);
CREATE TABLE ufit.preferred_styles (
  user_id uuid NOT NULL REFERENCES ufit.style_preferences(user_id) ON DELETE CASCADE,
  tag_id uuid NOT NULL, tag_type ufit.tag_type NOT NULL DEFAULT 'style',
  PRIMARY KEY(user_id,tag_id),
  CONSTRAINT preferred_styles_type_style CHECK(tag_type='style'),
  FOREIGN KEY(tag_id,tag_type) REFERENCES ufit.tags(id,type)
);
CREATE TABLE ufit.style_preference_changes (
  user_id uuid NOT NULL REFERENCES ufit.style_preferences(user_id) ON DELETE CASCADE,
  request_id uuid NOT NULL, fingerprint text NOT NULL, expected_version integer NOT NULL, version integer NOT NULL,
  created_at timestamptz NOT NULL, PRIMARY KEY(user_id,request_id),
  CONSTRAINT style_preference_change_version_valid CHECK(expected_version>=0 AND expected_version<2147483647 AND version=expected_version+1),
  CONSTRAINT style_preference_change_fingerprint_valid CHECK(fingerprint~'^[a-f0-9]{64}$')
);
CREATE TRIGGER deleted_style_preferences_boundary BEFORE INSERT ON ufit.style_preferences
  FOR EACH ROW EXECUTE FUNCTION ufit.reject_deleted_account_resource('user_id');

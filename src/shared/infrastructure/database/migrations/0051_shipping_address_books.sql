CREATE TABLE ufit.shipping_address_books (
  user_id uuid PRIMARY KEY REFERENCES ufit.users(id) ON DELETE CASCADE,
  version integer NOT NULL CONSTRAINT shipping_address_book_version_positive CHECK(version>=1),
  updated_at timestamptz NOT NULL
);
CREATE TABLE ufit.shipping_addresses (
  user_id uuid NOT NULL REFERENCES ufit.shipping_address_books(user_id) ON DELETE CASCADE,
  id uuid NOT NULL, full_name text NOT NULL, line1 text NOT NULL, line2 text,
  postal_code text NOT NULL, city text NOT NULL, country text NOT NULL, phone text,
  is_default boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY(user_id,id),
  CONSTRAINT shipping_address_name_length CHECK(char_length(full_name) BETWEEN 1 AND 160),
  CONSTRAINT shipping_address_line1_length CHECK(char_length(line1) BETWEEN 1 AND 200),
  CONSTRAINT shipping_address_line2_length CHECK(line2 IS NULL OR char_length(line2)<=200),
  CONSTRAINT shipping_address_postal_length CHECK(char_length(postal_code) BETWEEN 1 AND 32),
  CONSTRAINT shipping_address_city_length CHECK(char_length(city) BETWEEN 1 AND 120),
  CONSTRAINT shipping_address_phone_length CHECK(phone IS NULL OR char_length(phone)<=40)
);
CREATE UNIQUE INDEX shipping_address_default_unique ON ufit.shipping_addresses(user_id) WHERE is_default;
CREATE TABLE ufit.shipping_address_changes (
  user_id uuid NOT NULL REFERENCES ufit.shipping_address_books(user_id) ON DELETE CASCADE,
  request_id uuid NOT NULL, fingerprint text NOT NULL, expected_version integer NOT NULL, version integer NOT NULL,
  action text NOT NULL, address_id uuid, created_at timestamptz NOT NULL,
  PRIMARY KEY(user_id,request_id),
  CONSTRAINT shipping_address_change_version_valid CHECK(expected_version>=0 AND expected_version<2147483647 AND version=expected_version+1),
  CONSTRAINT shipping_address_change_fingerprint_valid CHECK(fingerprint~'^[a-f0-9]{64}$'),
  CONSTRAINT shipping_address_change_action_valid CHECK(action IN ('save','delete','set_default')),
  CONSTRAINT shipping_address_change_target_valid CHECK(action='set_default' OR address_id IS NOT NULL)
);
CREATE TRIGGER deleted_shipping_address_book_boundary BEFORE INSERT OR UPDATE ON ufit.shipping_address_books
  FOR EACH ROW EXECUTE FUNCTION ufit.reject_deleted_account_resource('user_id');
CREATE TRIGGER deleted_shipping_address_boundary BEFORE INSERT OR UPDATE ON ufit.shipping_addresses
  FOR EACH ROW EXECUTE FUNCTION ufit.reject_deleted_account_resource('user_id');
CREATE TRIGGER deleted_shipping_address_change_boundary BEFORE INSERT OR UPDATE ON ufit.shipping_address_changes
  FOR EACH ROW EXECUTE FUNCTION ufit.reject_deleted_account_resource('user_id');

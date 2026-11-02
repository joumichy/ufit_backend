ALTER TABLE ufit.editorial_collections
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT editorial_collections_version_positive CHECK (version >= 1 AND version <= 2147483646);
ALTER TABLE ufit.editorial_collection_items
  ADD CONSTRAINT editorial_collection_items_position_valid CHECK (position >= 0 AND position < 100),
  ADD CONSTRAINT editorial_collection_items_reference_valid CHECK (
    (item_type = 'outfit' AND outfit_id IS NOT NULL AND product_id IS NULL) OR
    (item_type = 'product' AND product_id IS NOT NULL AND outfit_id IS NULL));
CREATE UNIQUE INDEX editorial_collection_items_position_unique ON ufit.editorial_collection_items(collection_id, position);
CREATE UNIQUE INDEX editorial_collection_items_outfit_unique ON ufit.editorial_collection_items(collection_id, outfit_id);
CREATE UNIQUE INDEX editorial_collection_items_product_unique ON ufit.editorial_collection_items(collection_id, product_id);
CREATE TABLE ufit.editorial_collection_changes (
  request_id uuid PRIMARY KEY, collection_id uuid NOT NULL REFERENCES ufit.editorial_collections(id),
  actor_id uuid NOT NULL REFERENCES ufit.users(id), kind text NOT NULL, fingerprint text NOT NULL,
  expected_version integer NOT NULL, version integer NOT NULL,
  status ufit.editorial_collection_status NOT NULL, created_at timestamptz NOT NULL,
  CONSTRAINT editorial_collection_changes_version_valid CHECK (expected_version >= 0 AND expected_version < 2147483646 AND version = expected_version + 1),
  CONSTRAINT editorial_collection_changes_kind_valid CHECK (kind IN ('create','edit','publish','archive','restore')),
  CONSTRAINT editorial_collection_changes_fingerprint_valid CHECK (fingerprint ~ '^[0-9a-f]{64}$')
);

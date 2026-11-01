ALTER TABLE ufit.shipments
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN incident_reason text,
  ADD COLUMN incident_at timestamptz,
  ADD CONSTRAINT shipments_status_known CHECK (status IN ('pending', 'preparing', 'shipped', 'delivered', 'failed', 'cancelled')),
  ADD CONSTRAINT shipments_version_positive CHECK (version >= 1),
  ADD CONSTRAINT shipments_incident_consistent CHECK (
    (incident_reason IS NULL) = (incident_at IS NULL)
    AND (incident_reason IS NULL OR char_length(btrim(incident_reason)) BETWEEN 1 AND 2000)
    AND (status <> 'failed' OR incident_reason IS NOT NULL)
  );

CREATE INDEX orders_brand_created_id_idx ON ufit.orders (brand_id, created_at DESC, id DESC);

-- Pre-launch rollout: preserve captured amounts and attach the explicit platform refund rule.
UPDATE ufit.orders
SET commerce_snapshot = commerce_snapshot || '{"refundPolicyCode":"proportional_tax_full_shipping_v1"}'::jsonb
WHERE commerce_snapshot IS NOT NULL AND jsonb_typeof(commerce_snapshot) = 'object'
  AND NOT commerce_snapshot ? 'refundPolicyCode';
ALTER TABLE ufit.orders ADD CONSTRAINT orders_return_refund_policy_known CHECK (
  (commerce_snapshot IS NULL OR (jsonb_typeof(commerce_snapshot) = 'object' AND commerce_snapshot->>'refundPolicyCode' = 'proportional_tax_full_shipping_v1')) IS TRUE
);

CREATE TABLE ufit.order_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES ufit.orders(id),
  request_id uuid NOT NULL, request_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'requested', version integer NOT NULL DEFAULT 1,
  reason text NOT NULL, return_policy text NOT NULL, deadline timestamptz NOT NULL,
  refund_policy_code text NOT NULL,
  merchandise_amount integer NOT NULL, tax_amount integer NOT NULL, shipping_amount integer NOT NULL, total_amount integer NOT NULL,
  completes_order boolean NOT NULL,
  brand_decision text, brand_reason text, brand_instructions text, brand_decided_at timestamptz,
  dispute_reason text, disputed_at timestamptz,
  admin_decision text, admin_reason text, admin_instructions text, admin_decided_at timestamptz,
  carrier text, tracking_number text, tracking_url text, sent_at timestamptz,
  received_at timestamptz, refunded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_returns_status_known CHECK (status IN ('requested', 'approved', 'rejected', 'disputed', 'in_transit', 'refund_pending', 'refund_failed', 'refunded', 'closed', 'withdrawn')),
  CONSTRAINT order_returns_version_positive CHECK (version >= 1),
  CONSTRAINT order_returns_fingerprint_valid CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT order_returns_amounts_valid CHECK (merchandise_amount >= 0 AND tax_amount >= 0 AND shipping_amount >= 0 AND total_amount::bigint = merchandise_amount::bigint + tax_amount::bigint + shipping_amount::bigint),
  CONSTRAINT order_returns_policy_known CHECK (refund_policy_code = 'proportional_tax_full_shipping_v1'),
  CONSTRAINT order_returns_text_valid CHECK (char_length(btrim(reason)) BETWEEN 1 AND 2000 AND char_length(btrim(return_policy)) >= 1),
  CONSTRAINT order_returns_brand_decision_valid CHECK ((
    (brand_decision IS NULL AND brand_reason IS NULL AND brand_instructions IS NULL AND brand_decided_at IS NULL)
    OR (brand_decision = 'approved' AND brand_reason IS NULL AND char_length(btrim(brand_instructions)) BETWEEN 1 AND 4000 AND brand_decided_at IS NOT NULL)
    OR (brand_decision = 'rejected' AND char_length(btrim(brand_reason)) BETWEEN 1 AND 2000 AND brand_instructions IS NULL AND brand_decided_at IS NOT NULL)
  ) IS TRUE),
  CONSTRAINT order_returns_dispute_valid CHECK ((
    (dispute_reason IS NULL AND disputed_at IS NULL)
    OR (char_length(btrim(dispute_reason)) BETWEEN 1 AND 2000 AND disputed_at IS NOT NULL)
  ) IS TRUE),
  CONSTRAINT order_returns_admin_decision_valid CHECK ((
    (admin_decision IS NULL AND admin_reason IS NULL AND admin_instructions IS NULL AND admin_decided_at IS NULL)
    OR (admin_decision IN ('approved', 'rejected') AND char_length(btrim(admin_reason)) BETWEEN 1 AND 2000 AND admin_decided_at IS NOT NULL
      AND ((admin_decision = 'approved' AND char_length(btrim(admin_instructions)) BETWEEN 1 AND 4000) OR (admin_decision = 'rejected' AND admin_instructions IS NULL)))
  ) IS TRUE),
  CONSTRAINT order_returns_tracking_valid CHECK ((
    (sent_at IS NULL AND carrier IS NULL AND tracking_number IS NULL AND tracking_url IS NULL)
    OR (sent_at IS NOT NULL AND char_length(btrim(carrier)) BETWEEN 1 AND 120 AND char_length(btrim(tracking_number)) BETWEEN 1 AND 160)
  ) IS TRUE),
  CONSTRAINT order_returns_receipt_valid CHECK (
    (status NOT IN ('refund_pending', 'refund_failed', 'refunded') OR received_at IS NOT NULL)
    AND ((status = 'refunded') = (refunded_at IS NOT NULL))
  )
);
CREATE UNIQUE INDEX order_returns_order_request_unique ON ufit.order_returns(order_id, request_id);
CREATE UNIQUE INDEX order_returns_id_order_unique ON ufit.order_returns(id, order_id);
CREATE UNIQUE INDEX order_returns_one_open_unique ON ufit.order_returns(order_id) WHERE status NOT IN ('refunded', 'closed', 'withdrawn');
CREATE INDEX order_returns_order_created_idx ON ufit.order_returns(order_id, created_at DESC, id DESC);
CREATE INDEX order_returns_created_idx ON ufit.order_returns(created_at DESC, id DESC);

CREATE UNIQUE INDEX order_items_id_order_unique ON ufit.order_items(id, order_id);
CREATE TABLE ufit.order_return_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL, order_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  quantity integer NOT NULL, restock_quantity integer,
  CONSTRAINT order_return_items_quantities_valid CHECK (quantity >= 1 AND (restock_quantity IS NULL OR restock_quantity BETWEEN 0 AND quantity)),
  CONSTRAINT order_return_items_return_order_fk FOREIGN KEY(return_id, order_id) REFERENCES ufit.order_returns(id, order_id),
  CONSTRAINT order_return_items_item_order_fk FOREIGN KEY(order_item_id, order_id) REFERENCES ufit.order_items(id, order_id)
);
CREATE UNIQUE INDEX order_return_items_return_item_unique ON ufit.order_return_items(return_id, order_item_id);
CREATE INDEX order_return_items_order_item_idx ON ufit.order_return_items(order_item_id);

CREATE TABLE ufit.order_return_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES ufit.order_returns(id),
  attempt_number integer NOT NULL, amount integer NOT NULL,
  state text NOT NULL, provider_status text, stripe_refund_id text UNIQUE,
  next_recovery_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_return_refunds_amount_valid CHECK (amount >= 0 AND attempt_number >= 1),
  CONSTRAINT order_return_refunds_state_valid CHECK (state IN ('queued', 'pending', 'succeeded', 'failed')),
  CONSTRAINT order_return_refunds_provider_valid CHECK ((
    (state = 'queued' AND stripe_refund_id IS NULL AND provider_status IS NULL)
    OR (state = 'succeeded' AND ((amount = 0 AND stripe_refund_id IS NULL AND provider_status IS NULL) OR (amount > 0 AND stripe_refund_id IS NOT NULL AND provider_status = 'succeeded')))
    OR (amount > 0 AND stripe_refund_id IS NOT NULL AND ((state = 'pending' AND provider_status IN ('pending', 'requires_action')) OR (state = 'failed' AND provider_status IN ('failed', 'canceled'))))
  ) IS TRUE)
);
CREATE UNIQUE INDEX order_return_refunds_attempt_unique ON ufit.order_return_refunds(return_id, attempt_number);
CREATE UNIQUE INDEX order_return_refunds_one_active_unique ON ufit.order_return_refunds(return_id) WHERE state IN ('queued', 'pending');
CREATE INDEX order_return_refunds_recovery_idx ON ufit.order_return_refunds(next_recovery_at, id) WHERE state IN ('queued', 'pending');

CREATE TABLE ufit.return_commission_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_item_id uuid NOT NULL REFERENCES ufit.order_return_items(id),
  commission_id uuid NOT NULL REFERENCES ufit.commissions(id),
  amount integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_commission_adjustments_amount_valid CHECK (amount >= 0)
);
CREATE UNIQUE INDEX return_commission_adjustments_item_commission_unique ON ufit.return_commission_adjustments(return_item_id, commission_id);
CREATE INDEX return_commission_adjustments_commission_idx ON ufit.return_commission_adjustments(commission_id);

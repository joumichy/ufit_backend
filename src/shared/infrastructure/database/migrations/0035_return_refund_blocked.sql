-- A Ufit attempt can be blocked by a previous failed Stripe refund before a
-- new provider refund exists. Keep the provider ID/status null in that case.
alter table ufit.order_return_refunds drop constraint order_return_refunds_state_valid;
alter table ufit.order_return_refunds add constraint order_return_refunds_state_valid
 check (state in ('queued','pending','succeeded','failed','blocked'));
alter table ufit.order_return_refunds drop constraint order_return_refunds_provider_valid;
alter table ufit.order_return_refunds add constraint order_return_refunds_provider_valid
 check (((state = 'blocked' and amount > 0 and stripe_refund_id is null and provider_status is null)
 or (state = 'queued' and stripe_refund_id is null and provider_status is null)
 or (state = 'succeeded' and ((amount = 0 and stripe_refund_id is null and provider_status is null)
   or (amount > 0 and stripe_refund_id is not null and provider_status = 'succeeded')))
 or (amount > 0 and stripe_refund_id is not null and ((state = 'pending' and provider_status in ('pending','requires_action'))
   or (state = 'failed' and provider_status in ('failed','canceled'))))) is true);

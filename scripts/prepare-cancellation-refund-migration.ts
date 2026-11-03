import 'reflect-metadata';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import {getEnv} from '../src/config/env';
import {DatabaseService} from '../src/shared/infrastructure/database/database.service';
import {CANCELLATION, CANCELLATION_REFUND} from '../src/modules/orders/domain/order-lifecycle';
import {STRIPE_ORDER_METADATA, STRIPE_PAYMENT_STATE} from '../src/modules/payments/application/stripe-commerce';

// Explicit preparation for 0036 on the configured development TEST profile.
// No financial operation: only add the durable identity to existing refunds.
const PREPARATION = {environment: 'development', testPrefix: 'sk_test_', schema: 'ufit', apply: '--apply', zero: 0} as const;
async function main() {
  const env = getEnv();
  assert.equal(env.NODE_ENV, PREPARATION.environment);
  assert.equal(env.UFIT_DB_SCHEMA, PREPARATION.schema);
  assert(env.STRIPE_SECRET_KEY);
  assert(env.STRIPE_SECRET_KEY.startsWith(PREPARATION.testPrefix));
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const db = new DatabaseService();
  try {
    const rows = await db.query<{id: string; order_id: string; stripe_refund_id: string | null; status: string; payment_outcome: string;
      stripe_payment_intent_id: string | null; total_amount: number; currency: string}>(
      `select c.id,c.order_id,c.stripe_refund_id,c.status,c.payment_outcome,o.stripe_payment_intent_id,o.total_amount,o.currency
       from ufit.order_cancellations c join ufit.orders o on o.id=c.order_id order by c.id`);
    const updates: {id: string; refundId: string}[] = [];
    for (const row of rows.rows) {
      assert.equal(row.status, CANCELLATION.status.succeeded);
      if (row.payment_outcome === CANCELLATION.outcome.notCharged) {
        assert.equal(row.stripe_refund_id, null);
        if (row.stripe_payment_intent_id) {
          const intent = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id);
          assert.equal(intent.id, row.stripe_payment_intent_id); assert.equal(intent.livemode, false);
          assert.equal(intent.metadata[STRIPE_ORDER_METADATA.orderId], row.order_id);
          assert.equal(intent.status, STRIPE_PAYMENT_STATE.cancelled); assert.equal(intent.amount_received, PREPARATION.zero);
        }
        continue;
      }
      assert.equal(row.payment_outcome, CANCELLATION.outcome.refunded);
      assert(row.stripe_payment_intent_id && row.stripe_refund_id);
      const intent = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id);
      const refund = await stripe.refunds.retrieve(row.stripe_refund_id);
      assert.equal(intent.livemode, false); assert.equal(intent.id, row.stripe_payment_intent_id);
      assert.equal(intent.status, STRIPE_PAYMENT_STATE.succeeded); assert.equal(intent.amount_received, row.total_amount);
      assert.equal(intent.amount, row.total_amount); assert.equal(intent.currency.toUpperCase(), row.currency);
      assert.equal(intent.metadata[STRIPE_ORDER_METADATA.orderId], row.order_id);
      assert.equal(refund.id, row.stripe_refund_id);
      assert.equal(refund.status, CANCELLATION_REFUND.providerStatus.succeeded);
      assert.equal(refund.payment_intent, intent.id); assert.equal(refund.amount, row.total_amount);
      assert.equal(refund.currency.toUpperCase(), row.currency);
      assert.equal(refund.metadata?.[STRIPE_ORDER_METADATA.orderId], row.order_id);
      assert.equal(refund.metadata?.[STRIPE_ORDER_METADATA.cancellationId], row.id);
      const attempt = refund.metadata?.[STRIPE_ORDER_METADATA.cancellationAttemptId];
      assert(attempt === undefined || attempt === row.id);
      if (attempt === undefined) updates.push({id: row.id, refundId: refund.id});
    }
    if (process.argv.includes(PREPARATION.apply)) for (const update of updates) {
      const refund = await stripe.refunds.update(update.refundId, {metadata: {[STRIPE_ORDER_METADATA.cancellationAttemptId]: update.id}});
      assert.equal(refund.metadata?.[STRIPE_ORDER_METADATA.cancellationAttemptId], update.id);
    }
    console.log(JSON.stringify({cancellations: rows.rowCount, metadataUpdates: updates.length, applied: process.argv.includes(PREPARATION.apply), financialWrites: PREPARATION.zero}));
  } finally {await db.onModuleDestroy();}
}
main().catch(error => {console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;});

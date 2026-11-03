import {describe, expect, it, vi} from 'vitest';
import {readStripePaymentSettlement} from '../../src/modules/payments/infrastructure/stripe-payment-settlement';
import {type SettlementPayment, paymentSettlementDocumentSchema} from '../../src/modules/payments/domain/payment-settlement';

const fixture = {
  payment: {id: '11111111-1111-4111-8111-111111111111', orderId: '22222222-2222-4222-8222-222222222222',
    orderNumber: 'SETTLEMENT-CONTRACT', status: 'refunded', amount: 26780, currency: 'CHF', providerPaymentIntentId: 'pi_Capture',
    createdAt: '2026-10-31T12:00:00.000Z'} satisfies SettlementPayment,
  charge: 'ch_Capture', transaction: 'txn_Settlement', capturedAt: 1793448000, availableAt: 1793707200,
};
function intent() {
  return {id: fixture.payment.providerPaymentIntentId, metadata: {order_id: fixture.payment.orderId}, status: 'succeeded',
    amount_received: fixture.payment.amount, currency: 'chf', livemode: false,
    latest_charge: {id: fixture.charge, payment_intent: fixture.payment.providerPaymentIntentId, paid: true, captured: true,
      status: 'succeeded', amount: fixture.payment.amount, amount_captured: fixture.payment.amount, currency: 'chf', livemode: false,
      created: fixture.capturedAt, refunded: true, amount_refunded: fixture.payment.amount,
      balance_transaction: {id: fixture.transaction, source: fixture.charge, type: 'charge', amount: 32462, currency: 'usd',
        fee: 1296, net: 31166, available_on: fixture.availableAt}}};
}
function reader(value: unknown = intent()) {
  const retrieve = vi.fn().mockResolvedValue(value);
  return {retrieve, read: () => readStripePaymentSettlement({paymentIntents: {retrieve}} as never, fixture.payment, false)};
}
describe('Stripe capture settlement boundary', () => {
  it('preserves actual settlement amounts and fees in their own currency, even after a full refund', async () => {
    const {read, retrieve} = reader();
    expect(await read()).toMatchObject({kind: 'receipt', receipt: {
      chargeId: fixture.charge, balanceTransactionId: fixture.transaction, chargeAmount: 26780, chargeCurrency: 'CHF',
      settlementAmount: 32462, settlementCurrency: 'USD', feeAmount: 1296, netAmount: 31166, liveMode: false,
    }});
    expect(retrieve).toHaveBeenCalledWith('pi_Capture', {expand: ['latest_charge.balance_transaction']});
  });
  it.each(['order', 'mode', 'charge', 'amount', 'source', 'net'] as const)('rejects a conflicting %s at the provider boundary', async kind => {
    const value = intent();
    if (kind === 'order') value.metadata.order_id = fixture.payment.id;
    if (kind === 'mode') value.livemode = true;
    if (kind === 'charge') value.latest_charge.payment_intent = 'pi_Other';
    if (kind === 'amount') value.latest_charge.amount_captured = 100;
    if (kind === 'source') value.latest_charge.balance_transaction.source = 'ch_Other';
    if (kind === 'net') value.latest_charge.balance_transaction.net = 32462;
    expect(await reader(value).read()).toMatchObject({kind: 'review'});
  });
  it('waits for an absent balance transaction without synthesizing settlement amounts', async () => {
    const value = intent();
    const result = await reader({...value, latest_charge: {...value.latest_charge, balance_transaction: null}}).read();
    expect(result).toEqual({kind: 'retry', reason: 'stripe_balance_pending'});
  });
  it('rejects an unexpanded charge instead of guessing its receipt', async () => {
    expect(await reader({...intent(), latest_charge: fixture.charge}).read()).toEqual({kind: 'review', reason: 'stripe_capture_invalid'});
  });
  it.each(['currency', 'metadata'] as const)('rejects a missing required %s without treating it as an outage', async field => {
    expect(await reader({...intent(), [field]: undefined}).read()).toMatchObject({kind: 'review', reason: 'stripe_capture_mismatch'});
  });
  it('distinguishes a missing balance field from its legitimate pending null value', async () => {
    const value = intent();
    expect(await reader({...value, latest_charge: {...value.latest_charge, balance_transaction: undefined}}).read())
      .toEqual({kind: 'review', reason: 'stripe_capture_invalid'});
  });
  it('distinguishes missing source references from a temporary provider outage', async () => {
    const {read, retrieve} = reader();
    retrieve.mockRejectedValueOnce({code: 'resource_missing'}).mockRejectedValueOnce({code: 'api_connection_error'});
    expect(await read()).toEqual({kind: 'review', reason: 'stripe_capture_missing'});
    expect(await read()).toEqual({kind: 'retry', reason: 'stripe_temporarily_unavailable'});
  });
  it('rejects invalid provider dates without turning them into a temporary outage', async () => {
    const value = intent(); value.latest_charge.created = Number.MAX_SAFE_INTEGER;
    expect(await reader(value).read()).toEqual({kind: 'review', reason: 'stripe_capture_invalid'});
  });
  it('cannot describe recorded or review states without their required evidence', () => {
    const base = {payment: fixture.payment, receipt: null, failureCode: null, nextAttemptAt: null, asOf: '2026-11-03T12:00:00.000Z'};
    expect(paymentSettlementDocumentSchema.safeParse({...base, state: 'not_requested'}).success).toBe(true);
    expect(paymentSettlementDocumentSchema.safeParse({...base, state: 'recorded'}).success).toBe(false);
    expect(paymentSettlementDocumentSchema.safeParse({...base, state: 'needs_review'}).success).toBe(false);
    expect(paymentSettlementDocumentSchema.safeParse({...base, state: 'queued'}).success).toBe(false);
  });
});

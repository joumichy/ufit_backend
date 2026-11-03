import {describe, expect, it} from 'vitest';
import {refundStripeReturn} from '../../src/modules/payments/infrastructure/stripe-order-return';
import type {StripePaymentsClient} from '../../src/modules/payments/application/payments.service';
import type {ReturnRefundClaim} from '../../src/modules/orders/domain/return-refund';

const fixture = {
  order: 'order', returnId: 'return', attempt: 'attempt', otherAttempt: 'other-attempt', intent: 'pi_return', refund: 're_return',
};
type Refund = Awaited<ReturnType<StripePaymentsClient['refunds']['list']>>['data'][number];
type RefundListParams = NonNullable<Parameters<StripePaymentsClient['refunds']['list']>[0]>;
type RefundCreateParams = NonNullable<Parameters<StripePaymentsClient['refunds']['create']>[0]>;
type RequestOptions = NonNullable<Parameters<StripePaymentsClient['refunds']['create']>[1]>;
function claim(): ReturnRefundClaim { return {returnId: fixture.returnId, orderId: fixture.order, attemptId: fixture.attempt, paymentIntentId: fixture.intent, originalAmount: 405, amount: 108, currency: 'CHF', refundId: null}; }
function refund(): Refund {
  return {id: fixture.refund, object: 'refund', amount: 108, currency: 'chf', payment_intent: fixture.intent, status: 'succeeded',
    metadata: {order_id: fixture.order, return_id: fixture.returnId, return_refund_attempt_id: fixture.attempt},
    balance_transaction: null, charge: 'ch_return', created: 1793516400, reason: 'requested_by_customer', receipt_number: null,
    source_transfer_reversal: null, transfer_reversal: null};
}
function setup() {
  const state = {
    intent: {id: fixture.intent, metadata: {order_id: fixture.order}, amount: 405, amount_received: 405, currency: 'chf', status: 'succeeded'},
    refunds: [] as Refund[], next: refund(), creations: 0, lostResponse: false, pageSize: 100,
    keys: new Map<string, Refund>(), reads: [] as string[],
  };
  const stripe = {
    paymentIntents: {async retrieve(id: string) { expect(id).toBe(fixture.intent); state.reads.push(id); return structuredClone(state.intent); }},
    refunds: {
      async retrieve(id: string) { state.reads.push(id); const row = state.refunds.find(row => row.id === id); if (!row) throw new Error('Refund missing'); return structuredClone(row); },
      async list(params: RefundListParams) {
        expect(Object.keys(params).sort()).toEqual(['limit', 'payment_intent', 'starting_after']);
        expect(params.payment_intent).toBe(fixture.intent); expect(params.limit).toBe(100);
        const start = params.starting_after ? state.refunds.findIndex(row => row.id === params.starting_after) + 1 : 0;
        expect(start).toBeGreaterThanOrEqual(0);
        return {data: state.refunds.slice(start, start + state.pageSize), has_more: start + state.pageSize < state.refunds.length};
      },
      async create(params: RefundCreateParams, options: RequestOptions) {
        expect(params).toEqual({payment_intent: fixture.intent, amount: 108, reason: 'requested_by_customer', metadata: {order_id: fixture.order, return_id: fixture.returnId, return_refund_attempt_id: fixture.attempt}});
        expect(options).toEqual({idempotencyKey: 'return-refund:attempt'});
        const prior = state.keys.get(options.idempotencyKey!); if (prior) return structuredClone(prior);
        state.creations++; const row = structuredClone(state.next); state.refunds.push(row); state.keys.set(options.idempotencyKey!, row);
        if (state.lostResponse) { state.lostResponse = false; throw new Error('Response lost after provider commit'); }
        return structuredClone(row);
      },
    },
  } as unknown as Pick<StripePaymentsClient, 'paymentIntents' | 'refunds'>;
  return {state, stripe};
}
describe('Stripe order return refunds', () => {
  it('submits the frozen partial amount with exact ownership metadata and a stable attempt key', async () => {
    const {state, stripe} = setup();
    expect(await refundStripeReturn(stripe, claim())).toEqual({state: 'succeeded', refundId: fixture.refund, providerStatus: 'succeeded'});
    expect(state.creations).toBe(1);
    await refundStripeReturn(stripe, claim()); expect(state.creations).toBe(1);
  });
  it('recovers a response lost after provider creation by metadata without another refund', async () => {
    const {state, stripe} = setup(); state.lostResponse = true;
    await expect(refundStripeReturn(stripe, claim())).rejects.toThrow('Response lost');
    expect(await refundStripeReturn(stripe, claim())).toMatchObject({state: 'succeeded', refundId: fixture.refund});
    expect(state.creations).toBe(1);
  });
  it('finds its attempt on later pages and ignores other return attempts', async () => {
    const {state, stripe} = setup(); state.pageSize = 1;
    state.refunds = [{...refund(), id: 're_other', metadata: {...refund().metadata, return_refund_attempt_id: fixture.otherAttempt}}, refund()];
    expect(await refundStripeReturn(stripe, claim())).toMatchObject({state: 'succeeded'}); expect(state.creations).toBe(0);
  });
  it('reconciles the known refund instead of creating or selecting another one', async () => {
    const {state, stripe} = setup(); state.refunds = [refund()];
    expect(await refundStripeReturn(stripe, {...claim(), refundId: fixture.refund})).toMatchObject({state: 'succeeded'});
    expect(state.reads).toEqual([fixture.intent, fixture.refund]); expect(state.creations).toBe(0);
  });
  it('refuses multiple provider refunds for one attempt even when they occupy different pages', async () => {
    const {state, stripe} = setup(); state.pageSize = 1;
    state.refunds = [refund(), {...refund(), id: 're_duplicate'}];
    await expect(refundStripeReturn(stripe, claim())).rejects.toMatchObject({response: {code: 'order_return_payment_mismatch'}});
    expect(state.creations).toBe(0);
  });
  it('keeps pending and requires_action distinct from provider success and preserves failed/canceled states', async () => {
    for (const [providerStatus, expected] of [['pending', 'pending'], ['requires_action', 'pending'], ['failed', 'failed'], ['canceled', 'failed']] as const) {
      const {state, stripe} = setup(); state.refunds = [{...refund(), status: providerStatus}];
      expect(await refundStripeReturn(stripe, {...claim(), refundId: fixture.refund})).toEqual({state: expected, refundId: fixture.refund, providerStatus});
      expect(state.creations).toBe(0);
    }
  });
  it('blocks a new attempt when the original payment already has a failed refund, without inventing a provider refund', async () => {
    const {state, stripe} = setup();
    state.refunds = [{...refund(), status: 'failed', metadata: {...refund().metadata, return_refund_attempt_id: fixture.otherAttempt}}];
    expect(await refundStripeReturn(stripe, claim())).toEqual({state: 'blocked', refundId: null, providerStatus: null});
    expect(state.creations).toBe(0);
  });
  it('does not block an existing attempt because a different refund failed later', async () => {
    const {state, stripe} = setup();
    state.refunds = [{...refund(), status: 'failed', id: fixture.otherAttempt, metadata: {...refund().metadata, return_refund_attempt_id: fixture.otherAttempt}}, refund()];
    expect(await refundStripeReturn(stripe, claim())).toEqual({state: 'succeeded', refundId: fixture.refund, providerStatus: 'succeeded'});
    expect(state.creations).toBe(0);
  });
  it('refuses an unrecognized status instead of completing the customer refund', async () => {
    const {state, stripe} = setup(); state.refunds = [{...refund(), status: null}];
    await expect(refundStripeReturn(stripe, {...claim(), refundId: fixture.refund})).rejects.toMatchObject({response: {code: 'order_return_refund_status_unknown'}});
  });
  it('requires the original captured order, amount and currency before creating any refund', async () => {
    for (const patch of [{amount: 406}, {amount_received: 404}, {currency: 'eur'}, {metadata: {order_id: 'foreign'}}, {status: 'processing'}, {status: 'canceled'}]) {
      const {state, stripe} = setup(); Object.assign(state.intent, patch);
      await expect(refundStripeReturn(stripe, claim())).rejects.toMatchObject({status: 409}); expect(state.creations).toBe(0);
    }
  });
  it('rejects mismatched provider refunds, including a valid amount attached to another order/attempt/payment', async () => {
    for (const patch of [{amount: 109}, {currency: 'eur'}, {payment_intent: 'pi_foreign'}, {metadata: {...refund().metadata, order_id: 'foreign'}}, {metadata: {...refund().metadata, return_id: 'foreign'}}, {metadata: {...refund().metadata, return_refund_attempt_id: fixture.otherAttempt}}]) {
      const {state, stripe} = setup(); state.refunds = [{...refund(), ...patch}];
      await expect(refundStripeReturn(stripe, {...claim(), refundId: fixture.refund})).rejects.toMatchObject({response: {code: 'order_return_payment_mismatch'}}); expect(state.creations).toBe(0);
    }
  });
  it('does not call Stripe refunds for a zero-value partial return and still verifies the paid origin', async () => {
    const {state, stripe} = setup();
    expect(await refundStripeReturn(stripe, {...claim(), amount: 0})).toEqual({state: 'succeeded', refundId: null, providerStatus: null});
    expect(state.reads).toEqual([fixture.intent]); expect(state.creations).toBe(0);
  });
  it('rejects negative, fractional and excessive refunds before touching the provider', async () => {
    for (const amount of [-1, 1.5, 406, Number.NaN]) {
      const {state, stripe} = setup();
      await expect(refundStripeReturn(stripe, {...claim(), amount})).rejects.toMatchObject({status: 409}); expect(state.reads).toEqual([]);
    }
  });
});

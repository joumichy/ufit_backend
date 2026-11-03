import {describe, expect, it, vi} from 'vitest';
import {reverseStripeCancellation} from '../../src/modules/payments/infrastructure/stripe-order-cancellation';
import {CANCELLATION, CANCELLATION_REFUND, ORDER_STATUS, type CancellationClaim, type CancellationRefundAttempt} from '../../src/modules/orders/domain/order-lifecycle';
import {STRIPE_COMMERCE, STRIPE_ORDER_METADATA, STRIPE_PAYMENT_STATE, stripeCancellationKey, stripeCancellationRefundKey} from '../../src/modules/payments/application/stripe-commerce';

const IDs = {order: 'ce8af4b6-8406-43ad-91c9-3159ce6a8a3b', cancellation: 'f739efb5-a3d8-4734-9724-1b5be3d205a6', attempt: '51b5d6da-bdbc-4be6-b564-9e2d336db6fb', intent: 'pi_qualification', refund: 're_qualification'};
const amount = 13790, currency = 'CHF';
const claim: CancellationClaim = {id: IDs.cancellation, orderId: IDs.order, originalStatus: ORDER_STATUS.paid,
  reason: CANCELLATION.reason.customer, status: CANCELLATION.status.requested, amount, currency, paymentIntentId: IDs.intent, refund: null};
const attempt: CancellationRefundAttempt = {id: IDs.attempt, cancellationId: IDs.cancellation, attemptNumber: 1,
  amount, currency, paymentIntentId: IDs.intent, refundId: null, state: CANCELLATION_REFUND.state.queued, providerStatus: null};
const intent = {id: IDs.intent, metadata: {[STRIPE_ORDER_METADATA.orderId]: IDs.order}, amount, amount_received: amount, currency: 'chf', status: STRIPE_PAYMENT_STATE.succeeded};
const refund = {id: IDs.refund, payment_intent: IDs.intent, amount, currency: 'chf', status: CANCELLATION_REFUND.providerStatus.succeeded,
  metadata: {[STRIPE_ORDER_METADATA.orderId]: IDs.order, [STRIPE_ORDER_METADATA.cancellationId]: IDs.cancellation, [STRIPE_ORDER_METADATA.cancellationAttemptId]: IDs.attempt}};
function setup() {
  const stripe = {paymentIntents: {retrieve: vi.fn().mockResolvedValue(intent), cancel: vi.fn().mockResolvedValue({...intent, amount_received: 0, status: STRIPE_PAYMENT_STATE.cancelled})},
    refunds: {list: vi.fn().mockResolvedValue({data: [], has_more: false}), retrieve: vi.fn().mockResolvedValue(refund),
      create: vi.fn().mockImplementation(async (body, options) => {
        expect(body).toEqual({payment_intent: IDs.intent, amount, reason: STRIPE_COMMERCE.cancellationReason, metadata: refund.metadata});
        expect(options).toEqual({idempotencyKey: stripeCancellationRefundKey(IDs.attempt)}); return refund;
      })}};
  const prepare = vi.fn().mockResolvedValue(attempt);
  const run = (input: CancellationClaim = claim) => reverseStripeCancellation(stripe as never, input, prepare);
  return {stripe, prepare, run};
}
describe('Stripe cancellation durable refund contract', () => {
  it('creates only after a captured payment and a durable attempt, using its exact identity', async () => {
    const {run, prepare} = setup(); expect((await run()).refund).toEqual({attempt, result: {state: CANCELLATION_REFUND.state.succeeded, providerStatus: CANCELLATION_REFUND.providerStatus.succeeded, refundId: IDs.refund}}); expect(prepare).toHaveBeenCalledOnce();
  });
  it('cancels an uncaptured payment without preparing a financial attempt', async () => {
    const {stripe, prepare, run} = setup(); stripe.paymentIntents.retrieve.mockResolvedValue({...intent, amount_received: 0, status: 'requires_payment_method'});
    expect((await run()).settlement?.outcome).toBe(CANCELLATION.outcome.notCharged);
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith(IDs.intent, {cancellation_reason: STRIPE_COMMERCE.cancellationReason}, {idempotencyKey: stripeCancellationKey(IDs.cancellation)});
    expect(prepare).not.toHaveBeenCalled(); expect(stripe.refunds.create).not.toHaveBeenCalled();
  });
  it('revalidates a payment that succeeds during cancellation', async () => {
    const {stripe, run} = setup(); stripe.paymentIntents.retrieve.mockResolvedValueOnce({...intent, amount_received: 0, status: 'requires_payment_method'});
    stripe.paymentIntents.cancel.mockRejectedValueOnce(new Error('already captured')); expect((await run()).refund?.result.state).toBe(CANCELLATION_REFUND.state.succeeded);
  });
  it.each(['id', 'amount', 'currency', 'amount_received', 'metadata'] as const)('rejects inconsistent captured payment %s before any preparation or refund', async field => {
    const {stripe, prepare, run} = setup(); stripe.paymentIntents.retrieve.mockResolvedValue({...intent, [field]: field === 'metadata' ? {} : field === 'amount' || field === 'amount_received' ? 1 : 'incorrect'});
    await expect(run()).rejects.toThrow(); expect(prepare).not.toHaveBeenCalled(); expect(stripe.refunds.create).not.toHaveBeenCalled();
  });
  it('rejects mismatched facts returned by the cancellation race read', async () => {
    const {stripe, run} = setup(); stripe.paymentIntents.retrieve.mockResolvedValueOnce({...intent, amount_received: 0, status: 'requires_payment_method'}).mockResolvedValueOnce({...intent, metadata: {}});
    stripe.paymentIntents.cancel.mockRejectedValueOnce(new Error('race')); await expect(run()).rejects.toThrow(); expect(stripe.refunds.create).not.toHaveBeenCalled();
  });
  it('recovers the same attempt refund across every page without another creation', async () => {
    const {stripe, run} = setup(); stripe.refunds.list.mockResolvedValueOnce({data: [{...refund, id: 're_other', metadata: {}}], has_more: true}).mockResolvedValueOnce({data: [refund], has_more: false});
    expect((await run()).refund?.result.refundId).toBe(IDs.refund); expect(stripe.refunds.list).toHaveBeenLastCalledWith({payment_intent: IDs.intent, limit: STRIPE_COMMERCE.pageLimit, starting_after: 're_other'}); expect(stripe.refunds.create).not.toHaveBeenCalled();
  });
  it('rejects duplicate matches across pages', async () => {
    const {stripe, run} = setup(); stripe.refunds.list.mockResolvedValueOnce({data: [refund], has_more: true}).mockResolvedValueOnce({data: [{...refund, id: 're_duplicate'}], has_more: false});
    await expect(run()).rejects.toThrow(); expect(stripe.refunds.create).not.toHaveBeenCalled();
  });
  it('rejects an incomplete provider page instead of creating a new refund', async () => {
    const {stripe, run} = setup(); stripe.refunds.list.mockResolvedValue({data: [], has_more: true}); await expect(run()).rejects.toThrow(); expect(stripe.refunds.create).not.toHaveBeenCalled();
  });
  it.each(Object.values(CANCELLATION_REFUND.providerStatus))('preserves exact provider state %s for a known refund and never creates one', async status => {
    const {stripe, prepare, run} = setup(); prepare.mockResolvedValue({...attempt, refundId: IDs.refund}); stripe.refunds.retrieve.mockResolvedValue({...refund, status});
    const result = (await run()).refund?.result; expect(result?.providerStatus).toBe(status);
    expect(result?.state).toBe(status === 'failed' || status === 'canceled' ? 'failed' : status === 'succeeded' ? 'succeeded' : 'pending');
    expect(stripe.refunds.list).not.toHaveBeenCalled(); expect(stripe.refunds.create).not.toHaveBeenCalled();
  });
  it.each(['id','payment_intent','amount','currency','metadata'] as const)('rejects a known refund with a mismatched %s', async field => {
    const {stripe, prepare, run} = setup(); prepare.mockResolvedValue({...attempt, refundId: IDs.refund}); stripe.refunds.retrieve.mockResolvedValue({...refund, [field]: field === 'metadata' ? {} : field === 'amount' ? 1 : 'incorrect'});
    await expect(run()).rejects.toThrow(); expect(stripe.refunds.create).not.toHaveBeenCalled();
  });
  it('blocks a fresh attempt after original-method failure without inventing a provider status', async () => {
    const {stripe, run} = setup(); stripe.refunds.list.mockResolvedValue({data: [{...refund, metadata: {}, status: 'failed'}], has_more: false});
    expect((await run()).refund?.result).toEqual({state: 'blocked', refundId: null, providerStatus: null}); expect(stripe.refunds.create).not.toHaveBeenCalled();
  });
  it('keeps an in-flight payment recoverable without a refund', async () => {
    const {stripe, prepare, run} = setup(); stripe.paymentIntents.retrieve.mockResolvedValue({...intent, status: STRIPE_PAYMENT_STATE.processing}); expect(await run()).toEqual({}); expect(prepare).not.toHaveBeenCalled();
  });
  it('rejects an unknown provider state', async () => {
    const {stripe, prepare, run} = setup(); prepare.mockResolvedValue({...attempt, refundId: IDs.refund}); stripe.refunds.retrieve.mockResolvedValue({...refund, status: 'unknown'}); await expect(run()).rejects.toThrow();
  });
});

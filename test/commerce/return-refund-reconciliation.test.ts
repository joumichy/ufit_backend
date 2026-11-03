import {describe, expect, it} from 'vitest';
import {acceptsRefundResult, RETURN_REFUND, RETURN_REFUND_ATTEMPT} from '../../src/modules/orders/domain/return-refund';
import {ReturnRefundsService} from '../../src/modules/orders/application/return-refunds.service';

const fixture = {orderId: 'order', returnId: 'return', attemptId: 'attempt', paymentIntentId: 'pi_owned', refundId: 're_known',
  amount: 108, originalAmount: 405, currency: 'CHF'} as const;
describe('Return refund reconciliation', () => {
  it('accepts an asynchronous failure after success without letting stale reads undo terminal facts', () => {
    for (const next of Object.values(RETURN_REFUND.state)) {
      expect(acceptsRefundResult(RETURN_REFUND_ATTEMPT.queued, next)).toBe(true);
      expect(acceptsRefundResult(RETURN_REFUND_ATTEMPT.pending, next)).toBe(true);
      expect(acceptsRefundResult(RETURN_REFUND_ATTEMPT.succeeded, next)).toBe(next === RETURN_REFUND.state.failed);
      expect(acceptsRefundResult(RETURN_REFUND_ATTEMPT.failed, next)).toBe(false);
      expect(acceptsRefundResult(RETURN_REFUND_ATTEMPT.blocked, next)).toBe(false);
    }
  });
  it('reads the owned attempt with a known refund ID and settles current provider facts', async () => {
    const reference = {orderId: fixture.orderId, returnId: fixture.returnId, attemptId: fixture.attemptId, refundId: fixture.refundId};
    const result = {state: RETURN_REFUND.state.failed, refundId: fixture.refundId, providerStatus: RETURN_REFUND.providerStatus.failed};
    const calls: object[] = [];
    const repository = {
      async findAttempt(input: typeof reference) { expect(input).toEqual(reference); calls.push(input); return fixture; },
      async settle(claim: typeof fixture, actual: typeof result) { expect(claim).toEqual(fixture); expect(actual).toEqual(result); calls.push(actual); return true; },
    };
    const payments = {async refundReturn(claim: typeof fixture) { expect(claim.refundId).toBe(fixture.refundId); calls.push(claim); return result; }};
    expect(await new ReturnRefundsService(repository as never, payments as never).reconcile(reference)).toBe(true);
    expect(calls).toEqual([reference, fixture, result]);
  });
});

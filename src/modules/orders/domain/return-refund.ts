export const RETURN_REFUND = {
  repository: Symbol('ReturnRefundRepository'),
  recovery: {batchSize: 5, pollMilliseconds: 15000, leaseMilliseconds: 120000},
  historyReason: 'order_return_refunded',
  failureHistoryReason: 'order_return_refund_failed',
  state: {pending: 'pending', succeeded: 'succeeded', failed: 'failed', blocked: 'blocked'},
  providerStatus: {pending: 'pending', requiresAction: 'requires_action', succeeded: 'succeeded', failed: 'failed', cancelled: 'canceled'},
  failure: {
    mismatch: {code: 'order_return_payment_mismatch', message: 'The payment or refund does not match this return'},
    unavailable: {code: 'order_return_payment_unavailable', message: 'The return requires a captured payment'},
    unknown: {code: 'order_return_refund_status_unknown', message: 'The refund provider returned an unsupported state'},
    originalMethod: {code: 'order_return_refund_alternative_required', message: 'An alternative refund method must be arranged after the original refund failed'},
  },
} as const;
export const RETURN_REFUND_ATTEMPT = {queued: 'queued', ...RETURN_REFUND.state} as const;
export type ReturnRefundAttemptState = typeof RETURN_REFUND_ATTEMPT[keyof typeof RETURN_REFUND_ATTEMPT];
export type ReturnRefundProviderStatus = typeof RETURN_REFUND.providerStatus[keyof typeof RETURN_REFUND.providerStatus];
export interface ReturnRefundClaim {
  returnId: string; orderId: string; attemptId: string; paymentIntentId: string;
  originalAmount: number; amount: number; currency: string; refundId: string | null;
}
export interface ReturnRefundResult {
  state: typeof RETURN_REFUND.state[keyof typeof RETURN_REFUND.state];
  refundId: string | null; providerStatus: ReturnRefundProviderStatus | null;
}
export interface ReturnRefundRepository {
  claimRecoverable(): Promise<ReturnRefundClaim[]>;
  findAttempt(reference: ReturnRefundReference): Promise<ReturnRefundClaim>;
  settle(claim: ReturnRefundClaim, result: ReturnRefundResult): Promise<boolean>;
}
export interface ReturnRefundReference {orderId: string; returnId: string; attemptId: string; refundId: string;}

export function acceptsRefundResult(current: ReturnRefundAttemptState, next: ReturnRefundResult['state']): boolean {
  // A provider success can fail asynchronously. A stale in-flight read must not
  // undo success, or resurrect the same refund after a terminal failure.
  return current !== RETURN_REFUND_ATTEMPT.failed && current !== RETURN_REFUND_ATTEMPT.blocked
    && (current !== RETURN_REFUND_ATTEMPT.succeeded || next === RETURN_REFUND.state.failed);
}

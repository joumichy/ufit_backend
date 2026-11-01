export const RETURN_REFUND = {
  repository: Symbol('ReturnRefundRepository'),
  recovery: {batchSize: 5, pollMilliseconds: 15000, leaseMilliseconds: 120000},
  historyReason: 'order_return_refunded',
  state: {pending: 'pending', succeeded: 'succeeded', failed: 'failed'},
  providerStatus: {pending: 'pending', requiresAction: 'requires_action', succeeded: 'succeeded', failed: 'failed', cancelled: 'canceled'},
  failure: {
    mismatch: {code: 'order_return_payment_mismatch', message: 'The payment or refund does not match this return'},
    unavailable: {code: 'order_return_payment_unavailable', message: 'The return requires a captured payment'},
    unknown: {code: 'order_return_refund_status_unknown', message: 'The refund provider returned an unsupported state'},
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
  settle(claim: ReturnRefundClaim, result: ReturnRefundResult): Promise<void>;
}

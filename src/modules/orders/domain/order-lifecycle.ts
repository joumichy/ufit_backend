export const ORDER_STATUS = {
  pendingPayment: "pending_payment",
  paid: "paid",
  cancelling: "cancelling",
  preparing: "preparing",
  shipped: "shipped",
  delivered: "delivered",
  cancelled: "cancelled",
  refunded: "refunded",
} as const;
export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];
export const CANCELLATION = {
  repository: Symbol("OrderCancellationRepository"),
  status: { requested: "requested", succeeded: "succeeded", failed: "failed" },
  outcome: { notCharged: "not_charged", refunded: "refunded", refundFailed: "refund_failed", refundCancelled: "refund_canceled", refundBlocked: "refund_blocked" },
  reason: {
    customer: "customer_requested",
    stockUnavailable: "stock_unavailable",
  },
  recovery: {
    batchSize: 5,
    pollMilliseconds: 15000,
    leaseMilliseconds: 120000,
  },
  reasons: {
    stockUnavailable: "paid_order_stock_unavailable",
    requested: "customer_cancellation_requested",
    completed: "customer_cancellation_completed",
  },
  failures: {
    unavailable: {
      code: "order_cancellation_unavailable",
      message: "The order can no longer be cancelled",
    },
    changed: {
      code: "order_cancellation_changed",
      message: "The cancellation state changed; refresh the order",
    },
    payout: {
      code: "order_cancellation_payout_pending",
      message:
        "A creator payout must be reversed before completing this cancellation",
    },
  },
} as const;
export const ORDER_PAYMENT = {
  provider: "stripe",
  status: { succeeded: "succeeded", refunded: "refunded" },
} as const;
export const ORDER_COMMISSION = {
  status: {
    pending: "pending",
    estimated: "estimated",
    validated: "validated",
    paid: "paid",
    cancelled: "cancelled",
  },
} as const;
export const ORDER_LIMIT = {
  singleRow: 1,
  overflow: 1,
  firstRow: 0,
  lastRow: -1,
  initialQuantity: 0,
} as const;
export interface CancellationClaim {
  id: string;
  orderId: string;
  originalStatus: OrderStatus;
  reason: (typeof CANCELLATION.reason)[keyof typeof CANCELLATION.reason];
  status: (typeof CANCELLATION.status)[keyof typeof CANCELLATION.status];
  amount: number;
  currency: string;
  paymentIntentId?: string;
  refund: CancellationRefundAttempt | null;
}
export type CancellationOutcome = (typeof CANCELLATION.outcome)[keyof typeof CANCELLATION.outcome];
export type CancellationSettlement = {outcome: typeof CANCELLATION.outcome.notCharged};
export interface OrderCancellationRepository {
  claim(customerId: string, orderId: string): Promise<CancellationClaim>;
  findPending(orderId: string): Promise<CancellationClaim | null>;
  claimRecoverable(): Promise<CancellationClaim[]>;
  prepareRefund(claim: CancellationClaim): Promise<CancellationRefundAttempt>;
  findRefund(reference: CancellationRefundReference): Promise<CancellationClaim>;
  recordRefund(claim: CancellationClaim, attempt: CancellationRefundAttempt, result: CancellationRefundResult): Promise<boolean>;
  complete(
    claim: CancellationClaim,
    settlement?: CancellationSettlement,
  ): Promise<void>;
}

export function customerOrderActions(
  status: OrderStatus,
  reason?: CancellationClaim["reason"],
  refund?: CancellationRefundSummary | null,
) {
  return {
    cancel:
      (reason !== CANCELLATION.reason.stockUnavailable &&
        (status === ORDER_STATUS.pendingPayment || status === ORDER_STATUS.paid)) ||
      (status === ORDER_STATUS.cancelled && refund?.providerStatus === CANCELLATION_REFUND.providerStatus.cancelled),
    resumePayment: status === ORDER_STATUS.pendingPayment,
  };
}

export const ORDER_FAILURE = {
  paymentUnavailable: {
    code: "order_payment_unavailable",
    message: "The order no longer accepts payment",
  },
} as const;

export const CANCELLATION_REFUND = {
  state: {queued: 'queued', pending: 'pending', succeeded: 'succeeded', failed: 'failed', blocked: 'blocked'},
  providerStatus: {pending: 'pending', requiresAction: 'requires_action', succeeded: 'succeeded', failed: 'failed', cancelled: 'canceled'},
  attempt: {initial: 1, step: 1, maximumMatches: 1},
  failure: {
    mismatch: {code: 'order_cancellation_refund_mismatch', message: 'The refund does not match this cancellation'},
    unknown: {code: 'order_cancellation_refund_status_unknown', message: 'The refund provider returned an unsupported state'},
  },
} as const;
export type CancellationRefundState = typeof CANCELLATION_REFUND.state[keyof typeof CANCELLATION_REFUND.state];
export type CancellationProviderStatus = typeof CANCELLATION_REFUND.providerStatus[keyof typeof CANCELLATION_REFUND.providerStatus];
export interface CancellationRefundSummary {
  state: CancellationRefundState; providerStatus: CancellationProviderStatus | null;
}
export interface CancellationRefundAttempt extends CancellationRefundSummary {
  id: string; cancellationId: string; attemptNumber: number; paymentIntentId: string;
  amount: number; currency: string; refundId: string | null;
}
export interface CancellationRefundReference {orderId: string; cancellationId: string; attemptId: string; refundId: string;}
export interface CancellationRefundResult extends CancellationRefundSummary {refundId: string | null;}
export interface CancellationProjection {
  status: CancellationClaim['status']; reason: CancellationClaim['reason'];
  outcome: CancellationOutcome | null; refund: CancellationRefundSummary | null;
}
export function cancellationRefundOutcome(result: CancellationRefundSummary): CancellationOutcome | null {
  switch (result.state) {
    case CANCELLATION_REFUND.state.succeeded: return CANCELLATION.outcome.refunded;
    case CANCELLATION_REFUND.state.failed: return result.providerStatus === CANCELLATION_REFUND.providerStatus.cancelled ? CANCELLATION.outcome.refundCancelled : CANCELLATION.outcome.refundFailed;
    case CANCELLATION_REFUND.state.blocked: return CANCELLATION.outcome.refundBlocked;
    default: return null;
  }
}
export function acceptsCancellationRefund(current: CancellationRefundSummary, next: CancellationRefundResult): boolean {
  return current.state !== CANCELLATION_REFUND.state.failed && current.state !== CANCELLATION_REFUND.state.blocked
    && (current.state !== CANCELLATION_REFUND.state.succeeded || next.state === CANCELLATION_REFUND.state.failed
      || next.providerStatus === CANCELLATION_REFUND.providerStatus.requiresAction);
}

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
  status: { requested: "requested", succeeded: "succeeded" },
  outcome: { notCharged: "not_charged", refunded: "refunded" },
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
  refundId?: string;
}
export type CancellationSettlement = {
  outcome: (typeof CANCELLATION.outcome)[keyof typeof CANCELLATION.outcome];
  refundId?: string;
};
export interface OrderCancellationRepository {
  claim(customerId: string, orderId: string): Promise<CancellationClaim>;
  findPending(orderId: string): Promise<CancellationClaim | null>;
  claimRecoverable(): Promise<CancellationClaim[]>;
  rememberRefund(claim: CancellationClaim, refundId: string): Promise<void>;
  complete(
    claim: CancellationClaim,
    settlement: CancellationSettlement,
  ): Promise<void>;
}

export function customerOrderActions(
  status: OrderStatus,
  reason?: CancellationClaim["reason"],
) {
  return {
    cancel:
      reason !== CANCELLATION.reason.stockUnavailable &&
      (status === ORDER_STATUS.pendingPayment ||
        status === ORDER_STATUS.paid ||
        status === ORDER_STATUS.cancelling),
    resumePayment: status === ORDER_STATUS.pendingPayment,
  };
}

export const ORDER_FAILURE = {
  paymentUnavailable: {
    code: "order_payment_unavailable",
    message: "The order no longer accepts payment",
  },
} as const;

export const STRIPE_CLIENT = Symbol("STRIPE_CLIENT");
export const STRIPE_ORDER_METADATA = {
  orderId: "order_id",
  cancellationId: "cancellation_id",
} as const;
export const STRIPE_PAYMENT_STATE = {
  succeeded: "succeeded",
  cancelled: "canceled",
  processing: "processing",
} as const;
export const STRIPE_REFUND_STATE = {
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "canceled",
} as const;
export const STRIPE_COMMERCE = {
  configuration: {paymentsUnavailable: 'Stripe payments are not configured'},
  paymentSucceeded: "payment_intent.succeeded",
  cancellationReason: "requested_by_customer",
  pageLimit: 100,
  lastIndex: -1,
  zero: 0,
  refundFailure: {
    code: "order_refund_requires_attention",
    message: "The payment provider requires attention for this refund",
  },
  mismatch: {
    code: "order_payment_mismatch",
    message: "The payment does not match the order",
  },
} as const;
export const stripeCancellationKey = (id: string) => `cancel-intent:${id}`;
export const stripeCancellationRefundKey = (id: string) =>
  `cancel-refund:${id}`;

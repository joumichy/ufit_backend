export const STRIPE_PAYMENT_FINALIZER = Symbol("STRIPE_PAYMENT_FINALIZER");
export interface StripePaidPayment {
  eventId: string;
  orderId: string;
  paymentIntentId: string;
  amount: number;
  currency: string;
}
export interface StripePaymentFinalization {
  duplicate: boolean;
  reversalRequired: boolean;
}
export interface StripePaymentFinalizer {
  confirm(input: StripePaidPayment): Promise<StripePaymentFinalization>;
}

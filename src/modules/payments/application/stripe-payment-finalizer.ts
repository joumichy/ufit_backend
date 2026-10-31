export const STRIPE_PAYMENT_FINALIZER = Symbol("STRIPE_PAYMENT_FINALIZER");
export interface StripePaidPayment {
  eventId: string;
  orderId: string;
  paymentIntentId: string;
  amount: number;
  currency: string;
}
export interface StripePaymentFinalizer {
  confirm(input: StripePaidPayment): Promise<{ duplicate: boolean }>;
}

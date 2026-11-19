import {fromStripeAmount} from './stripe-amount';
import {ServiceUnavailableException} from '@nestjs/common';
import {z} from 'zod';
import type {Order} from '../../orders/application/orders.service';
import {ORDER_STATUS} from '../../orders/domain/order-lifecycle';
import {STRIPE_ORDER_METADATA} from '../application/stripe-commerce';
import {CUSTOMER_PAYMENT as C, customerPaymentStatusSchema, type CustomerPaymentStatus} from '../domain/customer-payment';

const nonnegative = z.number().int().min(C.limits.zero).max(Number.MAX_SAFE_INTEGER);
const intentSchema = z.object({
  id: z.string().regex(C.provider.intentPattern), amount: nonnegative, amount_received: nonnegative,
  currency: z.string(), metadata: z.record(z.string(), z.string()), livemode: z.boolean(),
  status: z.enum([C.provider.method,C.provider.confirmation,C.provider.action,C.provider.processing,C.provider.capture,C.provider.succeeded,C.provider.cancelled]),
  confirmation_method: z.enum([C.provider.automatic,C.provider.manual]),
  capture_method: z.enum([C.provider.automatic,C.provider.asynchronous,C.provider.manual]),
  last_payment_error: z.object({}).passthrough().nullable(), client_secret: z.string().nullable(),
});
export function customerPaymentDocument(order: Order, state: CustomerPaymentStatus['state'], liveMode: boolean | null): CustomerPaymentStatus {
  const parsed = customerPaymentStatusSchema.safeParse({orderId: order.id, orderStatus: order.status, amount: order.totalAmount,
    currency: order.currency, observedAt: new Date().toISOString(), state, paymentIntentId: order.stripePaymentIntentId ?? null, liveMode});
  if (!parsed.success) throw new ServiceUnavailableException(C.failure.invalid);
  return parsed.data;
}
/** Reading a succeeded intent never fulfills the order: the signed webhook owns that transition. */
export function readCustomerPaymentIntent(order: Order, raw: unknown, liveMode: boolean) {
  const parsed = intentSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceUnavailableException(C.failure.invalid);
  const intent = parsed.data;
  const amount = fromStripeAmount(intent.amount, intent.currency), received = fromStripeAmount(intent.amount_received, intent.currency);
  if (amount === undefined || received === undefined || amount !== order.totalAmount || intent.currency.toUpperCase() !== order.currency
    || intent.metadata[STRIPE_ORDER_METADATA.orderId] !== order.id || intent.livemode !== liveMode
    || order.stripePaymentIntentId !== undefined && intent.id !== order.stripePaymentIntentId
    || intent.amount_received > intent.amount
    || intent.status === C.provider.succeeded && received !== order.totalAmount) {
    throw new ServiceUnavailableException(C.failure.invalid);
  }
  let state: CustomerPaymentStatus['state'];
  if (order.status !== ORDER_STATUS.pendingPayment) state = C.state.orderUpdated;
  else if (intent.status === C.provider.succeeded) state = C.state.confirming;
  else if (intent.status === C.provider.processing) state = C.state.processing;
  else if (intent.amount_received > C.limits.zero) state = C.state.review;
  else if (intent.status === C.provider.cancelled) state = C.state.closed;
  else if (intent.capture_method === C.provider.manual
    || intent.confirmation_method === C.provider.manual || intent.status === C.provider.capture) state = C.state.review;
  else if (intent.status === C.provider.action) state = C.state.action;
  else state = intent.status === C.provider.method && intent.last_payment_error !== null ? C.state.failed : C.state.ready;
  const payment = customerPaymentDocument({...order, stripePaymentIntentId: intent.id}, state, liveMode);
  return {payment, clientSecret: intent.client_secret};
}

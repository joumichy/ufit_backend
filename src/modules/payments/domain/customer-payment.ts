import {z} from 'zod';
import {CURRENCY_CODES} from '../../../shared/domain/currencies';
import {ORDER_STATUS} from '../../orders/domain/order-lifecycle';

export const CUSTOMER_PAYMENT = {
  route: {status: ':id/payment-status'},
  state: {notStarted: 'not_started', ready: 'ready', failed: 'failed', action: 'requires_action', processing: 'processing',
    confirming: 'awaiting_confirmation', closed: 'closed', review: 'review', orderUpdated: 'order_updated'},
  provider: {method: 'requires_payment_method', confirmation: 'requires_confirmation', action: 'requires_action',
    processing: 'processing', capture: 'requires_capture', succeeded: 'succeeded', cancelled: 'canceled',
    automatic: 'automatic', asynchronous: 'automatic_async', manual: 'manual', card: 'card',
    intentPattern: /^pi_[A-Za-z0-9]+$/, secretSeparator: '_secret_', groupPrefix: 'order:', keyPrefix: 'payment-intent:'},
  cache: {header: 'Cache-Control', value: 'private, no-store'},
  limits: {zero: 0, one: 1, maximum: 2_147_483_647},
  failure: {
    unavailable: {code: 'customer_payment_unavailable', message: 'The payment status cannot be verified right now'},
    invalid: {code: 'customer_payment_invalid', message: 'The payment does not match the stored order'},
  },
} as const;
const C = CUSTOMER_PAYMENT;
const states = z.enum(Object.values(C.state));
const id = z.string().regex(C.provider.intentPattern);
const amount = z.number().int().min(C.limits.one).max(C.limits.maximum);
export const customerPaymentStatusSchema = z.object({
  orderId: z.uuid(), orderStatus: z.enum(Object.values(ORDER_STATUS)), amount,
  currency: z.enum(CURRENCY_CODES), observedAt: z.iso.datetime(),
  state: states, paymentIntentId: id.nullable(), liveMode: z.boolean().nullable(),
}).strict().refine(value =>
  (value.orderStatus !== ORDER_STATUS.pendingPayment) === (value.state === C.state.orderUpdated)
  && (value.paymentIntentId !== null || value.liveMode === null)
  && (value.state === C.state.notStarted ? value.paymentIntentId === null && value.liveMode === null
    : value.state === C.state.orderUpdated || value.paymentIntentId !== null && value.liveMode !== null));
export type CustomerPaymentStatus = z.infer<typeof customerPaymentStatusSchema>;
export const customerPaymentResumable = (state: CustomerPaymentStatus['state']) =>
  state === C.state.notStarted || state === C.state.ready || state === C.state.failed || state === C.state.action;
export const customerPaymentSessionSchema = z.object({
  payment: customerPaymentStatusSchema, clientSecret: z.string().nullable(),
}).strict().refine(value => {
  const payable = customerPaymentResumable(value.payment.state) && value.payment.state !== C.state.notStarted;
  return payable ? value.clientSecret !== null && value.payment.paymentIntentId !== null
    && value.clientSecret.startsWith(value.payment.paymentIntentId + C.provider.secretSeparator)
    && value.clientSecret.length > (value.payment.paymentIntentId + C.provider.secretSeparator).length
    : value.clientSecret === null;
});
export type CustomerPaymentSession = z.infer<typeof customerPaymentSessionSchema>;

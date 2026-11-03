import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {payments, paymentSettlementJobs} from '../../../shared/infrastructure/database/schema';
import {ORDER_PAYMENT} from '../../orders/domain/order-lifecycle';
import {PAYMENT_SETTLEMENT as C} from '../domain/payment-settlement';
import type {StripePaidPayment} from '../application/stripe-payment-finalizer';

export async function enqueuePaymentSettlement(database: DatabaseSession, paymentId: string): Promise<void> {
  await database.db.insert(paymentSettlementJobs).values({paymentId, status: C.state.queued, nextAttemptAt: new Date()})
    .onConflictDoNothing({target: paymentSettlementJobs.paymentId});
}
export async function recordStripeCapture(database: DatabaseSession, input: StripePaidPayment,
  status: typeof ORDER_PAYMENT.status[keyof typeof ORDER_PAYMENT.status] = ORDER_PAYMENT.status.succeeded): Promise<void> {
  const [payment] = await database.db.insert(payments).values({
    orderId: input.orderId, provider: ORDER_PAYMENT.provider, providerPaymentIntentId: input.paymentIntentId,
    status, amount: input.amount, currency: input.currency,
  }).returning({id: payments.id});
  await enqueuePaymentSettlement(database, payment.id);
}

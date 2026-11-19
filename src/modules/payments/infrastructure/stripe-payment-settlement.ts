import {fromStripeAmount} from './stripe-amount';
import type {StripePaymentsClient} from '../application/payments.service';
import {STRIPE_ORDER_METADATA} from '../application/stripe-commerce';
import {PAYMENT_SETTLEMENT as C, captureReceiptSchema, type CaptureReadResult, type SettlementPayment} from '../domain/payment-settlement';

export async function readStripePaymentSettlement(stripe: StripePaymentsClient, payment: SettlementPayment, liveMode: boolean): Promise<CaptureReadResult> {
  try {
    const intent = await stripe.paymentIntents.retrieve(payment.providerPaymentIntentId, {expand: [...C.provider.expansion]});
    if (intent.id !== payment.providerPaymentIntentId || intent.metadata?.[STRIPE_ORDER_METADATA.orderId] !== payment.orderId
      || intent.status !== C.provider.succeeded || fromStripeAmount(intent.amount_received, intent.currency) !== payment.amount
      || stripeCurrency(intent.currency) !== payment.currency || intent.livemode !== liveMode) return {kind: C.result.review, reason: C.failure.mismatch};
    const charge = intent.latest_charge;
    if (!charge || isProviderString(charge)) return {kind: C.result.review, reason: C.failure.invalid};
    if (charge.payment_intent !== intent.id || !charge.paid || !charge.captured || charge.status !== C.provider.succeeded
      || fromStripeAmount(charge.amount, charge.currency) !== payment.amount || fromStripeAmount(charge.amount_captured, charge.currency) !== payment.amount
      || stripeCurrency(charge.currency) !== payment.currency || charge.livemode !== liveMode) return {kind: C.result.review, reason: C.failure.mismatch};
    const balance = charge.balance_transaction;
    if (balance === null) return {kind: C.result.retry, reason: C.failure.balancePending};
    if (!balance || isProviderString(balance) || balance.source !== charge.id || balance.type !== C.provider.charge) return {kind: C.result.review, reason: C.failure.invalid};
    const receipt = captureReceiptSchema.safeParse({
      chargeId: charge.id, balanceTransactionId: balance.id, chargeAmount: fromStripeAmount(charge.amount, charge.currency), chargeCurrency: stripeCurrency(charge.currency),
      settlementAmount: fromStripeAmount(balance.amount, balance.currency), settlementCurrency: stripeCurrency(balance.currency), feeAmount: fromStripeAmount(balance.fee, balance.currency), netAmount: fromStripeAmount(balance.net, balance.currency),
      capturedAt: timestamp(charge.created), availableAt: timestamp(balance.available_on), liveMode: charge.livemode,
    });
    return receipt.success ? {kind: C.result.receipt, receipt: receipt.data} : {kind: C.result.review, reason: C.failure.invalid};
  } catch (error) {
    return (error as {code?: string}).code === C.provider.missing
      ? {kind: C.result.review, reason: C.failure.missing} : {kind: C.result.retry, reason: C.failure.unavailable};
  }
}
function timestamp(seconds: number): string | undefined {
  if (!Number.isSafeInteger(seconds) || seconds < C.limits.zero) return undefined;
  const date = new Date(seconds * C.limits.millisecondsPerSecond);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function isProviderString(value: unknown): value is string { return typeof value === C.provider.referenceType; }
function stripeCurrency(value: unknown): string | undefined { return isProviderString(value) ? value.toUpperCase() : undefined; }

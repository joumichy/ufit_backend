import {fromStripeAmount} from './stripe-amount';
import type {StripePaymentsClient} from '../application/payments.service';
import {STRIPE_ORDER_METADATA} from '../application/stripe-commerce';
import {REFUND_SETTLEMENT as C, refundSourceSchema, refundSnapshotSchema, refundBalanceSchema, type RefundSource, type RefundReadResult} from '../domain/refund-settlement';
import type Stripe from 'stripe';
import {PAYMENT_SETTLEMENT} from '../domain/payment-settlement';

export type RefundSettlementClient = Pick<StripePaymentsClient, 'refunds'> & Pick<InstanceType<typeof Stripe>, 'charges'>;
const options = {timeout: C.limits.timeoutMs, maxNetworkRetries: C.limits.zero};
const text = (value: unknown): value is string => typeof value === C.provider.referenceType;
const currency = (value: unknown): string | undefined => text(value) ? value.toUpperCase() : undefined;
function instant(seconds: unknown): string | undefined {
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < C.limits.zero) return undefined;
  const date = new Date(seconds * C.limits.millisecondsPerSecond);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
type Charge = Awaited<ReturnType<RefundSettlementClient['charges']['retrieve']>>;
function validCharge(charge: Charge, source: RefundSource): boolean {
  const capture = source.capture, balance = charge.balance_transaction;
  return charge.id === capture.chargeId && charge.payment_intent === source.paymentIntentId && charge.livemode === capture.liveMode
    && charge.metadata?.[STRIPE_ORDER_METADATA.orderId] === source.orderId && charge.paid && charge.captured && charge.status === C.provider.chargeSucceeded
    && fromStripeAmount(charge.amount, charge.currency) === capture.chargeAmount && fromStripeAmount(charge.amount_captured, charge.currency) === capture.chargeAmount && currency(charge.currency) === capture.chargeCurrency
    && instant(charge.created) === capture.capturedAt && balance !== null && !text(balance)
    && balance.id === capture.balanceTransactionId && balance.source === capture.chargeId && balance.type === PAYMENT_SETTLEMENT.provider.charge
    && fromStripeAmount(balance.amount, balance.currency) === capture.settlementAmount && fromStripeAmount(balance.fee, balance.currency) === capture.feeAmount && fromStripeAmount(balance.net, balance.currency) === capture.netAmount
    && currency(balance.currency) === capture.settlementCurrency && instant(balance.available_on) === capture.availableAt;
}
export async function readStripeRefundSettlement(stripe: RefundSettlementClient, raw: RefundSource, liveMode: boolean): Promise<RefundReadResult> {
  const parsed = refundSourceSchema.safeParse(raw);
  if (!parsed.success || parsed.data.capture.liveMode !== liveMode) return {kind: C.result.review, reason: C.failure.changed};
  const source = parsed.data;
  try {
    const before = await stripe.charges.retrieve(source.capture.chargeId, {expand: [...C.provider.chargeExpansion]}, options);
    if (!validCharge(before, source)) return {kind: C.result.review, reason: C.failure.changed};
    let cursor: string | undefined;
    const seen = new Set<string>(), items: unknown[] = [];
    do {
      const page = await stripe.refunds.list({charge: source.capture.chargeId, limit: C.limits.page,
        starting_after: cursor, expand: [...C.provider.refundExpansion]}, options);
      if (!Array.isArray(page.data) || typeof page.has_more !== 'boolean') return {kind: C.result.review, reason: C.failure.invalid};
      for (const refund of page.data) {
        if (refund.object !== C.provider.refundObject || !text(refund.id) || seen.has(refund.id)
          || refund.charge !== source.capture.chargeId || refund.payment_intent !== source.paymentIntentId) return {kind: C.result.review, reason: C.failure.invalid};
        seen.add(refund.id);
        // Stripe omits this optional field until failure; the internal contract uses explicit null.
        const failure = refund.failure_balance_transaction === undefined ? null : refund.failure_balance_transaction;
        const balances = [refund.balance_transaction, failure].map(value => {
          if (value === null) return null;
          if (!value || text(value) || value.source !== refund.id) return undefined;
          const result = refundBalanceSchema.safeParse({id: value.id, refundId: refund.id, kind: value.type, amount: fromStripeAmount(value.amount, value.currency), currency: currency(value.currency),
            feeAmount: fromStripeAmount(value.fee, value.currency), netAmount: fromStripeAmount(value.net, value.currency), createdAt: instant(value.created), availableAt: instant(value.available_on)});
          return result.success ? result.data : undefined;
        });
        if (balances.some(value => value === undefined)) return {kind: C.result.review, reason: C.failure.invalid};
        items.push({refundId: refund.id, amount: fromStripeAmount(refund.amount, refund.currency), currency: currency(refund.currency), status: refund.status,
          createdAt: instant(refund.created), debit: balances[C.limits.zero], failure: balances[C.limits.one]});
      }
      const last = page.data.at(-C.limits.one)?.id;
      if (page.has_more && (!last || last === cursor)) return {kind: C.result.review, reason: C.failure.invalid};
      cursor = page.has_more ? last : undefined;
    } while (cursor !== undefined);
    // Never call a multi-page read current if the charge changed while it was being enumerated.
    const after = await stripe.charges.retrieve(source.capture.chargeId, {expand: [...C.provider.chargeExpansion]}, options);
    if (!validCharge(after, source)) return {kind: C.result.review, reason: C.failure.changed};
    if (after.amount_refunded !== before.amount_refunded || after.disputed !== before.disputed) return {kind: C.result.retry, reason: C.failure.changed};
    const snapshot = refundSnapshotSchema.safeParse({source, observedAt: new Date().toISOString(), amountRefunded: fromStripeAmount(after.amount_refunded, after.currency),
      disputed: after.disputed, items});
    return snapshot.success ? {kind: C.result.observed, snapshot: snapshot.data} : {kind: C.result.review, reason: C.failure.invalid};
  } catch (error) {
    return (error as {code?: string}).code === C.provider.missing ? {kind: C.result.review, reason: C.failure.missing}
      : {kind: C.result.retry, reason: C.failure.unavailable};
  }
}

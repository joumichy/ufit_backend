import {fromStripeAmount, toStripeAmount} from './stripe-amount';
import {ConflictException} from '@nestjs/common';
import type {StripePaymentsClient} from '../application/payments.service';
import {STRIPE_COMMERCE, STRIPE_ORDER_METADATA, STRIPE_PAYMENT_STATE} from '../application/stripe-commerce';
import {ORDER_RETURN} from '../../orders/domain/order-return.contract';
import {RETURN_REFUND, type ReturnRefundClaim, type ReturnRefundProviderStatus, type ReturnRefundResult} from '../../orders/domain/return-refund';

export const STRIPE_RETURN = {
  metadata: {returnId: 'return_id', attemptId: 'return_refund_attempt_id'},
  idempotencyPrefix: 'return-refund:',
  maximumAttemptMatches: 1,
} as const;
type ReturnStripeClient = Pick<StripePaymentsClient, 'paymentIntents' | 'refunds'>;
export async function refundStripeReturn(stripe: ReturnStripeClient, claim: ReturnRefundClaim): Promise<ReturnRefundResult> {
  if (!Number.isSafeInteger(claim.originalAmount) || !Number.isSafeInteger(claim.amount) || claim.amount < ORDER_RETURN.amount.zero || claim.amount > claim.originalAmount || claim.originalAmount > ORDER_RETURN.amount.maximum || (claim.amount === ORDER_RETURN.amount.zero && claim.refundId !== null)) throw new ConflictException(RETURN_REFUND.failure.mismatch);
  const intent = await stripe.paymentIntents.retrieve(claim.paymentIntentId);
  if (intent.id !== claim.paymentIntentId || intent.metadata[STRIPE_ORDER_METADATA.orderId] !== claim.orderId || fromStripeAmount(intent.amount, intent.currency) !== claim.originalAmount || intent.currency.toUpperCase() !== claim.currency) throw new ConflictException(RETURN_REFUND.failure.mismatch);
  if (intent.status !== STRIPE_PAYMENT_STATE.succeeded || fromStripeAmount(intent.amount_received, intent.currency) !== claim.originalAmount) throw new ConflictException(RETURN_REFUND.failure.unavailable);
  if (claim.amount === ORDER_RETURN.amount.zero) return {state: RETURN_REFUND.state.succeeded, refundId: null, providerStatus: null};
  type Refund = Awaited<ReturnType<ReturnStripeClient['refunds']['list']>>['data'][number];
  let refund: Refund | undefined = claim.refundId ? await stripe.refunds.retrieve(claim.refundId) : undefined;
  if (!refund) {
    let cursor: string | undefined;
    let originalMethodFailed = false;
    do {
      const page = await stripe.refunds.list({payment_intent: intent.id, limit: STRIPE_COMMERCE.pageLimit, starting_after: cursor});
      originalMethodFailed ||= page.data.some(candidate => candidate.status === RETURN_REFUND.providerStatus.failed);
      const matches = page.data.filter(candidate => candidate.metadata?.[STRIPE_RETURN.metadata.returnId] === claim.returnId && candidate.metadata?.[STRIPE_RETURN.metadata.attemptId] === claim.attemptId);
      if (matches.length > STRIPE_RETURN.maximumAttemptMatches || (refund && matches.length > ORDER_RETURN.amount.zero)) throw new ConflictException(RETURN_REFUND.failure.mismatch);
      if (matches.length) refund = matches.at(ORDER_RETURN.limit.firstRow);
      const next = page.has_more ? page.data.at(STRIPE_COMMERCE.lastIndex)?.id : undefined;
      if (page.has_more && (!next || next === cursor)) throw new ConflictException(RETURN_REFUND.failure.mismatch);
      cursor = next;
    } while (cursor);
    // Stripe requires an alternative refund route after failure; do not leave
    // a new durable attempt endlessly retrying a request the provider refuses.
    if (!refund && originalMethodFailed) return {state: RETURN_REFUND.state.blocked, refundId: null, providerStatus: null};
  }
  refund ??= await stripe.refunds.create({payment_intent: intent.id, amount: toStripeAmount(claim.amount, claim.currency), reason: STRIPE_COMMERCE.cancellationReason,
    metadata: {[STRIPE_ORDER_METADATA.orderId]: claim.orderId, [STRIPE_RETURN.metadata.returnId]: claim.returnId, [STRIPE_RETURN.metadata.attemptId]: claim.attemptId}},
  {idempotencyKey: STRIPE_RETURN.idempotencyPrefix + claim.attemptId});
  const paymentIntentId = typeof refund.payment_intent === 'string' ? refund.payment_intent : refund.payment_intent?.id;
  if ((claim.refundId !== null && refund.id !== claim.refundId) || paymentIntentId !== claim.paymentIntentId || fromStripeAmount(refund.amount, refund.currency) !== claim.amount || refund.currency.toUpperCase() !== claim.currency || refund.metadata?.[STRIPE_ORDER_METADATA.orderId] !== claim.orderId || refund.metadata?.[STRIPE_RETURN.metadata.returnId] !== claim.returnId || refund.metadata?.[STRIPE_RETURN.metadata.attemptId] !== claim.attemptId) throw new ConflictException(RETURN_REFUND.failure.mismatch);
  const providerStatus = refund.status as ReturnRefundProviderStatus | null;
  let state: ReturnRefundResult['state'];
  switch (providerStatus) {
    case RETURN_REFUND.providerStatus.succeeded: state = RETURN_REFUND.state.succeeded; break;
    case RETURN_REFUND.providerStatus.failed: case RETURN_REFUND.providerStatus.cancelled: state = RETURN_REFUND.state.failed; break;
    case RETURN_REFUND.providerStatus.pending: case RETURN_REFUND.providerStatus.requiresAction: state = RETURN_REFUND.state.pending; break;
    default: throw new ConflictException(RETURN_REFUND.failure.unknown);
  }
  return {state, refundId: refund.id, providerStatus};
}

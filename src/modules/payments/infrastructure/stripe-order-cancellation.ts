import {ConflictException} from '@nestjs/common';
import {
  CANCELLATION, CANCELLATION_REFUND, ORDER_LIMIT,
  type CancellationClaim, type CancellationSettlement, type CancellationRefundAttempt,
  type CancellationRefundResult, type CancellationProviderStatus,
} from '../../orders/domain/order-lifecycle';
import type {StripePaymentsClient} from '../application/payments.service';
import {
  STRIPE_COMMERCE, STRIPE_ORDER_METADATA, STRIPE_PAYMENT_STATE,
  stripeCancellationKey, stripeCancellationRefundKey,
} from '../application/stripe-commerce';

export interface StripeCancellationResult {
  settlement?: CancellationSettlement;
  refund?: {attempt: CancellationRefundAttempt; result: CancellationRefundResult};
}
type CancellationStripeClient = Pick<StripePaymentsClient, 'paymentIntents' | 'refunds'>;
type Intent = Awaited<ReturnType<CancellationStripeClient['paymentIntents']['retrieve']>>;
function assertIntent(intent: Intent, claim: CancellationClaim): void {
  if (intent.id !== claim.paymentIntentId || intent.metadata[STRIPE_ORDER_METADATA.orderId] !== claim.orderId
    || intent.amount !== claim.amount || intent.currency.toUpperCase() !== claim.currency)
    throw new ConflictException(STRIPE_COMMERCE.mismatch);
}
export async function reverseStripeCancellation(
  stripe: CancellationStripeClient, claim: CancellationClaim,
  prepareRefund: () => Promise<CancellationRefundAttempt>,
): Promise<StripeCancellationResult> {
  if (!Number.isSafeInteger(claim.amount) || claim.amount <= STRIPE_COMMERCE.zero)
    throw new ConflictException(STRIPE_COMMERCE.mismatch);
  if (!claim.paymentIntentId) return {settlement: {outcome: CANCELLATION.outcome.notCharged}};
  let intent = await stripe.paymentIntents.retrieve(claim.paymentIntentId);
  assertIntent(intent, claim);
  if (intent.status === STRIPE_PAYMENT_STATE.processing) return {};
  if (intent.status !== STRIPE_PAYMENT_STATE.succeeded && intent.status !== STRIPE_PAYMENT_STATE.cancelled) {
    try {
      intent = await stripe.paymentIntents.cancel(intent.id, {cancellation_reason: STRIPE_COMMERCE.cancellationReason},
        {idempotencyKey: stripeCancellationKey(claim.id)});
    } catch (error) {
      // A card can succeed between retrieval and cancellation. Revalidate this second fact too.
      intent = await stripe.paymentIntents.retrieve(claim.paymentIntentId);
      assertIntent(intent, claim);
      if (intent.status !== STRIPE_PAYMENT_STATE.succeeded && intent.status !== STRIPE_PAYMENT_STATE.cancelled) throw error;
    }
    assertIntent(intent, claim);
  }
  if (intent.status === STRIPE_PAYMENT_STATE.cancelled) {
    if (intent.amount_received !== STRIPE_COMMERCE.zero) throw new ConflictException(STRIPE_COMMERCE.mismatch);
    return {settlement: {outcome: CANCELLATION.outcome.notCharged}};
  }
  if (intent.status !== STRIPE_PAYMENT_STATE.succeeded || intent.amount_received !== claim.amount)
    throw new ConflictException(STRIPE_COMMERCE.mismatch);
  const attempt = await prepareRefund();
  if (attempt.cancellationId !== claim.id || attempt.paymentIntentId !== claim.paymentIntentId
    || attempt.amount !== claim.amount || attempt.currency !== claim.currency) throw new ConflictException(CANCELLATION_REFUND.failure.mismatch);
  type Refund = Awaited<ReturnType<CancellationStripeClient['refunds']['list']>>['data'][number];
  let refund: Refund | undefined = attempt.refundId ? await stripe.refunds.retrieve(attempt.refundId) : undefined;
  if (!refund) {
    let cursor: string | undefined;
    let originalMethodFailed = false;
    do {
      const page = await stripe.refunds.list({payment_intent: intent.id, limit: STRIPE_COMMERCE.pageLimit, starting_after: cursor});
      originalMethodFailed ||= page.data.some(candidate => candidate.status === CANCELLATION_REFUND.providerStatus.failed);
      const matches = page.data.filter(candidate => candidate.metadata?.[STRIPE_ORDER_METADATA.cancellationId] === claim.id
        && candidate.metadata?.[STRIPE_ORDER_METADATA.cancellationAttemptId] === attempt.id);
      if (matches.length > CANCELLATION_REFUND.attempt.maximumMatches || (refund && matches.length > STRIPE_COMMERCE.zero))
        throw new ConflictException(CANCELLATION_REFUND.failure.mismatch);
      if (matches.length) refund = matches.at(ORDER_LIMIT.firstRow);
      const next = page.has_more ? page.data.at(STRIPE_COMMERCE.lastIndex)?.id : undefined;
      if (page.has_more && (!next || next === cursor)) throw new ConflictException(CANCELLATION_REFUND.failure.mismatch);
      cursor = next;
    } while (cursor);
    if (!refund && originalMethodFailed) return {refund: {attempt, result: {state: CANCELLATION_REFUND.state.blocked, refundId: null, providerStatus: null}}};
  }
  refund ??= await stripe.refunds.create({payment_intent: intent.id, amount: claim.amount,
    ...(claim.reason === CANCELLATION.reason.customer ? {reason: STRIPE_COMMERCE.cancellationReason} : {}),
    metadata: {[STRIPE_ORDER_METADATA.orderId]: claim.orderId, [STRIPE_ORDER_METADATA.cancellationId]: claim.id,
      [STRIPE_ORDER_METADATA.cancellationAttemptId]: attempt.id}}, {idempotencyKey: stripeCancellationRefundKey(attempt.id)});
  const intentID = typeof refund.payment_intent === 'string' ? refund.payment_intent : refund.payment_intent?.id;
  if ((attempt.refundId !== null && refund.id !== attempt.refundId) || intentID !== claim.paymentIntentId
    || refund.amount !== claim.amount || refund.currency.toUpperCase() !== claim.currency
    || refund.metadata?.[STRIPE_ORDER_METADATA.orderId] !== claim.orderId
    || refund.metadata?.[STRIPE_ORDER_METADATA.cancellationId] !== claim.id
    || refund.metadata?.[STRIPE_ORDER_METADATA.cancellationAttemptId] !== attempt.id)
    throw new ConflictException(CANCELLATION_REFUND.failure.mismatch);
  const providerStatus = refund.status as CancellationProviderStatus | null;
  let state: CancellationRefundResult['state'];
  switch (providerStatus) {
    case CANCELLATION_REFUND.providerStatus.succeeded: state = CANCELLATION_REFUND.state.succeeded; break;
    case CANCELLATION_REFUND.providerStatus.failed: case CANCELLATION_REFUND.providerStatus.cancelled: state = CANCELLATION_REFUND.state.failed; break;
    case CANCELLATION_REFUND.providerStatus.pending: case CANCELLATION_REFUND.providerStatus.requiresAction: state = CANCELLATION_REFUND.state.pending; break;
    default: throw new ConflictException(CANCELLATION_REFUND.failure.unknown);
  }
  return {refund: {attempt, result: {state, refundId: refund.id, providerStatus}}};
}

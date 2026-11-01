import { ConflictException } from "@nestjs/common";
import {
  CANCELLATION,
  type CancellationClaim,
  type CancellationSettlement,
} from "../../orders/domain/order-lifecycle";
import type { StripePaymentsClient } from "../application/payments.service";
import {
  STRIPE_COMMERCE,
  STRIPE_ORDER_METADATA,
  STRIPE_PAYMENT_STATE,
  STRIPE_REFUND_STATE,
  stripeCancellationKey,
  stripeCancellationRefundKey,
} from "../application/stripe-commerce";

export interface StripeCancellationResult {
  refundId?: string;
  settlement?: CancellationSettlement;
}
export async function reverseStripeCancellation(
  stripe: StripePaymentsClient,
  claim: CancellationClaim,
): Promise<StripeCancellationResult> {
  if (!claim.paymentIntentId)
    return { settlement: { outcome: CANCELLATION.outcome.notCharged } };
  let intent = await stripe.paymentIntents.retrieve(claim.paymentIntentId);
  if (
    intent.metadata[STRIPE_ORDER_METADATA.orderId] !== claim.orderId ||
    intent.amount !== claim.amount ||
    intent.currency.toUpperCase() !== claim.currency
  )
    throw new ConflictException(STRIPE_COMMERCE.mismatch);
  if (intent.status === STRIPE_PAYMENT_STATE.cancelled)
    return { settlement: { outcome: CANCELLATION.outcome.notCharged } };
  if (intent.status === STRIPE_PAYMENT_STATE.processing) return {};
  if (intent.status !== STRIPE_PAYMENT_STATE.succeeded) {
    try {
      intent = await stripe.paymentIntents.cancel(
        intent.id,
        { cancellation_reason: STRIPE_COMMERCE.cancellationReason },
        { idempotencyKey: stripeCancellationKey(claim.id) },
      );
    } catch (error) {
      // A card can succeed between our first retrieval and cancellation.
      intent = await stripe.paymentIntents.retrieve(intent.id);
      if (
        intent.status !== STRIPE_PAYMENT_STATE.succeeded &&
        intent.status !== STRIPE_PAYMENT_STATE.cancelled
      )
        throw error;
    }
    if (intent.status === STRIPE_PAYMENT_STATE.cancelled)
      return { settlement: { outcome: CANCELLATION.outcome.notCharged } };
  }
  type CancellationRefund = Awaited<
    ReturnType<StripePaymentsClient["refunds"]["list"]>
  >["data"][number];
  let refund: CancellationRefund | undefined = claim.refundId
    ? await stripe.refunds.retrieve(claim.refundId)
    : undefined;
  if (!refund) {
    let after: string | undefined;
    do {
      const page = await stripe.refunds.list({
        payment_intent: intent.id,
        limit: STRIPE_COMMERCE.pageLimit,
        starting_after: after,
      });
      refund = page.data.find(
        (candidate) =>
          candidate.metadata?.[STRIPE_ORDER_METADATA.cancellationId] ===
          claim.id,
      );
      after = page.has_more
        ? page.data.at(STRIPE_COMMERCE.lastIndex)?.id
        : undefined;
    } while (!refund && after);
  }
  refund ??= await stripe.refunds.create(
    {
      payment_intent: intent.id,
      amount: claim.amount,
      ...(claim.reason === CANCELLATION.reason.customer
        ? { reason: STRIPE_COMMERCE.cancellationReason }
        : {}),
      metadata: {
        [STRIPE_ORDER_METADATA.orderId]: claim.orderId,
        [STRIPE_ORDER_METADATA.cancellationId]: claim.id,
      },
    },
    { idempotencyKey: stripeCancellationRefundKey(claim.id) },
  );
  if (
    refund.amount !== claim.amount ||
    refund.currency.toUpperCase() !== claim.currency ||
    refund.metadata?.[STRIPE_ORDER_METADATA.cancellationId] !== claim.id
  )
    throw new ConflictException(STRIPE_COMMERCE.mismatch);
  if (
    refund.status === STRIPE_REFUND_STATE.failed ||
    refund.status === STRIPE_REFUND_STATE.cancelled
  )
    throw new ConflictException(STRIPE_COMMERCE.refundFailure);
  return {
    refundId: refund.id,
    settlement:
      refund.status === STRIPE_REFUND_STATE.succeeded
        ? { outcome: CANCELLATION.outcome.refunded, refundId: refund.id }
        : undefined,
  };
}

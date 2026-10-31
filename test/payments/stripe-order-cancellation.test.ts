import { describe, expect, it, vi } from "vitest";
import { reverseStripeCancellation } from "../../src/modules/payments/infrastructure/stripe-order-cancellation";
import {
  CANCELLATION,
  ORDER_STATUS,
  type CancellationClaim,
} from "../../src/modules/orders/domain/order-lifecycle";
import {
  STRIPE_COMMERCE,
  STRIPE_ORDER_METADATA,
  STRIPE_PAYMENT_STATE,
  STRIPE_REFUND_STATE,
  stripeCancellationKey,
  stripeCancellationRefundKey,
} from "../../src/modules/payments/application/stripe-commerce";
const fixture = {
  claim: {
    id: "cancellation",
    orderId: "order",
    originalStatus: ORDER_STATUS.paid,
    reason: CANCELLATION.reason.customer,
    status: CANCELLATION.status.requested,
    amount: 13790,
    currency: "CHF",
    paymentIntentId: "pi_qualification",
  } as CancellationClaim,
  refund: {
    id: "re_qualification",
    amount: 13790,
    currency: "chf",
    metadata: { cancellation_id: "cancellation" },
    status: STRIPE_REFUND_STATE.succeeded,
  },
  intent: {
    id: "pi_qualification",
    amount: 13790,
    currency: "chf",
    metadata: { order_id: "order" },
    status: STRIPE_PAYMENT_STATE.succeeded,
  },
};
function setup() {
  return {
    paymentIntents: {
      retrieve: vi.fn().mockResolvedValue(fixture.intent),
      cancel: vi.fn().mockResolvedValue({
        ...fixture.intent,
        status: STRIPE_PAYMENT_STATE.cancelled,
      }),
    },
    refunds: {
      list: vi.fn().mockResolvedValue({ data: [], has_more: false }),
      create: vi.fn().mockResolvedValue(fixture.refund),
      retrieve: vi.fn().mockResolvedValue(fixture.refund),
    },
  };
}
describe("Stripe order cancellation", () => {
  it("cancels an uncharged intent without creating a refund", async () => {
    const stripe = setup();
    stripe.paymentIntents.retrieve.mockResolvedValue({
      ...fixture.intent,
      status: "requires_payment_method",
    });
    const result = await reverseStripeCancellation(
      stripe as never,
      fixture.claim,
    );
    expect(result.settlement?.outcome).toBe(CANCELLATION.outcome.notCharged);
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith(
      fixture.claim.paymentIntentId,
      { cancellation_reason: STRIPE_COMMERCE.cancellationReason },
      { idempotencyKey: stripeCancellationKey(fixture.claim.id) },
    );
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });
  it("refunds exactly the captured order amount with stable metadata and idempotency", async () => {
    const stripe = setup();
    const result = await reverseStripeCancellation(
      stripe as never,
      fixture.claim,
    );
    expect(result.settlement).toEqual({
      outcome: CANCELLATION.outcome.refunded,
      refundId: fixture.refund.id,
    });
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      {
        payment_intent: fixture.claim.paymentIntentId,
        amount: fixture.claim.amount,
        reason: STRIPE_COMMERCE.cancellationReason,
        metadata: {
          [STRIPE_ORDER_METADATA.orderId]: fixture.claim.orderId,
          [STRIPE_ORDER_METADATA.cancellationId]: fixture.claim.id,
        },
      },
      { idempotencyKey: stripeCancellationRefundKey(fixture.claim.id) },
    );
  });
  it("recovers a succeeded payment that raced with the cancellation request", async () => {
    const stripe = setup();
    stripe.paymentIntents.retrieve.mockResolvedValueOnce({
      ...fixture.intent,
      status: "requires_payment_method",
    });
    stripe.paymentIntents.cancel.mockRejectedValueOnce(
      new Error("payment already succeeded"),
    );
    expect(
      (await reverseStripeCancellation(stripe as never, fixture.claim))
        .settlement?.outcome,
    ).toBe(CANCELLATION.outcome.refunded);
  });
  it("finds an existing refund after the network lost its response", async () => {
    const stripe = setup();
    stripe.refunds.list.mockResolvedValue({
      data: [fixture.refund],
      has_more: false,
    });
    await reverseStripeCancellation(stripe as never, fixture.claim);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });
  it("does not complete a pending refund and retrieves it on retry", async () => {
    const stripe = setup();
    stripe.refunds.retrieve.mockResolvedValue({
      ...fixture.refund,
      status: "pending",
    });
    const result = await reverseStripeCancellation(stripe as never, {
      ...fixture.claim,
      refundId: fixture.refund.id,
    });
    expect(result.refundId).toBe(fixture.refund.id);
    expect(result.settlement).toBeUndefined();
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });
  it("rejects an intent belonging to a different order", async () => {
    const stripe = setup();
    stripe.paymentIntents.retrieve.mockResolvedValue({
      ...fixture.intent,
      metadata: { order_id: "different" },
    });
    await expect(
      reverseStripeCancellation(stripe as never, fixture.claim),
    ).rejects.toMatchObject({ status: 409 });
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });
  it("refunds an unavailable paid order without labeling it a customer-requested refund", async () => {
    const stripe = setup();
    await reverseStripeCancellation(stripe as never, {
      ...fixture.claim,
      reason: CANCELLATION.reason.stockUnavailable,
    });
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      {
        payment_intent: fixture.intent.id,
        amount: fixture.claim.amount,
        metadata: {
          [STRIPE_ORDER_METADATA.orderId]: fixture.claim.orderId,
          [STRIPE_ORDER_METADATA.cancellationId]: fixture.claim.id,
        },
      },
      { idempotencyKey: stripeCancellationRefundKey(fixture.claim.id) },
    );
  });
});

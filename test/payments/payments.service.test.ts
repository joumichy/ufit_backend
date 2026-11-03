import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "../../src/config/env";
import { PaymentsService } from "../../src/modules/payments/application/payments.service";
import type { Order } from "../../src/modules/orders/application/orders.service";
function makeOrder(): Order {
  return {
    id: "order-1",
    orderNumber: "UF-1",
    customerId: "customer-1",
    brandId: "brand-1",
    status: "pending_payment",
    createdAt: "2026-10-31T12:00:00.000Z",
    actions: { cancel: true, resumePayment: true },
    taxAmount: 0,
    subtotalAmount: 5000,
    shippingAmount: 900,
    totalAmount: 5900,
    currency: "CHF",
    shippingAddress: {
      fullName: "A Customer",
      line1: "1 Test Street",
      postalCode: "8000",
      city: "Zurich",
      country: "CH",
    },
    paymentProvider: "stripe",
    items: [
      {
        id: "item-1",
        productId: "product-1",
        productVariantId: "variant-1",
        productSnapshot: { name: "Wool Coat" },
        quantity: 1,
        unitPrice: 5000,
        totalPrice: 5000,
        commissionRate: 0.12,
      },
    ],
  };
}

describe("PaymentsService", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_DIRECT_CONNECTION_DB_URL:
        "postgres://user:pass@localhost:5432/postgres",
      STRIPE_SECRET_KEY: "sk_test_mock",
      STRIPE_WEBHOOK_SECRET: "whsec_mock",
    };
    resetEnvCacheForTests();
  });
  afterEach(() => {
    process.env = originalEnv;
    resetEnvCacheForTests();
  });
  function setup() {
    const stripe = {
      paymentIntents: {
        create: vi.fn().mockResolvedValue({
          id: "pi_test",
          client_secret: "test_client_secret",
        }),
        retrieve: vi.fn().mockResolvedValue({
          id: "pi_test",
          client_secret: "test_client_secret",
        }),
      },
      webhooks: { constructEvent: vi.fn() },
      refunds: {retrieve: vi.fn()},
    };
    const finalizer = {
      confirm: vi
        .fn()
        .mockResolvedValue({ duplicate: false, reversalRequired: false }),
    };
    const orders = { attachPaymentIntent: vi.fn() };
    const cancellations = { recoverOrder: vi.fn(), reconcile: vi.fn().mockResolvedValue(true) };
    const connect = { assertSaleRecipients: vi.fn(), accountUpdated: vi.fn() };
    const returnRefunds = {reconcile: vi.fn().mockResolvedValue(true)};
    return {
      stripe,
      finalizer,
      orders,
      cancellations,
      connect,
      returnRefunds,
      service: new PaymentsService(
        stripe as never,
        finalizer,
        orders as never,
        cancellations as never,
        connect as never,
        returnRefunds as never,
      ),
    };
  }
  it("creates a card-only PaymentIntent from the persisted total, with a stable idempotency key", async () => {
    const { service, stripe, orders } = setup();
    const result = await service.createPaymentIntent(makeOrder());
    expect(result).toMatchObject({
      orderId: "order-1",
      paymentIntentId: "pi_test",
    });
    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
      {
        amount: 5900,
        currency: "chf",
        payment_method_types: ["card"],
        metadata: { order_id: "order-1" },
        transfer_group: "order:order-1",
      },
      { idempotencyKey: "payment-intent:order-1" },
    );
    expect(orders.attachPaymentIntent).toHaveBeenCalledWith(
      "order-1",
      "pi_test",
    );
  });
  it("retrieves an attached intent on retry", async () => {
    const { service, stripe } = setup();
    await service.createPaymentIntent({
      ...makeOrder(),
      stripePaymentIntentId: "pi_test",
    });
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledWith("pi_test");
  });
  it("requires a configured secret, raw body and valid signature before fulfillment", async () => {
    const { service, stripe, finalizer } = setup();
    await expect(
      service.handleStripeWebhook(Buffer.from("{}")),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      service.handleStripeWebhook({}, "signature"),
    ).rejects.toMatchObject({ status: 400 });
    stripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error("signature");
    });
    await expect(
      service.handleStripeWebhook(Buffer.from("{}"), "invalid"),
    ).rejects.toMatchObject({ status: 401 });
    expect(finalizer.confirm).not.toHaveBeenCalled();
    process.env.STRIPE_WEBHOOK_SECRET = "";
    resetEnvCacheForTests();
    await expect(
      service.handleStripeWebhook(Buffer.from("{}"), "signature"),
    ).rejects.toMatchObject({ status: 503 });
  });
  it("passes only a verified succeeded PaymentIntent to transactional fulfillment", async () => {
    const { service, stripe, finalizer } = setup();
    stripe.webhooks.constructEvent.mockReturnValue({
      id: "evt_test",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_test",
          metadata: { order_id: "order-1" },
          amount_received: 5900,
          currency: "chf",
        },
      },
    });
    await expect(
      service.handleStripeWebhook(Buffer.from("{}"), "signature"),
    ).resolves.toEqual({ received: true, duplicate: false });
    expect(finalizer.confirm).toHaveBeenCalledWith({
      eventId: "evt_test",
      orderId: "order-1",
      paymentIntentId: "pi_test",
      amount: 5900,
      currency: "CHF",
    });
  });
  it("allows Stripe to retry a failed fulfillment", async () => {
    const { service, stripe, finalizer } = setup();
    stripe.webhooks.constructEvent.mockReturnValue({
      id: "evt_test",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_test",
          metadata: { order_id: "order-1" },
          amount_received: 5900,
          currency: "chf",
        },
      },
    });
    finalizer.confirm.mockRejectedValueOnce(
      new Error("transient database failure"),
    );
    await expect(
      service.handleStripeWebhook(Buffer.from("{}"), "signature"),
    ).rejects.toThrow("transient");
    await expect(
      service.handleStripeWebhook(Buffer.from("{}"), "signature"),
    ).resolves.toMatchObject({ received: true });
    expect(finalizer.confirm).toHaveBeenCalledTimes(2);
  });
  it("does not use a Checkout Session event or a mobile return to confirm an order", async () => {
    const { service, stripe, finalizer } = setup();
    stripe.webhooks.constructEvent.mockReturnValue({
      id: "evt_session",
      type: "checkout.session.completed",
      data: { object: {} },
    });
    await service.handleStripeWebhook(Buffer.from("{}"), "signature");
    expect(finalizer.confirm).not.toHaveBeenCalled();
  });
  it("resumes durable compensation even when a signed successful event is replayed", async () => {
    const { service, stripe, finalizer, cancellations } = setup();
    stripe.webhooks.constructEvent.mockReturnValue({
      id: "evt_paid",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_test",
          metadata: { order_id: "order-1" },
          amount_received: 5900,
          currency: "chf",
        },
      },
    });
    finalizer.confirm.mockResolvedValue({
      duplicate: true,
      reversalRequired: true,
    });
    await expect(
      service.handleStripeWebhook(Buffer.from("signed payload"), "signature"),
    ).resolves.toEqual({ received: true, duplicate: true });
    expect(cancellations.recoverOrder).toHaveBeenCalledWith("order-1");
    cancellations.recoverOrder.mockRejectedValueOnce(
      new Error("Provider temporarily unavailable"),
    );
    await expect(
      service.handleStripeWebhook(Buffer.from("signed payload"), "signature"),
    ).rejects.toThrow("Provider temporarily unavailable");
  });
  it("does not prepare a payment for an unconfigured Connect recipient", async () => {
    const { service, stripe, connect } = setup();
    connect.assertSaleRecipients.mockRejectedValueOnce(
      new Error("Connect recipient incomplete"),
    );
    await expect(service.createPaymentIntent(makeOrder())).rejects.toThrow(
      "Connect recipient incomplete",
    );
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });
  it("synchronizes the owned connected account for a signed account.updated event", async () => {
    const { service, stripe, connect, finalizer } = setup();
    stripe.webhooks.constructEvent.mockReturnValue({
      type: "account.updated",
      livemode: false,
      data: { object: { id: "acct_recipient" } },
    });
    await service.handleStripeWebhook(
      Buffer.from("signed payload"),
      "signature",
    );
    expect(connect.accountUpdated).toHaveBeenCalledWith(
      "acct_recipient",
      false,
    );
    expect(finalizer.confirm).not.toHaveBeenCalled();
  });
  const refundFixture = {
    orderId: 'fa331043-2215-452c-bade-a3d3292574b1', returnId: 'db73c31b-4936-4ce9-9f34-ea47a53fae09',
    attemptId: 'ecbc06d5-d7a0-44ea-a5b1-01864ba9ce17', refundId: 're_owned_return',
    events: ['refund.created', 'refund.updated', 'refund.failed'], payload: 'signed refund payload', signature: 'signature',
    metadata: {order: 'order_id', return: 'return_id', attempt: 'return_refund_attempt_id'},
  } as const;
  it('routes verified refund facts to the owned durable attempt and reports idempotent replay', async () => {
    for (const type of refundFixture.events) {
      const {service, stripe, returnRefunds, finalizer} = setup();
      stripe.webhooks.constructEvent.mockReturnValue({type, data: {object: {id: refundFixture.refundId, metadata: {
        [refundFixture.metadata.order]: refundFixture.orderId, [refundFixture.metadata.return]: refundFixture.returnId,
        [refundFixture.metadata.attempt]: refundFixture.attemptId,
      }}}});
      stripe.refunds.retrieve.mockResolvedValue(stripe.webhooks.constructEvent().data.object);
      const reference = {orderId: refundFixture.orderId, returnId: refundFixture.returnId, attemptId: refundFixture.attemptId, refundId: refundFixture.refundId};
      await expect(service.handleStripeWebhook(Buffer.from(refundFixture.payload), refundFixture.signature)).resolves.toEqual({received: true, duplicate: false});
      expect(returnRefunds.reconcile).toHaveBeenCalledWith(reference);
      returnRefunds.reconcile.mockResolvedValue(false);
      await expect(service.handleStripeWebhook(Buffer.from(refundFixture.payload), refundFixture.signature)).resolves.toEqual({received: true, duplicate: true});
      expect(finalizer.confirm).not.toHaveBeenCalled();
    }
  });
  it('ignores unmanaged refunds, rejects malformed managed ownership and lets provider recovery retry', async () => {
    const {service, stripe, returnRefunds} = setup();
    stripe.webhooks.constructEvent.mockReturnValue({type: refundFixture.events.at(-1), data: {object: {id: refundFixture.refundId, metadata: {}}}});
    stripe.refunds.retrieve.mockResolvedValue(stripe.webhooks.constructEvent().data.object);
    await service.handleStripeWebhook(Buffer.from(refundFixture.payload), refundFixture.signature);
    expect(returnRefunds.reconcile).not.toHaveBeenCalled();
    const metadata = {[refundFixture.metadata.return]: refundFixture.returnId};
    stripe.webhooks.constructEvent.mockReturnValue({type: refundFixture.events.at(-1), data: {object: {id: refundFixture.refundId, metadata}}});
    stripe.refunds.retrieve.mockResolvedValue(stripe.webhooks.constructEvent().data.object);
    await expect(service.handleStripeWebhook(Buffer.from(refundFixture.payload), refundFixture.signature)).rejects.toMatchObject({status: 400});
    expect(returnRefunds.reconcile).not.toHaveBeenCalled();
    Object.assign(metadata, {[refundFixture.metadata.order]: refundFixture.orderId, [refundFixture.metadata.attempt]: refundFixture.attemptId});
    const failure = new Error(refundFixture.payload);
    returnRefunds.reconcile.mockRejectedValueOnce(failure);
    await expect(service.handleStripeWebhook(Buffer.from(refundFixture.payload), refundFixture.signature)).rejects.toBe(failure);
  });
  it('routes a stale signed cancellation event using current provider metadata and rejects ambiguous ownership', async () => {
    const {service, stripe, cancellations, returnRefunds} = setup();
    const cancellationId = '2974d1c5-6c1f-4f5c-a840-c52371ff98d6';
    const object = {id: refundFixture.refundId, metadata: {order_id: refundFixture.orderId, cancellation_id: cancellationId, cancellation_refund_attempt_id: refundFixture.attemptId}};
    stripe.webhooks.constructEvent.mockReturnValue({type: refundFixture.events.at(-1), data: {object: {id: object.id, metadata: {}}}});
    stripe.refunds.retrieve.mockResolvedValue(object);
    await expect(service.handleStripeWebhook(Buffer.from(refundFixture.payload), refundFixture.signature)).resolves.toEqual({received: true, duplicate: false});
    expect(stripe.refunds.retrieve).toHaveBeenCalledWith(object.id);
    expect(cancellations.reconcile).toHaveBeenCalledWith({orderId: refundFixture.orderId, cancellationId, attemptId: refundFixture.attemptId, refundId: object.id});
    expect(returnRefunds.reconcile).not.toHaveBeenCalled();
    stripe.refunds.retrieve.mockResolvedValue({...object, metadata: {...object.metadata, return_id: refundFixture.returnId}});
    await expect(service.handleStripeWebhook(Buffer.from(refundFixture.payload), refundFixture.signature)).rejects.toMatchObject({status: 400});
    expect(cancellations.reconcile).toHaveBeenCalledOnce();
    stripe.refunds.retrieve.mockResolvedValue({...object, id: 're_different_identity'});
    await expect(service.handleStripeWebhook(Buffer.from(refundFixture.payload), refundFixture.signature)).rejects.toMatchObject({status: 400});
    expect(cancellations.reconcile).toHaveBeenCalledOnce();
  });

});

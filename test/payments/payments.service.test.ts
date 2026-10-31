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
    actions: {cancel:true,resumePayment:true},
    taxAmount:0,
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
        create: vi
          .fn()
          .mockResolvedValue({
            id: "pi_test",
            client_secret: "test_client_secret",
          }),
        retrieve: vi
          .fn()
          .mockResolvedValue({
            id: "pi_test",
            client_secret: "test_client_secret",
          }),
      },
      webhooks: { constructEvent: vi.fn() },
    };
    const finalizer = {
      confirm: vi.fn().mockResolvedValue({ duplicate: false }),
    };
    const orders = { attachPaymentIntent: vi.fn() };
    return {
      stripe,
      finalizer,
      orders,
      service: new PaymentsService(stripe as never, finalizer, orders as never),
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
});

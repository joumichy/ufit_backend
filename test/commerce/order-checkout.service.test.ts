import { describe, expect, it, vi } from "vitest";
import { OrderCheckoutService } from "../../src/modules/orders/application/order-checkout.service";
const input = {
  requestId: "a94f6bd8-902f-4e98-8f72-92c93374791b",
  quoteFingerprint: "a".repeat(64),
  shippingAddress: {
    fullName: "Qualification",
    line1: "Rue de test",
    postalCode: "1000",
    city: "Lausanne",
    country: "CH",
  },
};
function setup() {
  const quotes = {
    prepare: vi
      .fn()
      .mockResolvedValue({
        cart: { id: "cart" },
        quote: { fingerprint: input.quoteFingerprint },
      }),
  };
  const orders = {
    findCheckoutRequest: vi.fn().mockResolvedValue(undefined),
    createPendingFromCart: vi
      .fn()
      .mockResolvedValue({ id: "order", status: "pending_payment" }),
  };
  const payments = {
    createPaymentIntent: vi.fn().mockResolvedValue({ orderId: "order" }),
  };
  return {
    quotes,
    orders,
    payments,
    service: new OrderCheckoutService(
      quotes as never,
      orders as never,
      payments as never,
    ),
  };
}
describe("OrderCheckoutService", () => {
  it("rejects client-supplied prices and incomplete shipping addresses", async () => {
    const { service, quotes } = setup();
    for (const request of [
      { ...input, shippingAmount: 1 },
      { ...input, shippingAddress: { ...input.shippingAddress, city: "" } },
    ])
      await expect(service.checkout("customer", request)).rejects.toMatchObject(
        { status: 400 },
      );
    expect(quotes.prepare).not.toHaveBeenCalled();
  });
  it("requires another review when the server quote changed", async () => {
    const { service, quotes, payments, orders } = setup();
    quotes.prepare.mockResolvedValue({
      cart: { id: "cart" },
      quote: { fingerprint: "b".repeat(64) },
    });
    await expect(service.checkout("customer", input)).rejects.toMatchObject({
      response: { code: "checkout_quote_changed" },
    });
    expect(orders.createPendingFromCart).not.toHaveBeenCalled();
    expect(payments.createPaymentIntent).not.toHaveBeenCalled();
  });
  it("persists the pending order before creating its payment intent", async () => {
    const { service, orders, payments } = setup();
    await service.checkout("customer", input);
    expect(
      orders.createPendingFromCart.mock.invocationCallOrder[0],
    ).toBeLessThan(payments.createPaymentIntent.mock.invocationCallOrder[0]!);
  });
  it("reuses the persisted attempt even if the cart has since changed", async () => {
    const { service, orders, quotes } = setup();
    await service.checkout("customer", input);
    const terms = orders.createPendingFromCart.mock.calls[0]![2];
    orders.findCheckoutRequest.mockResolvedValue({
      id: "order",
      status: "pending_payment",
      checkoutFingerprint: terms.fingerprint,
    });
    quotes.prepare.mockClear();
    await service.checkout("customer", input);
    expect(orders.createPendingFromCart).toHaveBeenCalledTimes(1);
    expect(quotes.prepare).not.toHaveBeenCalled();
  });
  it("refuses to reuse an attempt for another address", async () => {
    const { service, orders, payments } = setup();
    orders.findCheckoutRequest.mockResolvedValue({
      id: "order",
      status: "pending_payment",
      checkoutFingerprint: "different",
    });
    await expect(service.checkout("customer", input)).rejects.toMatchObject({
      response: { code: "checkout_request_conflict" },
    });
    expect(payments.createPaymentIntent).not.toHaveBeenCalled();
  });
});

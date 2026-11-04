import { describe, expect, it, vi } from "vitest";
import { OrderCheckoutService } from "../../src/modules/orders/application/order-checkout.service";
import {CHECKOUT_REQUEST, checkoutOutcomeSchema} from '../../src/modules/orders/domain/checkout-request';
const OUTCOME = {customer: '88888888-8888-4888-8888-888888888888', order: '77777777-7777-4777-8777-777777777777',
  otherRequest: '66666666-6666-4666-8666-666666666666', invalid: 'not-a-request', extraField: 'unexpected'} as const;
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
  it('reports explicit absence without preparing a quote, order or payment', async () => {
    const {service,orders,quotes,payments} = setup();
    expect(await service.outcome(OUTCOME.customer,input.requestId)).toEqual({requestId:input.requestId,orderId:null});
    expect(orders.findCheckoutRequest).toHaveBeenCalledWith(OUTCOME.customer,input.requestId);
    expect(quotes.prepare).not.toHaveBeenCalled(); expect(orders.createPendingFromCart).not.toHaveBeenCalled();
    expect(payments.createPaymentIntent).not.toHaveBeenCalled();
  });
  it('returns the owned order reference using the canonical UUID casing', async () => {
    const {service,orders,payments} = setup();
    orders.findCheckoutRequest.mockResolvedValue({id:OUTCOME.order,checkoutRequestId:input.requestId});
    expect(await service.outcome(OUTCOME.customer,input.requestId.toUpperCase())).toEqual({requestId:input.requestId,orderId:OUTCOME.order});
    expect(orders.findCheckoutRequest).toHaveBeenCalledWith(OUTCOME.customer,input.requestId);
    expect(payments.createPaymentIntent).not.toHaveBeenCalled();
  });
  it('rejects an invalid reference before consulting persistence', async () => {
    const {service,orders} = setup();
    await expect(service.outcome(OUTCOME.customer,OUTCOME.invalid)).rejects.toMatchObject({status:400});
    expect(orders.findCheckoutRequest).not.toHaveBeenCalled();
  });
  it('rejects a stored reference from another request', async () => {
    const {service,orders} = setup();
    orders.findCheckoutRequest.mockResolvedValue({id:OUTCOME.order,checkoutRequestId:OUTCOME.otherRequest});
    await expect(service.outcome(OUTCOME.customer,input.requestId)).rejects.toMatchObject({response:CHECKOUT_REQUEST.failure.outcome});
  });
  it('requires the exact nullable outcome contract', () => {
    const valid={requestId:input.requestId,orderId:OUTCOME.order};
    expect(checkoutOutcomeSchema.parse(valid)).toEqual(valid);
    for(const value of [{requestId:input.requestId},{...valid,orderId:OUTCOME.invalid},{...valid,extra:OUTCOME.extraField}])
      expect(checkoutOutcomeSchema.safeParse(value).success).toBe(false);
  });
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

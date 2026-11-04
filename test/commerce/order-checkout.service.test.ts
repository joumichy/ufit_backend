import { describe, expect, it, vi } from "vitest";
import { OrderCheckoutService } from "../../src/modules/orders/application/order-checkout.service";
import {CHECKOUT_REQUEST, checkoutOutcomeSchema} from '../../src/modules/orders/domain/checkout-request';
import {ConflictException, ServiceUnavailableException} from '@nestjs/common';
import {COMMISSION_RULE} from '../../src/modules/commissions/domain/commission-rule.contract';
import {CONNECT} from '../../src/modules/payments/domain/connect-account';
import {PAYMENT_DISTRIBUTION} from '../../src/modules/payments/domain/payment-distribution';
import type {Cart} from '../../src/modules/cart/application/cart.service';
import type {CartQuote} from '../../src/modules/cart/application/cart-quote.service';
import type {PreparedCartSale} from '../../src/modules/orders/application/orders.service';
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
    prepareCartSale: vi.fn(),
  };
  const payments = {
    createPaymentIntent: vi.fn().mockResolvedValue({ orderId: "order" }),
    assertNewSale: vi.fn(),
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
const REVIEW = {
  cart: '11111111-1111-4111-8111-111111111111', brand: '22222222-2222-4222-8222-222222222222',
  product: '33333333-3333-4333-8333-333333333333', variant: '44444444-4444-4444-8444-444444444444',
  creator: '55555555-5555-4555-8555-555555555555', line: '66666666-6666-4666-8666-666666666666',
  currency: 'CHF', country: 'CH', amount: 10_000, creatorAmount: 1_200, quantity: 1,
  rate: 0.12, returnDays: 30, description: 'Checkout review qualification', fingerprint: 'b'.repeat(64),
} as const;
function reviewSetup() {
  const context = setup();
  const item = {id: REVIEW.line, productId: REVIEW.product, productVariantId: REVIEW.variant,
    quantity: REVIEW.quantity, unitPrice: REVIEW.amount, currency: REVIEW.currency, brandId: REVIEW.brand, sourceCreatorId: REVIEW.creator};
  const cart: Cart = {id: REVIEW.cart, userId: OUTCOME.customer, status: 'active', brandId: REVIEW.brand,
    currency: REVIEW.currency, subtotalAmount: REVIEW.amount, items: [item]};
  const quote: CartQuote = {cartId: REVIEW.cart, brandId: REVIEW.brand, country: REVIEW.country, currency: REVIEW.currency,
    items: [{id: item.id, productId: item.productId, productVariantId: item.productVariantId, quantity: item.quantity, unitPrice: item.unitPrice}],
    fingerprint: REVIEW.fingerprint, subtotalAmount: REVIEW.amount, shippingAmount: 0, taxAmount: 0, totalAmount: REVIEW.amount,
    returnWindowDays: REVIEW.returnDays, returnPolicy: REVIEW.description, refundPolicyCode: 'proportional_tax_full_shipping_v1',
    pricesIncludeTaxes: true, taxNotice: REVIEW.description, customsNotice: REVIEW.description};
  const sale: PreparedCartSale = {creatorCommissionAmount: REVIEW.creatorAmount, items: [{productId: REVIEW.product,
    productVariantId: REVIEW.variant, productSnapshot: {name: REVIEW.description}, quantity: REVIEW.quantity,
    unitPrice: REVIEW.amount, totalPrice: REVIEW.amount, commissionRate: REVIEW.rate, sourceCreatorId: REVIEW.creator}]};
  context.quotes.prepare.mockResolvedValue({cart,quote});context.orders.prepareCartSale.mockResolvedValue(sale);
  context.payments.assertNewSale.mockResolvedValue(undefined);
  return {...context,cart,quote,sale};
}
describe('Checkout review', () => {
  it('returns the priced quote and explicit availability without creating an order or payment', async () => {
    const {service,quotes,orders,payments,quote,cart} = reviewSetup();
    expect(await service.review(OUTCOME.customer,{country:REVIEW.country})).toEqual({quote,available:true});
    expect(quotes.prepare).toHaveBeenCalledWith(OUTCOME.customer,REVIEW.country);
    expect(orders.prepareCartSale).toHaveBeenCalledWith(cart);
    expect(payments.assertNewSale).toHaveBeenCalledWith(REVIEW.brand,REVIEW.amount,REVIEW.creatorAmount,[REVIEW.creator]);
    expect(orders.createPendingFromCart).not.toHaveBeenCalled();expect(payments.createPaymentIntent).not.toHaveBeenCalled();
  });
  it('distinguishes unconfigured commissions from verification failure and keeps prices private to the customer', async () => {
    const {service,orders,payments,quote} = reviewSetup();
    orders.prepareCartSale.mockRejectedValue(new ConflictException({code:COMMISSION_RULE.failureCode.unavailable}));
    expect(await service.review(OUTCOME.customer,{country:REVIEW.country})).toEqual({quote,available:false});
    expect(payments.assertNewSale).not.toHaveBeenCalled();expect(orders.createPendingFromCart).not.toHaveBeenCalled();
  });
  it('reports incomplete recipients, inactive creators and an unavailable distribution budget without payment side effects', async () => {
    for (const code of [CONNECT.failure.sale.code,COMMISSION_RULE.failureCode.creator,PAYMENT_DISTRIBUTION.failure.unavailable.code,PAYMENT_DISTRIBUTION.failure.budget.code]) {
      const {service,payments,quote,orders}=reviewSetup();payments.assertNewSale.mockRejectedValue(new ConflictException({code}));
      expect(await service.review(OUTCOME.customer,{country:REVIEW.country})).toEqual({quote,available:false});
      expect(orders.createPendingFromCart).not.toHaveBeenCalled();expect(payments.createPaymentIntent).not.toHaveBeenCalled();
    }
  });
  it('never turns a provider outage or inconsistent recorded terms into ordinary unavailability', async () => {
    for (const failure of [new ServiceUnavailableException(CONNECT.failure.unavailable),new ConflictException(PAYMENT_DISTRIBUTION.failure.persisted)]) {
      const {service,payments}=reviewSetup();payments.assertNewSale.mockRejectedValue(failure);
      await expect(service.review(OUTCOME.customer,{country:REVIEW.country})).rejects.toBe(failure);
    }
  });
  it('rejects forged availability, prices and invalid or missing countries before reading the cart', async () => {
    for (const body of [{},{country:REVIEW.country,available:true},{country:REVIEW.country,totalAmount:REVIEW.amount},{country:OUTCOME.invalid}]) {
      const {service,quotes}=reviewSetup();await expect(service.review(OUTCOME.customer,body)).rejects.toMatchObject({response:CHECKOUT_REQUEST.failure.input});
      expect(quotes.prepare).not.toHaveBeenCalled();
    }
  });
});
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

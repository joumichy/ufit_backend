import type {Order} from '../../src/modules/orders/application/orders.service';
import {CUSTOMER_PAYMENT as C} from '../../src/modules/payments/domain/customer-payment';
export const PAYMENT_ORDER = {id: '88888888-8888-4888-8888-888888888888', group: 'order:88888888-8888-4888-8888-888888888888', key: 'payment-intent:88888888-8888-4888-8888-888888888888', unexpectedIdentity: 'Unexpected order identity', unconfigured: 'distribution conditions absent'} as const;
export function customerOrder(): Order {
  return {
    id: PAYMENT_ORDER.id,
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

export const CUSTOMER_INTENT_FIXTURE = {id: 'pi_test', secret: 'pi_test_secret_TestPaymentSession', currency: 'chf', error: {code: 'card_declined'}} as const;
export function customerIntent(order: Order = customerOrder(), status: string = C.provider.method) {
  return {id: CUSTOMER_INTENT_FIXTURE.id, client_secret: CUSTOMER_INTENT_FIXTURE.secret, amount: order.totalAmount,
    amount_received: status === C.provider.succeeded ? order.totalAmount : C.limits.zero, currency: order.currency.toLowerCase(),
    metadata: {order_id: order.id}, livemode: false, status, confirmation_method: C.provider.automatic, capture_method: C.provider.automatic, last_payment_error: null as object | null};
}

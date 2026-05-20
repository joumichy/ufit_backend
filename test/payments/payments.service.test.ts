import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCacheForTests } from '../../src/config/env';
import {
  PaymentsService,
  type StripeWebhookEventRecord,
  type StripeWebhookEventRepository
} from '../../src/modules/payments/application/payments.service';
import type { Order } from '../../src/modules/orders/application/orders.service';

class FakeWebhookEvents implements StripeWebhookEventRepository {
  readonly events = new Map<string, StripeWebhookEventRecord>();

  async insertIfNew(event: StripeWebhookEventRecord): Promise<boolean> {
    if (this.events.has(event.stripeEventId)) {
      return false;
    }

    this.events.set(event.stripeEventId, event);
    return true;
  }
}

function makeOrder(): Order {
  return {
    id: 'order-1',
    orderNumber: 'UF-1',
    customerId: 'customer-1',
    brandId: 'brand-1',
    status: 'pending_payment',
    subtotalAmount: 5000,
    shippingAmount: 900,
    totalAmount: 5900,
    currency: 'CHF',
    shippingAddress: {
      fullName: 'A Customer',
      line1: '1 Test Street',
      postalCode: '8000',
      city: 'Zurich',
      country: 'CH'
    },
    paymentProvider: 'placeholder',
    items: [
      {
        id: 'item-1',
        productId: 'product-1',
        productVariantId: 'variant-1',
        productSnapshot: { name: 'Wool Coat' },
        quantity: 1,
        unitPrice: 5000,
        totalPrice: 5000,
        commissionRate: 0.12
      }
    ]
  };
}

describe('PaymentsService', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_DIRECT_CONNECTION_DB_URL: 'postgres://user:pass@localhost:5432/postgres',
      STRIPE_SECRET_KEY: 'sk_test_mock',
      STRIPE_CHECKOUT_SUCCESS_URL: 'https://ufit.test/success',
      STRIPE_CHECKOUT_CANCEL_URL: 'https://ufit.test/cancel'
    };
    resetEnvCacheForTests();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetEnvCacheForTests();
    vi.restoreAllMocks();
  });

  it('creates a Checkout Session with order metadata and a server idempotency key', async () => {
    const stripe = {
      checkout: {
        sessions: {
          create: vi.fn().mockResolvedValue({
            id: 'cs_test_123',
            url: 'https://checkout.stripe.test/session'
          })
        }
      },
      webhooks: {
        constructEvent: vi.fn()
      }
    };
    const orders = {
      attachStripeCheckoutSession: vi.fn().mockResolvedValue(undefined),
      markStripePaymentSucceeded: vi.fn()
    };
    const service = new PaymentsService(stripe, new FakeWebhookEvents(), orders as never);

    const result = await service.createCheckoutSession(makeOrder());

    expect(result).toEqual({
      orderId: 'order-1',
      checkoutSessionId: 'cs_test_123',
      url: 'https://checkout.stripe.test/session'
    });
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'payment',
        success_url: 'https://ufit.test/success',
        cancel_url: 'https://ufit.test/cancel',
        client_reference_id: 'order-1',
        metadata: { order_id: 'order-1' },
        payment_intent_data: { metadata: { order_id: 'order-1' } }
      }),
      { idempotencyKey: 'checkout:order-1' }
    );
    expect(orders.attachStripeCheckoutSession).toHaveBeenCalledWith('order-1', 'cs_test_123');
  });

  it('records Stripe webhook events once and ignores duplicate replays', async () => {
    const events = new FakeWebhookEvents();
    const orders = {
      attachStripeCheckoutSession: vi.fn(),
      markStripePaymentSucceeded: vi.fn().mockResolvedValue(undefined)
    };
    const stripe = {
      checkout: { sessions: { create: vi.fn() } },
      webhooks: { constructEvent: vi.fn() }
    };
    const service = new PaymentsService(stripe, events, orders as never);
    const event = {
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_1',
          metadata: { order_id: 'order-1' }
        }
      }
    };

    await expect(service.handleStripeWebhook(event)).resolves.toEqual({ received: true, duplicate: false });
    await expect(service.handleStripeWebhook(event)).resolves.toEqual({ received: true, duplicate: true });

    expect(events.events.size).toBe(1);
    expect(orders.markStripePaymentSucceeded).toHaveBeenCalledTimes(1);
    expect(orders.markStripePaymentSucceeded).toHaveBeenCalledWith('order-1', 'pi_1');
  });

  it('uses Stripe signature verification when a webhook secret is configured', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock';
    resetEnvCacheForTests();
    const verifiedEvent = {
      id: 'evt_signed',
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { order_id: 'order-1' },
          payment_intent: 'pi_1'
        }
      }
    };
    const stripe = {
      checkout: { sessions: { create: vi.fn() } },
      webhooks: {
        constructEvent: vi.fn().mockReturnValue(verifiedEvent)
      }
    };
    const orders = {
      attachStripeCheckoutSession: vi.fn(),
      markStripePaymentSucceeded: vi.fn().mockResolvedValue(undefined)
    };
    const service = new PaymentsService(stripe, new FakeWebhookEvents(), orders as never);
    const payload = Buffer.from(JSON.stringify(verifiedEvent));

    await service.handleStripeWebhook(payload, 't=1,v1=test');

    expect(stripe.webhooks.constructEvent).toHaveBeenCalledWith(payload, 't=1,v1=test', 'whsec_mock');
    expect(orders.markStripePaymentSucceeded).toHaveBeenCalledWith('order-1', 'pi_1');
  });
});

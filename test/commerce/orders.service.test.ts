import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Cart } from '../../src/modules/cart/application/cart.service';
import {
  OrdersService,
  type CommissionRuleResolver,
  type Order,
  type OrderRepository,
  type PaymentRecord,
  type PaymentRepository,
  type ProductSnapshotReader,
  type StockRepository
} from '../../src/modules/orders/application/orders.service';
import type { Shipment } from '../../src/modules/shipping/application/shipping.service';

class FakeOrderRepository implements OrderRepository {
  private readonly orders = new Map<string, Order>();

  async save(order: Order): Promise<Order> {
    this.orders.set(order.id, structuredClone(order));
    return structuredClone(order);
  }

  async findById(orderId: string): Promise<Order | undefined> {
    const order = this.orders.get(orderId);
    return order ? structuredClone(order) : undefined;
  }

  async saveStripeCheckoutSession(orderId: string, checkoutSessionId: string): Promise<Order> {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    const updated = { ...order, paymentProvider: 'stripe' as const, stripeCheckoutSessionId: checkoutSessionId };
    this.orders.set(orderId, structuredClone(updated));
    return structuredClone(updated);
  }

  async markStripePaymentSucceeded(orderId: string, stripePaymentIntentId?: string): Promise<Order | undefined> {
    const order = this.orders.get(orderId);
    if (!order) {
      return undefined;
    }

    const updated = { ...order, status: 'paid' as const, paymentProvider: 'stripe' as const, stripePaymentIntentId };
    this.orders.set(orderId, structuredClone(updated));
    return structuredClone(updated);
  }
}

class FakePaymentRepository implements PaymentRepository {
  readonly payments = new Map<string, PaymentRecord>();

  async findByProviderPaymentIntentId(provider: PaymentRecord['provider'], providerPaymentIntentId: string): Promise<PaymentRecord | undefined> {
    const payment = [...this.payments.values()].find(
      (candidate) => candidate.provider === provider && candidate.providerPaymentIntentId === providerPaymentIntentId
    );
    return payment ? structuredClone(payment) : undefined;
  }

  async save(payment: PaymentRecord): Promise<PaymentRecord> {
    this.payments.set(payment.id, structuredClone(payment));
    return structuredClone(payment);
  }
}

class FakeStockRepository implements StockRepository {
  readonly decrements: Array<{ productVariantId: string; quantity: number }> = [];
  private readonly available = new Map<string, number>();

  setAvailable(productVariantId: string, quantity: number): void {
    this.available.set(productVariantId, quantity);
  }

  async decrementAvailable(productVariantId: string, quantity: number): Promise<void> {
    const current = this.available.get(productVariantId) ?? 0;
    if (current < quantity) {
      throw new BadRequestException('Insufficient stock for this variant');
    }
    this.available.set(productVariantId, current - quantity);
    this.decrements.push({ productVariantId, quantity });
  }
}

class FakeShipmentCreator {
  readonly shipments: Shipment[] = [];

  async createPendingForPaidOrder(orderId: string, brandId: string): Promise<Shipment> {
    const shipment: Shipment = { id: `shipment-${this.shipments.length + 1}`, orderId, brandId, status: 'pending' };
    this.shipments.push(shipment);
    return structuredClone(shipment);
  }
}

class FakeCommissionCreator {
  readonly commissions: Array<{ orderItemId: string; creatorId: string; brandId: string; sourceOutfitId: string; baseAmount: number; rule: { baseRate: number; bonusRate?: number; maxRate?: number } }> = [];

  async createPending(input: {
    orderItemId: string;
    creatorId: string;
    brandId: string;
    sourceOutfitId: string;
    baseAmount: number;
    rule: { baseRate: number; bonusRate?: number; maxRate?: number };
  }) {
    this.commissions.push(structuredClone(input));
    return {
      id: `commission-${this.commissions.length}`,
      ...input,
      commissionRate: Math.min(input.rule.baseRate + (input.rule.bonusRate ?? 0), input.rule.maxRate ?? 1),
      commissionAmount: Math.round(input.baseAmount * input.rule.baseRate),
      status: 'pending' as const
    };
  }
}

describe('OrdersService', () => {
  const cart: Cart = {
    id: 'cart-1',
    userId: 'customer-1',
    status: 'active',
    brandId: 'brand-1',
    sourceOutfitId: 'outfit-1',
    sourceCreatorId: 'creator-1',
    currency: 'CHF',
    subtotalAmount: 0,
    items: [
      {
        id: 'line-1',
        productId: 'product-1',
        productVariantId: 'variant-1',
        quantity: 2,
        unitPrice: 5000,
        currency: 'CHF',
        brandId: 'brand-1',
        sourceOutfitId: 'outfit-1',
        sourceCreatorId: 'creator-1'
      }
    ]
  };

  it('creates order items with immutable product snapshots', async () => {
    const snapshots: ProductSnapshotReader = {
      async buildSnapshot() {
        return {
          name: 'Tailored Wool Coat',
          brand: 'Maison Test',
          size: 'M',
          color: 'Black',
          imageUrl: 'https://example.test/coat.jpg',
          commissionRate: 0.12
        };
      }
    };
    const service = new OrdersService(new FakeOrderRepository(), snapshots);

    const order = await service.createPendingFromCart(cart, {
      fullName: 'A Customer',
      line1: '1 Test Street',
      postalCode: '8000',
      city: 'Zurich',
      country: 'CH'
    });

    expect(order.status).toBe('pending_payment');
    expect(order.totalAmount).toBe(10000);
    expect(order.items[0]?.productSnapshot).toMatchObject({
      name: 'Tailored Wool Coat',
      brand: 'Maison Test',
      commissionRate: 0.12
    });
  });

  it('does not expose customer shipping address in creator order views', async () => {
    const service = new OrdersService(new FakeOrderRepository(), { buildSnapshot: async () => ({}) });
    const order = await service.createPendingFromCart(cart, {
      fullName: 'A Customer',
      line1: '1 Test Street',
      postalCode: '8000',
      city: 'Zurich',
      country: 'CH'
    });

    expect(service.toCreatorOrderView(order)).not.toHaveProperty('shippingAddress');
  });

  it('marks Stripe checkout attempts on the order', async () => {
    const service = new OrdersService(new FakeOrderRepository(), { buildSnapshot: async () => ({}) });
    const order = await service.createPendingFromCart(cart, {
      fullName: 'A Customer',
      line1: '1 Test Street',
      postalCode: '8000',
      city: 'Zurich',
      country: 'CH'
    });

    const updated = await service.attachStripeCheckoutSession(order.id, 'cs_test_123');

    expect(updated.paymentProvider).toBe('stripe');
    expect(updated.stripeCheckoutSessionId).toBe('cs_test_123');
  });

  it('confirms a Stripe payment from the webhook, reserves stock, creates shipment and commissions', async () => {
    const orders = new FakeOrderRepository();
    const payments = new FakePaymentRepository();
    const stock = new FakeStockRepository();
    const shipments = new FakeShipmentCreator();
    const commissions = new FakeCommissionCreator();
    const ruleResolver: CommissionRuleResolver = {
      async resolve() {
        return { baseRate: 0.1, bonusRate: 0.05, maxRate: 0.12 };
      }
    };
    const service = new OrdersService(
      orders,
      { buildSnapshot: async () => ({ commissionRate: 0.1 }) },
      payments,
      stock,
      shipments,
      commissions,
      ruleResolver
    );
    const order = await service.createPendingFromCart(cart, {
      fullName: 'A Customer',
      line1: '1 Test Street',
      postalCode: '8000',
      city: 'Zurich',
      country: 'CH'
    });
    stock.setAvailable('variant-1', 2);

    const result = await service.confirmStripePaymentSucceededFromWebhook({
      orderId: order.id,
      provider: 'stripe',
      providerPaymentIntentId: 'pi_123',
      amount: 10000,
      currency: 'CHF'
    });

    expect(result.alreadyProcessed).toBe(false);
    expect(result.order.status).toBe('paid');
    expect(stock.decrements).toEqual([{ productVariantId: 'variant-1', quantity: 2 }]);
    expect(result.shipment).toMatchObject({ orderId: order.id, brandId: 'brand-1', status: 'pending' });
    expect(commissions.commissions[0]).toMatchObject({
      creatorId: 'creator-1',
      sourceOutfitId: 'outfit-1',
      rule: { baseRate: 0.1, bonusRate: 0.05, maxRate: 0.12 }
    });
  });

  it('is idempotent for repeated webhook payment confirmations', async () => {
    const orders = new FakeOrderRepository();
    const payments = new FakePaymentRepository();
    const stock = new FakeStockRepository();
    const shipments = new FakeShipmentCreator();
    const commissions = new FakeCommissionCreator();
    const service = new OrdersService(orders, { buildSnapshot: async () => ({ commissionRate: 0.1 }) }, payments, stock, shipments, commissions);
    const order = await service.createPendingFromCart(cart, {
      fullName: 'A Customer',
      line1: '1 Test Street',
      postalCode: '8000',
      city: 'Zurich',
      country: 'CH'
    });
    stock.setAvailable('variant-1', 2);
    const input = { orderId: order.id, provider: 'stripe' as const, providerPaymentIntentId: 'pi_idempotent', amount: 10000, currency: 'CHF' };

    await service.confirmStripePaymentSucceededFromWebhook(input);
    const replay = await service.confirmStripePaymentSucceededFromWebhook(input);

    expect(replay.alreadyProcessed).toBe(true);
    expect(stock.decrements).toHaveLength(1);
    expect(shipments.shipments).toHaveLength(1);
    expect(commissions.commissions).toHaveLength(1);
  });

  it('does not mark the order paid when stock cannot be decremented', async () => {
    const orders = new FakeOrderRepository();
    const service = new OrdersService(
      orders,
      { buildSnapshot: async () => ({ commissionRate: 0.1 }) },
      new FakePaymentRepository(),
      new FakeStockRepository(),
      new FakeShipmentCreator(),
      new FakeCommissionCreator()
    );
    const order = await service.createPendingFromCart(cart, {
      fullName: 'A Customer',
      line1: '1 Test Street',
      postalCode: '8000',
      city: 'Zurich',
      country: 'CH'
    });

    await expect(
      service.confirmStripePaymentSucceededFromWebhook({
        orderId: order.id,
        provider: 'stripe',
        providerPaymentIntentId: 'pi_no_stock',
        amount: 10000,
        currency: 'CHF'
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(orders.findById(order.id)).resolves.toMatchObject({ status: 'pending_payment' });
  });
});

import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Cart } from '../../src/modules/cart/application/cart.service';
import { OrdersService, type Order, type OrderRepository, type ProductSnapshotReader } from '../../src/modules/orders/application/orders.service';

class FakeOrderRepository implements OrderRepository {
  async save(order: Order): Promise<Order> {
    return structuredClone(order);
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

  it('refuses checkout while Stripe is disabled', () => {
    const service = new OrdersService(new FakeOrderRepository(), { buildSnapshot: async () => ({}) });

    expect(() => service.checkoutPlaceholder()).toThrow(ForbiddenException);
  });
});

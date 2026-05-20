import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CartService, type Cart, type CartRepository, type ProductCatalogReader } from '../../src/modules/cart/application/cart.service';

class FakeCartRepository implements CartRepository {
  cart?: Cart;

  async findActiveByUserId(): Promise<Cart | undefined> {
    return this.cart;
  }

  async save(cart: Cart): Promise<Cart> {
    this.cart = structuredClone(cart);
    return structuredClone(cart);
  }
}

describe('CartService', () => {
  it('keeps the MVP cart mono-brand', async () => {
    const carts = new FakeCartRepository();
    const catalog: ProductCatalogReader = {
      async getVariantQuote(productVariantId) {
        return {
          productId: `product-${productVariantId}`,
          productVariantId,
          brandId: productVariantId === 'variant-a' ? 'brand-a' : 'brand-b',
          unitPrice: 1000,
          currency: 'CHF',
          stockQuantity: 10
        };
      }
    };
    const service = new CartService(carts, catalog);

    await service.addItem({ userId: 'user-1', productVariantId: 'variant-a', quantity: 1 });

    await expect(service.addItem({ userId: 'user-1', productVariantId: 'variant-b', quantity: 1 })).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('recalculates item prices from the server catalog mock', async () => {
    const carts = new FakeCartRepository();
    const catalog: ProductCatalogReader = {
      async getVariantQuote() {
        return {
          productId: 'product-1',
          productVariantId: 'variant-1',
          brandId: 'brand-1',
          unitPrice: 12990,
          currency: 'CHF',
          stockQuantity: 5
        };
      }
    };
    const service = new CartService(carts, catalog);

    const cart = await service.addItem({ userId: 'user-1', productVariantId: 'variant-1', quantity: 2 });

    expect(cart.items[0]?.unitPrice).toBe(12990);
    expect(cart.subtotalAmount).toBe(25980);
  });
});

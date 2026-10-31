import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CartService, type Cart, type CartRepository, type ProductCatalogReader } from '../../src/modules/cart/application/cart.service';

class FakeCartRepository implements CartRepository {
  cart?: Cart;

  async findActiveByUserId(): Promise<Cart | undefined> {
    return this.cart?.status === 'active' ? structuredClone(this.cart) : undefined;
  }

  async mutate(_userId: string, update: (cart: Cart | undefined) => Cart | undefined): Promise<Cart | undefined> {
    const updated = update(await this.findActiveByUserId());
    if (updated) this.cart = structuredClone(updated);
    return updated ? structuredClone(updated) : undefined;
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
    const service = new CartService(carts, catalog, {findById: async () => null});

    await service.addItem({ userId: 'user-1', productVariantId: 'variant-a', quantity: 1 });

    await expect(service.addItem({ userId: 'user-1', productVariantId: 'variant-b', quantity: 1 })).rejects.toBeInstanceOf(
      ConflictException
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
    const service = new CartService(carts, catalog, {findById: async () => null});

    const cart = await service.addItem({ userId: 'user-1', productVariantId: 'variant-1', quantity: 2 });

    expect(cart.items[0]?.unitPrice).toBe(12990);
    expect(cart.subtotalAmount).toBe(25980);
  });
  it('rejects attribution to an outfit outside the published catalogue before persisting', async () => {
    const carts = new FakeCartRepository();
    const catalog: ProductCatalogReader = { async getVariantQuote(productVariantId) {
      return { productId: 'product-1', productVariantId, brandId: 'brand-1', unitPrice: 1000, currency: 'CHF', stockQuantity: 5 };
    } };
    const service = new CartService(carts, catalog, {findById: async () => null});
    await expect(service.addItem({userId: 'user-1', productVariantId: 'variant-1', quantity: 1, sourceOutfitId: 'unavailable-outfit'})).rejects.toBeInstanceOf(BadRequestException);
    expect(carts.cart).toBeUndefined();
  });

});

import { Injectable, NotFoundException } from '@nestjs/common';
import type { Cart, CartRepository, ProductCatalogReader, ProductVariantQuote } from '../application/cart.service';

@Injectable()
export class InMemoryCartRepository implements CartRepository {
  private readonly carts = new Map<string, Cart>();

  async findActiveByUserId(userId: string): Promise<Cart | undefined> {
    return [...this.carts.values()].find((cart) => cart.userId === userId && cart.status === 'active');
  }

  async save(cart: Cart): Promise<Cart> {
    this.carts.set(cart.id, structuredClone(cart));
    return structuredClone(cart);
  }
}

@Injectable()
export class DisabledProductCatalogReader implements ProductCatalogReader {
  async getVariantQuote(productVariantId: string): Promise<ProductVariantQuote> {
    throw new NotFoundException(`Product variant ${productVariantId} is not available from the commerce catalog adapter yet`);
  }
}

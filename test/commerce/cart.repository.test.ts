import { describe, expect, it, vi } from 'vitest';
import { DrizzleCartRepository } from '../../src/modules/cart/infrastructure/drizzle-cart.repository';
import type { Cart } from '../../src/modules/cart/application/cart.service';
import type { DatabaseService } from '../../src/shared/infrastructure/database/database.service';
import type { CartItemRow, CartRow } from '../../src/shared/infrastructure/database/schema';

const cartRow = {
  id: 'cart-1',
  userId: 'user-1',
  status: 'active',
  brandId: 'brand-1',
  sourceOutfitId: null,
  sourceCreatorId: 'creator-1',
  currency: 'CHF',
  subtotalAmount: 3000
} as CartRow;

const itemRow = {
  id: 'item-1',
  cartId: 'cart-1',
  productId: 'product-1',
  productVariantId: 'variant-1',
  quantity: 2,
  unitPrice: 1500,
  currency: 'CHF',
  brandId: 'brand-1',
  sourceOutfitId: null,
  sourceCreatorId: 'creator-1'
} as CartItemRow;

describe('DrizzleCartRepository', () => {
  it('loads the active cart with persisted items and source attribution', async () => {
    const cartQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([cartRow])
    };
    const itemsQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([itemRow])
    };
    const database = {
      db: {
        select: vi.fn().mockReturnValueOnce(cartQuery).mockReturnValueOnce(itemsQuery)
      }
    } as unknown as DatabaseService;
    const repository = new DrizzleCartRepository(database);

    const cart = await repository.findActiveByUserId('user-1');

    expect(cart).toMatchObject({
      id: 'cart-1',
      userId: 'user-1',
      status: 'active',
      brandId: 'brand-1',
      sourceCreatorId: 'creator-1',
      subtotalAmount: 3000,
      items: [
        {
          id: 'item-1',
          productVariantId: 'variant-1',
          quantity: 2,
          unitPrice: 1500,
          sourceCreatorId: 'creator-1'
        }
      ]
    });
    expect(cart?.sourceOutfitId).toBeUndefined();
    expect(cart?.items[0]?.sourceOutfitId).toBeUndefined();
  });

  it('upserts the cart and replaces persisted items inside one transaction', async () => {
    const cartInsert = {
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([cartRow])
    };
    const itemInsert = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([itemRow])
    };
    const deleteQuery = {
      where: vi.fn().mockResolvedValue(undefined)
    };
    const tx = {
      insert: vi.fn().mockReturnValueOnce(cartInsert).mockReturnValueOnce(itemInsert),
      delete: vi.fn().mockReturnValue(deleteQuery)
    };
    const database = {
      db: {
        transaction: vi.fn((callback: (transaction: typeof tx) => Promise<Cart>) => callback(tx))
      }
    } as unknown as DatabaseService;
    const repository = new DrizzleCartRepository(database);

    const saved = await repository.save({
      id: 'cart-1',
      userId: 'user-1',
      status: 'active',
      brandId: 'brand-1',
      sourceCreatorId: 'creator-1',
      currency: 'CHF',
      subtotalAmount: 3000,
      items: [
        {
          id: 'item-1',
          productId: 'product-1',
          productVariantId: 'variant-1',
          quantity: 2,
          unitPrice: 1500,
          currency: 'CHF',
          brandId: 'brand-1',
          sourceCreatorId: 'creator-1'
        }
      ]
    });

    expect(database.db.transaction).toHaveBeenCalledOnce();
    expect(cartInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'cart-1',
        userId: 'user-1',
        sourceOutfitId: null,
        sourceCreatorId: 'creator-1',
        subtotalAmount: 3000
      })
    );
    expect(deleteQuery.where).toHaveBeenCalledOnce();
    expect(itemInsert.values).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'item-1',
        cartId: 'cart-1',
        productVariantId: 'variant-1',
        sourceOutfitId: null,
        sourceCreatorId: 'creator-1'
      })
    ]);
    expect(saved.items[0]?.sourceCreatorId).toBe('creator-1');
  });
});

import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import { cartItems, carts, type CartItemRow, type CartRow } from '../../../shared/infrastructure/database/schema';
import type { Cart, CartLine, CartRepository } from '../application/cart.service';

@Injectable()
export class DrizzleCartRepository implements CartRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async findActiveByUserId(userId: string): Promise<Cart | undefined> {
    const [cart] = await this.database.db
      .select()
      .from(carts)
      .where(and(eq(carts.userId, userId), eq(carts.status, 'active')))
      .limit(1);

    if (!cart) {
      return undefined;
    }

    const items = await this.database.db
      .select()
      .from(cartItems)
      .where(eq(cartItems.cartId, cart.id))
      .orderBy(asc(cartItems.createdAt), asc(cartItems.id));

    return toCart(cart, items);
  }

  async save(cart: Cart): Promise<Cart> {
    return this.database.db.transaction(async (tx) => {
      const [cartRow] = await tx
        .insert(carts)
        .values({
          id: cart.id,
          userId: cart.userId,
          status: cart.status,
          brandId: cart.brandId ?? null,
          sourceOutfitId: cart.sourceOutfitId ?? null,
          sourceCreatorId: cart.sourceCreatorId ?? null,
          currency: cart.currency,
          subtotalAmount: cart.subtotalAmount
        })
        .onConflictDoUpdate({
          target: carts.id,
          set: {
            status: cart.status,
            brandId: cart.brandId ?? null,
            sourceOutfitId: cart.sourceOutfitId ?? null,
            sourceCreatorId: cart.sourceCreatorId ?? null,
            currency: cart.currency,
            subtotalAmount: cart.subtotalAmount,
            updatedAt: new Date()
          }
        })
        .returning();

      await tx.delete(cartItems).where(eq(cartItems.cartId, cart.id));

      const itemRows = cart.items.length
        ? await tx
            .insert(cartItems)
            .values(
              cart.items.map((item) => ({
                id: item.id,
                cartId: cart.id,
                productId: item.productId,
                productVariantId: item.productVariantId,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                currency: item.currency,
                brandId: item.brandId,
                sourceOutfitId: item.sourceOutfitId ?? null,
                sourceCreatorId: item.sourceCreatorId ?? null
              }))
            )
            .returning()
        : [];

      return toCart(cartRow, itemRows);
    });
  }
}

function toCart(row: CartRow, itemRows: CartItemRow[]): Cart {
  return {
    id: row.id,
    userId: row.userId,
    status: toCartStatus(row.status),
    brandId: row.brandId ?? undefined,
    sourceOutfitId: row.sourceOutfitId ?? undefined,
    sourceCreatorId: row.sourceCreatorId ?? undefined,
    currency: row.currency,
    subtotalAmount: row.subtotalAmount,
    items: itemRows.map(toCartLine)
  };
}

function toCartLine(row: CartItemRow): CartLine {
  return {
    id: row.id,
    productId: row.productId,
    productVariantId: row.productVariantId,
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    currency: row.currency,
    brandId: row.brandId,
    sourceOutfitId: row.sourceOutfitId ?? undefined,
    sourceCreatorId: row.sourceCreatorId ?? undefined
  };
}

function toCartStatus(status: string): Cart['status'] {
  if (status === 'checked_out' || status === 'abandoned') {
    return status;
  }
  return 'active';
}

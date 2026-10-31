import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import { cartItems, carts, type CartItemRow, type CartRow } from '../../../shared/infrastructure/database/schema';
import type { Cart, CartLine, CartRepository } from '../application/cart.service';

type CartDatabase = Pick<DatabaseService['db'], 'select' | 'insert' | 'delete'>;
const CART_LOCK_NAMESPACE = 'ufit-cart:';
const CART_LOCK_SEED = 0;

@Injectable()
export class DrizzleCartRepository implements CartRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}
  async findActiveByUserId(userId: string): Promise<Cart | undefined> { return readCart(this.database.db, userId); }
  async mutate(userId: string, update: (cart: Cart | undefined) => Cart | undefined): Promise<Cart | undefined> {
    return this.database.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${CART_LOCK_NAMESPACE + userId}, ${CART_LOCK_SEED}))`);
      const current = await readCart(tx, userId);
      const updated = update(current);
      if (!updated) return undefined;
      return saveCart(tx, updated);
    });
  }
}

async function readCart(db: CartDatabase, userId: string): Promise<Cart | undefined> {
  const [cart] = await db.select().from(carts).where(and(eq(carts.userId,userId),eq(carts.status,'active'))).limit(1);
  if (!cart) return undefined;
  const items = await db.select().from(cartItems).where(eq(cartItems.cartId,cart.id)).orderBy(asc(cartItems.createdAt),asc(cartItems.id));
  return toCart(cart,items);
}
async function saveCart(db: CartDatabase, cart: Cart): Promise<Cart> {
  const values = {id:cart.id,userId:cart.userId,status:cart.status,brandId:cart.brandId ?? null,
    sourceOutfitId:cart.sourceOutfitId ?? null,sourceCreatorId:cart.sourceCreatorId ?? null,
    currency:cart.currency,subtotalAmount:cart.subtotalAmount};
  const [row] = await db.insert(carts).values(values).onConflictDoUpdate({target:carts.id,set:{...values,updatedAt:new Date()}}).returning();
  await db.delete(cartItems).where(eq(cartItems.cartId,cart.id));
  const lines = cart.items.length ? await db.insert(cartItems).values(cart.items.map(item => ({
    id:item.id,cartId:cart.id,productId:item.productId,productVariantId:item.productVariantId,
    quantity:item.quantity,unitPrice:item.unitPrice,currency:item.currency,brandId:item.brandId,
    sourceOutfitId:item.sourceOutfitId ?? null,sourceCreatorId:item.sourceCreatorId ?? null
  }))).returning() : [];
  return toCart(row,lines);
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

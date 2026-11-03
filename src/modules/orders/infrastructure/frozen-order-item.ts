import {ConflictException} from '@nestjs/common';
import {z} from 'zod';
import type {OrderItemRow} from '../../../shared/infrastructure/database/schema';
import type {FrozenOrderItem} from '../domain/frozen-order-item';

export const FROZEN_ITEM = {minimumText: 1,name:'name',jsonString:'string'} as const;
const snapshotSchema = z.object({[FROZEN_ITEM.name]: z.string().min(FROZEN_ITEM.minimumText), sku: z.string().min(FROZEN_ITEM.minimumText),
  size: z.string().nullable().optional(), color: z.string().nullable().optional(), imageUrl: z.string().nullable().optional()});
export function projectFrozenOrderItem(row: OrderItemRow, failure: {code: string; message: string}): FrozenOrderItem {
  const parsed = snapshotSchema.safeParse(row.productSnapshot);
  if (!parsed.success) throw new ConflictException(failure);
  return {id: row.id, productId: row.productId, productVariantId: row.productVariantId, name: parsed.data.name, sku: parsed.data.sku,
    size: parsed.data.size ?? null, color: parsed.data.color ?? null, imageUrl: parsed.data.imageUrl ?? null,
    quantity: row.quantity, unitPrice: row.unitPrice, totalPrice: row.totalPrice};
}

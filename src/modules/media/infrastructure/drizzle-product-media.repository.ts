import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { and, eq, exists, inArray, ne, or, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import { brandMembers, brandProfiles, productImages, products, productMediaAssets, orderItems, orders, orderStatusHistory } from '../../../shared/infrastructure/database/schema';
import { PROFILE_EDITING, PROFILE_STATUS } from '../../../shared/domain/profile-editing.contract';
import { PRODUCT_STATUS } from '../../products/domain/product-contract';
import { ORDER_STATUS } from '../../orders/domain/order-lifecycle';
import { PRODUCT_MEDIA } from '../domain/product-media.contract';
import type { ProductMediaAsset, ProductMediaRepository } from '../domain/product-media.types';

type Transaction = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];
const persistence = {lock: 'update', firstIndex: 0} as const;
@Injectable()
export class DrizzleProductMediaRepository implements ProductMediaRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}
  private async lockMembership(tx: Transaction, brandId: string, userId: string): Promise<void> {
    const rows = await tx.select({id: brandProfiles.id}).from(brandProfiles)
      .innerJoin(brandMembers, and(eq(brandMembers.brandProfileId, brandProfiles.id), eq(brandMembers.userId, userId), eq(brandMembers.status, PROFILE_EDITING.persistence.memberActive)))
      .where(and(eq(brandProfiles.id, brandId), ne(brandProfiles.status, PROFILE_STATUS.suspended))).for(persistence.lock);
    if (!rows.length) throw new ForbiddenException(PRODUCT_MEDIA.failure.access);
  }
  async reserve(input: Omit<ProductMediaAsset, 'status' | 'createdAt' | 'updatedAt'>): Promise<ProductMediaAsset> {
    return this.database.db.transaction(async tx => {
      await this.lockMembership(tx, input.brandId, input.uploadedBy);
      const [existing] = await tx.select().from(productMediaAssets)
        .where(and(eq(productMediaAssets.brandId, input.brandId), eq(productMediaAssets.requestId, input.requestId))).for(persistence.lock);
      if (existing) {
        if (existing.fingerprint !== input.fingerprint || existing.byteSize !== input.byteSize || existing.contentType !== input.contentType) throw new ConflictException(PRODUCT_MEDIA.failure.request);
        return existing;
      }
      const [row] = await tx.insert(productMediaAssets).values(input).returning();
      return row;
    });
  }
  async markReady(asset: ProductMediaAsset, userId: string): Promise<ProductMediaAsset> {
    return this.database.db.transaction(async tx => {
      await this.lockMembership(tx, asset.brandId, userId);
      const [row] = await tx.update(productMediaAssets).set({status: PRODUCT_MEDIA.status.ready, updatedAt: new Date()})
        .where(and(eq(productMediaAssets.id, asset.id), eq(productMediaAssets.brandId, asset.brandId), eq(productMediaAssets.fingerprint, asset.fingerprint))).returning();
      if (!row) throw new ConflictException(PRODUCT_MEDIA.failure.request);
      return row;
    });
  }
  async findByIds(ids: string[]): Promise<ProductMediaAsset[]> {
    if (!ids.length) return [];
    return this.database.db.select().from(productMediaAssets).where(inArray(productMediaAssets.id, ids));
  }
  async findPublic(id: string, canonicalUrl: string): Promise<ProductMediaAsset | null> {
    const activeReference = this.database.db.select({id: productImages.id}).from(productImages)
      .innerJoin(products, eq(products.id, productImages.productId)).innerJoin(brandProfiles, eq(brandProfiles.id, products.brandId))
      .where(and(eq(productImages.url, canonicalUrl), eq(products.brandId, productMediaAssets.brandId),
        eq(products.status, PRODUCT_STATUS.active), eq(brandProfiles.status, PROFILE_STATUS.active)));
    const historicalReference = this.database.db.select({id: orderItems.id}).from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(orderStatusHistory, and(eq(orderStatusHistory.orderId, orders.id), eq(orderStatusHistory.toStatus, ORDER_STATUS.paid)))
      .where(and(eq(orders.brandId, productMediaAssets.brandId), sql`${orderItems.productSnapshot} ->> ${PRODUCT_MEDIA.snapshotImageKey} = ${canonicalUrl}`));
    const rows = await this.database.db.select().from(productMediaAssets)
      .where(and(eq(productMediaAssets.id, id), eq(productMediaAssets.status, PRODUCT_MEDIA.status.ready), or(exists(activeReference), exists(historicalReference))));
    return rows[persistence.firstIndex] ?? null;
  }
}

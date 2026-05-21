import { Inject, Injectable } from '@nestjs/common';
import { count, desc, inArray } from 'drizzle-orm';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import {
  brandApplications,
  commissions,
  creatorApplications,
  orders,
  outfits,
  products
} from '../../../shared/infrastructure/database/schema';
import type { AdminPage, AdminQueueItem, AdminQueueName, AdminRepository } from '../application/admin.service';

const applicationStatuses = ['submitted', 'under_review', 'waitlisted', 'needs_more_info'] as const;
const productStatuses = ['under_review'] as const;
const outfitStatuses = ['under_review', 'submitted'] as const;
const orderStatuses = ['paid', 'preparing'] as const;
const commissionStatuses = ['pending', 'estimated'] as const;

@Injectable()
export class DrizzleAdminRepository implements AdminRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async countQueues(): Promise<Record<AdminQueueName, number>> {
    const [creatorApplicationCount, brandApplicationCount, productCount, outfitCount, orderCount, commissionCount] = await Promise.all([
      this.countCreatorApplications(),
      this.countBrandApplications(),
      this.countProducts(),
      this.countOutfits(),
      this.countOrders(),
      this.countCommissions()
    ]);

    return {
      applications: creatorApplicationCount + brandApplicationCount,
      products: productCount,
      outfits: outfitCount,
      orders: orderCount,
      commissions: commissionCount
    };
  }

  async listQueue(queue: AdminQueueName, page: { limit: number; offset: number }): Promise<AdminPage<AdminQueueItem>> {
    switch (queue) {
      case 'applications':
        return this.listApplications(page);
      case 'products':
        return this.listProducts(page);
      case 'outfits':
        return this.listOutfits(page);
      case 'orders':
        return this.listOrders(page);
      case 'commissions':
        return this.listCommissions(page);
    }
  }

  private async listApplications(page: { limit: number; offset: number }): Promise<AdminPage<AdminQueueItem>> {
    const [creatorRows, brandRows, total] = await Promise.all([
      this.database.db
        .select()
        .from(creatorApplications)
        .where(inArray(creatorApplications.status, applicationStatuses))
        .orderBy(desc(creatorApplications.submittedAt))
        .limit(page.limit + page.offset),
      this.database.db
        .select()
        .from(brandApplications)
        .where(inArray(brandApplications.status, applicationStatuses))
        .orderBy(desc(brandApplications.submittedAt))
        .limit(page.limit + page.offset),
      this.countCreatorApplications().then(async (creatorTotal) => creatorTotal + (await this.countBrandApplications()))
    ]);

    const items = [
      ...creatorRows.map((row): AdminQueueItem => ({
        id: row.id,
        type: 'creator_application',
        status: row.status,
        ownerId: row.userId,
        title: row.displayName,
        submittedAt: row.submittedAt.toISOString()
      })),
      ...brandRows.map((row): AdminQueueItem => ({
        id: row.id,
        type: 'brand_application',
        status: row.status,
        ownerId: row.userId,
        title: row.brandName,
        submittedAt: row.submittedAt.toISOString()
      }))
    ]
      .sort((left, right) => (right.submittedAt ?? '').localeCompare(left.submittedAt ?? ''))
      .slice(page.offset, page.offset + page.limit);

    return this.toPage(items, page, total);
  }

  private async listProducts(page: { limit: number; offset: number }): Promise<AdminPage<AdminQueueItem>> {
    const [rows, total] = await Promise.all([
      this.database.db
        .select()
        .from(products)
        .where(inArray(products.status, productStatuses))
        .orderBy(desc(products.updatedAt))
        .limit(page.limit)
        .offset(page.offset),
      this.countProducts()
    ]);

    return this.toPage(
      rows.map((row) => ({
        id: row.id,
        type: 'product',
        status: row.status,
        ownerId: row.brandId,
        title: row.name,
        amount: row.basePrice,
        currency: row.currency,
        submittedAt: row.updatedAt?.toISOString() ?? null
      })),
      page,
      total
    );
  }

  private async listOutfits(page: { limit: number; offset: number }): Promise<AdminPage<AdminQueueItem>> {
    const [rows, total] = await Promise.all([
      this.database.db
        .select()
        .from(outfits)
        .where(inArray(outfits.status, outfitStatuses))
        .orderBy(desc(outfits.updatedAt))
        .limit(page.limit)
        .offset(page.offset),
      this.countOutfits()
    ]);

    return this.toPage(
      rows.map((row) => ({
        id: row.id,
        type: 'outfit',
        status: row.status,
        ownerId: row.creatorId ?? row.brandId,
        title: row.title,
        amount: row.totalPriceMax,
        currency: 'CHF',
        submittedAt: row.updatedAt?.toISOString() ?? null
      })),
      page,
      total
    );
  }

  private async listOrders(page: { limit: number; offset: number }): Promise<AdminPage<AdminQueueItem>> {
    const [rows, total] = await Promise.all([
      this.database.db
        .select()
        .from(orders)
        .where(inArray(orders.status, orderStatuses))
        .orderBy(desc(orders.createdAt))
        .limit(page.limit)
        .offset(page.offset),
      this.countOrders()
    ]);

    return this.toPage(
      rows.map((row) => ({
        id: row.id,
        type: 'order',
        status: row.status,
        ownerId: row.customerId,
        title: row.orderNumber,
        amount: row.totalAmount,
        currency: row.currency,
        submittedAt: row.createdAt?.toISOString() ?? null
      })),
      page,
      total
    );
  }

  private async listCommissions(page: { limit: number; offset: number }): Promise<AdminPage<AdminQueueItem>> {
    const [rows, total] = await Promise.all([
      this.database.db
        .select()
        .from(commissions)
        .where(inArray(commissions.status, commissionStatuses))
        .orderBy(desc(commissions.createdAt))
        .limit(page.limit)
        .offset(page.offset),
      this.countCommissions()
    ]);

    return this.toPage(
      rows.map((row) => ({
        id: row.id,
        type: 'commission',
        status: row.status,
        ownerId: row.creatorId,
        title: row.orderItemId,
        amount: row.commissionAmount,
        currency: null,
        submittedAt: row.createdAt?.toISOString() ?? null
      })),
      page,
      total
    );
  }

  private async countCreatorApplications(): Promise<number> {
    const [row] = await this.database.db
      .select({ value: count() })
      .from(creatorApplications)
      .where(inArray(creatorApplications.status, applicationStatuses));
    return row?.value ?? 0;
  }

  private async countBrandApplications(): Promise<number> {
    const [row] = await this.database.db
      .select({ value: count() })
      .from(brandApplications)
      .where(inArray(brandApplications.status, applicationStatuses));
    return row?.value ?? 0;
  }

  private async countProducts(): Promise<number> {
    const [row] = await this.database.db.select({ value: count() }).from(products).where(inArray(products.status, productStatuses));
    return row?.value ?? 0;
  }

  private async countOutfits(): Promise<number> {
    const [row] = await this.database.db.select({ value: count() }).from(outfits).where(inArray(outfits.status, outfitStatuses));
    return row?.value ?? 0;
  }

  private async countOrders(): Promise<number> {
    const [row] = await this.database.db.select({ value: count() }).from(orders).where(inArray(orders.status, orderStatuses));
    return row?.value ?? 0;
  }

  private async countCommissions(): Promise<number> {
    const [row] = await this.database.db.select({ value: count() }).from(commissions).where(inArray(commissions.status, commissionStatuses));
    return row?.value ?? 0;
  }

  private toPage<T>(items: T[], page: { limit: number; offset: number }, total: number): AdminPage<T> {
    const nextOffset = page.offset + items.length < total ? page.offset + items.length : null;
    return {
      items,
      page: {
        limit: page.limit,
        offset: page.offset,
        total,
        nextOffset
      }
    };
  }
}

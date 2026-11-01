import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, gt, inArray, sql, sum } from 'drizzle-orm';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import {
  brandMembers,
  brandProfiles,
  commissions,
  creatorGrades,
  creatorProfiles,
  outfitItems,
  outfits,
  orders,
  productVariants,
  products
} from '../../../shared/infrastructure/database/schema';
import { WORKSPACE_MEMBERSHIP } from '../application/workspaces.service';
import type {
  BrandWorkspaceMetrics,
  BrandWorkspaceOrder,
  BrandWorkspaceOutfitIntegration,
  BrandWorkspaceProduct,
  BrandWorkspaceProfile,
  CreatorWorkspaceCommission,
  CreatorWorkspaceMetrics,
  CreatorWorkspaceOutfit,
  CreatorWorkspaceProfile,
  WorkspacePage,
  WorkspacePageInput,
  WorkspacesRepository
} from '../application/workspaces.service';

const MEMBERSHIP_ACTIVE = "active";
const paidOrderStatuses = ['paid', 'preparing', 'shipped', 'delivered'] as const;

@Injectable()
export class DrizzleWorkspacesRepository implements WorkspacesRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async listBrandsForUser(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ items: BrandWorkspaceProfile[]; nextCursor: string | null }> {
    const rows = await this.database.db
      .select({
        id: brandProfiles.id,
        brandName: brandProfiles.brandName,
        slug: brandProfiles.slug,
        status: brandProfiles.status,
        memberRole: brandMembers.role,
      })
      .from(brandMembers)
      .innerJoin(
        brandProfiles,
        eq(brandProfiles.id, brandMembers.brandProfileId),
      )
      .where(
        and(
          eq(brandMembers.userId, userId),
          eq(brandMembers.status, MEMBERSHIP_ACTIVE),
          cursor ? gt(brandProfiles.id, cursor) : undefined,
        ),
      )
      .orderBy(brandProfiles.id)
      .limit(limit + WORKSPACE_MEMBERSHIP.overflow);
    const items = rows
      .slice(undefined, limit)
      .map((row) => ({
        ...row,
        memberRole: row.memberRole as BrandWorkspaceProfile["memberRole"],
      }));
    return {
      items,
      nextCursor:
        rows.length > limit
          ? items.at(WORKSPACE_MEMBERSHIP.lastIndex)!.id
          : null,
    };
  }
  async findCreatorProfileByUserId(userId: string): Promise<CreatorWorkspaceProfile | null> {
    const [row] = await this.database.db
      .select({
        id: creatorProfiles.id,
        userId: creatorProfiles.userId,
        displayName: creatorProfiles.displayName,
        slug: creatorProfiles.slug,
        status: creatorProfiles.status,
        gradeCode: creatorProfiles.gradeCode,
        gradeLabel: creatorGrades.label,
        gradeRank: creatorGrades.rank,
        gradeCommissionBps: creatorGrades.commissionBps
      })
      .from(creatorProfiles)
      .leftJoin(creatorGrades, eq(creatorGrades.code, creatorProfiles.gradeCode))
      .where(eq(creatorProfiles.userId, userId))
      .limit(1);

    return row
      ? {
          id: row.id,
          userId: row.userId,
          displayName: row.displayName,
          slug: row.slug,
          status: row.status,
          grade: {
            code: row.gradeCode,
            label: row.gradeLabel ?? row.gradeCode,
            rank: row.gradeRank ?? 0,
            commissionBps: row.gradeCommissionBps ?? 0
          }
        }
      : null;
  }

  async getCreatorMetrics(creatorId: string): Promise<CreatorWorkspaceMetrics> {
    const [outfitRows, commissionRows, salesRow] = await Promise.all([
      this.database.db
        .select({ status: outfits.status, value: count() })
        .from(outfits)
        .where(eq(outfits.creatorId, creatorId))
        .groupBy(outfits.status),
      this.database.db
        .select({
          status: commissions.status,
          value: count(),
          amount: sum(commissions.commissionAmount)
        })
        .from(commissions)
        .where(eq(commissions.creatorId, creatorId))
        .groupBy(commissions.status),
      this.database.db
        .select({
          orderCount: count(),
          grossAmount: sum(orders.totalAmount)
        })
        .from(orders)
        .where(and(eq(orders.sourceCreatorId, creatorId), inArray(orders.status, paidOrderStatuses)))
    ]);

    const outfitCounts = new Map(outfitRows.map((row) => [row.status, row.value]));
    const commissionCounts = new Map(commissionRows.map((row) => [row.status, row.value]));
    const commissionAmounts = new Map(commissionRows.map((row) => [row.status, toNumber(row.amount)]));

    return {
      outfits: {
        total: outfitRows.reduce((total, row) => total + row.value, 0),
        draft: outfitCounts.get('draft') ?? 0,
        underReview: (outfitCounts.get('submitted') ?? 0) + (outfitCounts.get('under_review') ?? 0),
        published: outfitCounts.get('published') ?? 0,
        rejected: outfitCounts.get('rejected') ?? 0
      },
      commissions: {
        pendingAmount: commissionAmounts.get('pending') ?? 0,
        validatedAmount: commissionAmounts.get('validated') ?? 0,
        paidAmount: commissionAmounts.get('paid') ?? 0,
        totalAmount: [...commissionAmounts.values()].reduce((total, amount) => total + amount, 0),
        pendingCount: commissionCounts.get('pending') ?? 0,
        validatedCount: commissionCounts.get('validated') ?? 0,
        paidCount: commissionCounts.get('paid') ?? 0
      },
      sales: {
        paidOrderCount: salesRow[0]?.orderCount ?? 0,
        grossAmount: toNumber(salesRow[0]?.grossAmount),
        currency: 'CHF'
      }
    };
  }

  async listCreatorOutfits(creatorId: string, page: Required<WorkspacePageInput>): Promise<WorkspacePage<CreatorWorkspaceOutfit>> {
    const where = eq(outfits.creatorId, creatorId);
    const [rows, total] = await Promise.all([
      this.database.db
        .select()
        .from(outfits)
        .where(where)
        .orderBy(desc(outfits.updatedAt))
        .limit(page.limit)
        .offset(page.offset),
      this.database.db.select({ value: count() }).from(outfits).where(where)
    ]);

    return toPage(
      rows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        visibility: row.visibility,
        totalPriceMin: row.totalPriceMin,
        totalPriceMax: row.totalPriceMax,
        publishedAt: row.publishedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt?.toISOString() ?? null
      })),
      page,
      total[0]?.value ?? 0
    );
  }

  async listCreatorCommissions(
    creatorId: string,
    page: Required<WorkspacePageInput>
  ): Promise<WorkspacePage<CreatorWorkspaceCommission>> {
    const where = eq(commissions.creatorId, creatorId);
    const [rows, total] = await Promise.all([
      this.database.db
        .select()
        .from(commissions)
        .where(where)
        .orderBy(desc(commissions.createdAt))
        .limit(page.limit)
        .offset(page.offset),
      this.database.db.select({ value: count() }).from(commissions).where(where)
    ]);

    return toPage(
      rows.map((row) => ({
        id: row.id,
        orderItemId: row.orderItemId,
        brandId: row.brandId,
        sourceOutfitId: row.sourceOutfitId,
        status: row.status,
        baseAmount: row.baseAmount,
        commissionRate: Number(row.commissionRate),
        commissionAmount: row.commissionAmount,
        createdAt: row.createdAt?.toISOString() ?? null
      })),
      page,
      total[0]?.value ?? 0
    );
  }

  async findBrandProfileForMember(brandProfileId: string, userId: string): Promise<BrandWorkspaceProfile | null> {
    const [row] = await this.database.db
      .select({
        id: brandProfiles.id,
        brandName: brandProfiles.brandName,
        slug: brandProfiles.slug,
        status: brandProfiles.status,
        memberRole: brandMembers.role
      })
      .from(brandProfiles)
      .innerJoin(
        brandMembers,
        and(
          eq(brandMembers.brandProfileId, brandProfiles.id),
          eq(brandMembers.userId, userId),
          eq(brandMembers.status, 'active')
        )
      )
      .where(eq(brandProfiles.id, brandProfileId))
      .limit(1);

    return row ?? null;
  }

  async getBrandMetrics(brandProfileId: string): Promise<BrandWorkspaceMetrics> {
    const [productRows, orderRows, salesRow, lowStockRow] = await Promise.all([
      this.database.db
        .select({ status: products.status, value: count() })
        .from(products)
        .where(eq(products.brandId, brandProfileId))
        .groupBy(products.status),
      this.database.db
        .select({ status: orders.status, value: count() })
        .from(orders)
        .where(eq(orders.brandId, brandProfileId))
        .groupBy(orders.status),
      this.database.db
        .select({
          orderCount: count(),
          grossAmount: sum(orders.totalAmount)
        })
        .from(orders)
        .where(and(eq(orders.brandId, brandProfileId), inArray(orders.status, paidOrderStatuses))),
      this.database.db
        .select({ value: count() })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(and(eq(products.brandId, brandProfileId), eq(productVariants.status, 'active'), sql`${productVariants.stockQuantity} <= 3`))
    ]);

    const productCounts = new Map(productRows.map((row) => [row.status, row.value]));
    const orderCounts = new Map(orderRows.map((row) => [row.status, row.value]));

    return {
      products: {
        total: productRows.reduce((total, row) => total + row.value, 0),
        draft: productCounts.get('draft') ?? 0,
        underReview: productCounts.get('under_review') ?? 0,
        active: productCounts.get('active') ?? 0,
        rejected: productCounts.get('rejected') ?? 0,
        archived: productCounts.get('archived') ?? 0
      },
      orders: {
        paid: orderCounts.get('paid') ?? 0,
        preparing: orderCounts.get('preparing') ?? 0,
        shipped: orderCounts.get('shipped') ?? 0,
        delivered: orderCounts.get('delivered') ?? 0,
        cancelled: orderCounts.get('cancelled') ?? 0,
        refunded: orderCounts.get('refunded') ?? 0
      },
      sales: {
        paidOrderCount: salesRow[0]?.orderCount ?? 0,
        grossAmount: toNumber(salesRow[0]?.grossAmount),
        currency: 'CHF'
      },
      stock: {
        lowStockVariants: lowStockRow[0]?.value ?? 0
      }
    };
  }

  async listBrandProducts(brandProfileId: string, page: Required<WorkspacePageInput>): Promise<WorkspacePage<BrandWorkspaceProduct>> {
    const where = eq(products.brandId, brandProfileId);
    const [productRows, total] = await Promise.all([
      this.database.db
        .select()
        .from(products)
        .where(where)
        .orderBy(desc(products.updatedAt))
        .limit(page.limit)
        .offset(page.offset),
      this.database.db.select({ value: count() }).from(products).where(where)
    ]);

    const productIds = productRows.map((product) => product.id);
    const variantRows = productIds.length
      ? await this.database.db.select().from(productVariants).where(inArray(productVariants.productId, productIds))
      : [];

    return toPage(
      productRows.map((product) => {
        const variants = variantRows.filter((variant) => variant.productId === product.id);
        return {
          id: product.id,
          name: product.name,
          status: product.status,
          category: product.category,
          basePrice: product.basePrice,
          currency: product.currency,
          totalStock: variants.reduce((total, variant) => total + variant.stockQuantity, 0),
          activeVariants: variants.filter((variant) => variant.status === 'active').length,
          updatedAt: product.updatedAt?.toISOString() ?? null
        };
      }),
      page,
      total[0]?.value ?? 0
    );
  }

  async listBrandOrders(brandProfileId: string, page: Required<WorkspacePageInput>): Promise<WorkspacePage<BrandWorkspaceOrder>> {
    const where = eq(orders.brandId, brandProfileId);
    const [rows, total] = await Promise.all([
      this.database.db
        .select()
        .from(orders)
        .where(where)
        .orderBy(desc(orders.createdAt))
        .limit(page.limit)
        .offset(page.offset),
      this.database.db.select({ value: count() }).from(orders).where(where)
    ]);

    return toPage(
      rows.map((row) => ({
        id: row.id,
        orderNumber: row.orderNumber,
        status: row.status,
        totalAmount: row.totalAmount,
        currency: row.currency,
        sourceCreatorId: row.sourceCreatorId,
        sourceOutfitId: row.sourceOutfitId,
        createdAt: row.createdAt?.toISOString() ?? null
      })),
      page,
      total[0]?.value ?? 0
    );
  }

  async listBrandOutfitIntegrations(
    brandProfileId: string,
    page: Required<WorkspacePageInput>
  ): Promise<WorkspacePage<BrandWorkspaceOutfitIntegration>> {
    const [rows, totalRow] = await Promise.all([
      this.database.db
        .select({
          outfitId: outfits.id,
          title: outfits.title,
          status: outfits.status,
          visibility: outfits.visibility,
          creatorId: outfits.creatorId,
          totalPriceMax: outfits.totalPriceMax,
          publishedAt: outfits.publishedAt,
          updatedAt: outfits.updatedAt,
          productCount: sql<number>`count(distinct ${outfitItems.productId})`
        })
        .from(outfits)
        .innerJoin(outfitItems, eq(outfitItems.outfitId, outfits.id))
        .innerJoin(products, eq(products.id, outfitItems.productId))
        .where(eq(products.brandId, brandProfileId))
        .groupBy(
          outfits.id,
          outfits.title,
          outfits.status,
          outfits.visibility,
          outfits.creatorId,
          outfits.totalPriceMax,
          outfits.publishedAt,
          outfits.updatedAt
        )
        .orderBy(desc(outfits.updatedAt))
        .limit(page.limit)
        .offset(page.offset),
      this.database.db
        .select({ value: sql<number>`count(distinct ${outfits.id})` })
        .from(outfits)
        .innerJoin(outfitItems, eq(outfitItems.outfitId, outfits.id))
        .innerJoin(products, eq(products.id, outfitItems.productId))
        .where(eq(products.brandId, brandProfileId))
    ]);

    return toPage(
      rows.map((row) => ({
        outfitId: row.outfitId,
        title: row.title,
        status: row.status,
        visibility: row.visibility,
        creatorId: row.creatorId,
        productCount: toNumber(row.productCount),
        totalPriceMax: row.totalPriceMax,
        publishedAt: row.publishedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt?.toISOString() ?? null
      })),
      page,
      toNumber(totalRow[0]?.value)
    );
  }
}

function toPage<T>(items: T[], page: Required<WorkspacePageInput>, total: number): WorkspacePage<T> {
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

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return Number(value);
  }
  return 0;
}

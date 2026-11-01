import {OUTFIT_STATUS} from '../../outfits/domain/outfit-editing.contract';
import {PRODUCT_STATUS, PRODUCT_VARIANT_STATUS} from '../../products/domain/product-contract';
import {ORDER_STATUS} from '../../orders/domain/order-lifecycle';
import {READ_SNAPSHOT, type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {findIdentityAccess, IdentityAccessMode} from '../../identity/infrastructure/persistence/identity-access';
import {DrizzleWorkspaceFinanceReader} from './drizzle-workspace-finance.reader';
import {WORKSPACE_FINANCE as FINANCE} from '../domain/workspace-finance';
import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import {
  brandMembers,
  brandProfiles,
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

@Injectable()
export class DrizzleWorkspacesRepository implements WorkspacesRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}

  snapshot<T>(operation: (repository: WorkspacesRepository) => Promise<T>): Promise<T> {
    return this.database.db.transaction(tx => operation(new DrizzleWorkspacesRepository({db: tx})), READ_SNAPSHOT);
  }
  actorAccess(userId: string) { return findIdentityAccess(this.database, userId, IdentityAccessMode.Read); }

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
    const outfitRows = await this.database.db
        .select({ status: outfits.status, value: count() })
        .from(outfits)
        .where(eq(outfits.creatorId, creatorId))
        .groupBy(outfits.status);
    const finance = new DrizzleWorkspaceFinanceReader(this.database);
    const commissionCurrencies = await finance.creatorCommissions(creatorId);
    const sales = await finance.sales({kind: FINANCE.scope.creator, profileId: creatorId});

    const outfitCounts = new Map(outfitRows.map((row) => [row.status, row.value]));

    return {
      outfits: {
        total: outfitRows.reduce<number>((total, row) => total + row.value, FINANCE.zero),
        draft: outfitCounts.get(OUTFIT_STATUS.draft) ?? FINANCE.zero,
        underReview: (outfitCounts.get(OUTFIT_STATUS.submitted) ?? FINANCE.zero) + (outfitCounts.get(OUTFIT_STATUS.underReview) ?? FINANCE.zero),
        published: outfitCounts.get(OUTFIT_STATUS.published) ?? FINANCE.zero,
        rejected: outfitCounts.get(OUTFIT_STATUS.rejected) ?? FINANCE.zero
      },
      commissions: commissionCurrencies,
      sales
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
    return new DrizzleWorkspaceFinanceReader(this.database).commissionPage(creatorId, page);
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
    const productRows = await this.database.db
        .select({ status: products.status, value: count() })
        .from(products)
        .where(eq(products.brandId, brandProfileId))
        .groupBy(products.status);
    const orderRows = await this.database.db
        .select({ status: orders.status, value: count() })
        .from(orders)
        .where(eq(orders.brandId, brandProfileId))
        .groupBy(orders.status);
    const sales = await new DrizzleWorkspaceFinanceReader(this.database).sales({kind: FINANCE.scope.brand, profileId: brandProfileId});
    const lowStockRow = await this.database.db
        .select({ value: count() })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(and(eq(products.brandId, brandProfileId), eq(productVariants.status, PRODUCT_VARIANT_STATUS.active), sql`${productVariants.stockQuantity} <= ${FINANCE.lowStockThreshold}`));

    const productCounts = new Map(productRows.map((row) => [row.status, row.value]));
    const orderCounts = new Map(orderRows.map((row) => [row.status, row.value]));

    return {
      products: {
        total: productRows.reduce<number>((total, row) => total + row.value, FINANCE.zero),
        draft: productCounts.get(PRODUCT_STATUS.draft) ?? FINANCE.zero,
        underReview: productCounts.get(PRODUCT_STATUS.underReview) ?? FINANCE.zero,
        active: productCounts.get(PRODUCT_STATUS.active) ?? FINANCE.zero,
        rejected: productCounts.get(PRODUCT_STATUS.rejected) ?? FINANCE.zero,
        archived: productCounts.get(PRODUCT_STATUS.archived) ?? FINANCE.zero
      },
      orders: {
        paid: orderCounts.get(ORDER_STATUS.paid) ?? FINANCE.zero,
        preparing: orderCounts.get(ORDER_STATUS.preparing) ?? FINANCE.zero,
        shipped: orderCounts.get(ORDER_STATUS.shipped) ?? FINANCE.zero,
        delivered: orderCounts.get(ORDER_STATUS.delivered) ?? FINANCE.zero,
        cancelled: orderCounts.get(ORDER_STATUS.cancelled) ?? FINANCE.zero,
        refunded: orderCounts.get(ORDER_STATUS.refunded) ?? FINANCE.zero
      },
      sales,
      stock: {
        lowStockVariants: lowStockRow[0]?.value ?? FINANCE.zero
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

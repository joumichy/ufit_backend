import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, inArray, isNull, isNotNull, or, exists } from 'drizzle-orm';
import {READ_SNAPSHOT, type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {PUBLIC_PROFILE} from '../../../shared/domain/public-profile.contract';
import {PUBLIC_OUTFIT, PUBLIC_OUTFIT_VISIBILITIES, type PublicOutfitPage} from '../domain/public-outfit.contract';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import { brandProfiles, creatorProfiles, outfitImages, outfitItems, outfits, users } from '../../../shared/infrastructure/database/schema';
import type { Outfit, OutfitAuthor, OutfitDetail, OutfitImage, OutfitItem, OutfitRepository, OutfitStatus, OutfitVisibility } from '../domain/outfit.types';

@Injectable()
export class DrizzleOutfitRepository implements OutfitRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}

  async createOutfit(input: Parameters<OutfitRepository['createOutfit']>[0]): Promise<Outfit> {
    const [row] = await this.database.db
      .insert(outfits)
      .values({ ...input, status: 'draft', visibility: 'private', totalPriceMin: 0, totalPriceMax: 0, publishedAt: null })
      .returning();
    return row;
  }

  async addItems(outfitId: string, items: Parameters<OutfitRepository['addItems']>[1]): Promise<OutfitItem[]> {
    if (!items.length) {
      return [];
    }
    return this.database.db.insert(outfitItems).values(items.map((item) => ({ ...item, outfitId }))).returning();
  }

  async addImages(outfitId: string, images: Parameters<OutfitRepository['addImages']>[1]): Promise<OutfitImage[]> {
    if (!images.length) {
      return [];
    }
    return this.database.db.insert(outfitImages).values(images.map((image) => ({ ...image, outfitId }))).returning();
  }

  async findById(outfitId: string): Promise<OutfitDetail | null> {
    return this.database.db.transaction(async tx => {
      const rows = await tx.select().from(outfits).where(eq(outfits.id, outfitId));
      const details = await this.loadDetails(rows, {db: tx});
      return details[PUBLIC_OUTFIT.limits.first] ?? null;
    }, READ_SNAPSHOT);
  }

  private async loadDetails(rows: Outfit[], database: DatabaseSession): Promise<OutfitDetail[]> {
    if (!rows.length) return [];
    const ids = rows.map(row => row.id), creatorIDs = rows.flatMap(row => row.creatorId ? [row.creatorId] : []), brandIDs = rows.flatMap(row => row.brandId ? [row.brandId] : []);
    const items = await database.db.select().from(outfitItems).where(inArray(outfitItems.outfitId, ids)).orderBy(outfitItems.position, outfitItems.id);
    const images = await database.db.select().from(outfitImages).where(inArray(outfitImages.outfitId, ids)).orderBy(outfitImages.position, outfitImages.id);
    const creators = creatorIDs.length ? await database.db.select({id: creatorProfiles.id, name: creatorProfiles.displayName, avatarUrl: creatorProfiles.avatarUrl})
      .from(creatorProfiles).innerJoin(users, eq(creatorProfiles.userId, users.id))
      .where(and(inArray(creatorProfiles.id, creatorIDs), eq(creatorProfiles.status, PUBLIC_PROFILE.status), eq(users.status, PUBLIC_PROFILE.userStatus))) : [];
    const brands = brandIDs.length ? await database.db.select({id: brandProfiles.id, name: brandProfiles.brandName}).from(brandProfiles)
      .where(and(inArray(brandProfiles.id, brandIDs), eq(brandProfiles.status, PUBLIC_PROFILE.status))) : [];
    const authorByCreator = new Map<string, OutfitAuthor>(creators.map(row => [row.id, {...row, kind: PUBLIC_PROFILE.kind.creator}]));
    const authorByBrand = new Map<string, OutfitAuthor>(brands.map(row => [row.id, {...row, kind: PUBLIC_PROFILE.kind.brand, avatarUrl: null}]));
    return rows.map(outfit => ({outfit, items: items.filter(row => row.outfitId === outfit.id), images: images.filter(row => row.outfitId === outfit.id),
      author: outfit.creatorId ? authorByCreator.get(outfit.creatorId) ?? null : outfit.brandId ? authorByBrand.get(outfit.brandId) ?? null : null}));
  }

  async updateStatus(
    outfitId: string,
    status: OutfitStatus,
    visibility: OutfitVisibility,
    reviewerId?: string,
    rejectionReason?: string
  ): Promise<Outfit> {
    const [row] = await this.database.db
      .update(outfits)
      .set({
        status,
        visibility,
        reviewedBy: reviewerId,
        reviewedAt: status === 'published' || status === 'rejected' ? new Date() : null,
        rejectionReason: status === 'rejected' ? rejectionReason : null,
        publishedAt: status === 'published' ? new Date() : null,
        updatedAt: new Date()
      })
      .where(eq(outfits.id, outfitId))
      .returning();
    return row;
  }

  async updateTotals(outfitId: string, totalPriceMin: number, totalPriceMax: number): Promise<Outfit> {
    const [row] = await this.database.db
      .update(outfits)
      .set({ totalPriceMin, totalPriceMax, updatedAt: new Date() })
      .where(eq(outfits.id, outfitId))
      .returning();
    return row;
  }

  async findPublishedPage(input: PublicOutfitPage): Promise<OutfitDetail[]> {
    return this.database.db.transaction(async tx => {
      const creator = tx.select({id: creatorProfiles.id}).from(creatorProfiles).innerJoin(users, eq(users.id, creatorProfiles.userId))
        .where(and(eq(creatorProfiles.id, outfits.creatorId), eq(creatorProfiles.status, PUBLIC_PROFILE.status), eq(users.status, PUBLIC_PROFILE.userStatus)));
      const brand = tx.select({id: brandProfiles.id}).from(brandProfiles).where(and(eq(brandProfiles.id, outfits.brandId), eq(brandProfiles.status, PUBLIC_PROFILE.status)));
      const visibleOwner = or(and(isNull(outfits.creatorId), isNull(outfits.brandId)),
        and(isNotNull(outfits.creatorId), isNull(outfits.brandId), exists(creator)),
        and(isNull(outfits.creatorId), isNotNull(outfits.brandId), exists(brand)));
      const rows = await tx.select().from(outfits).where(and(eq(outfits.status, PUBLIC_OUTFIT.status), inArray(outfits.visibility, PUBLIC_OUTFIT_VISIBILITIES), visibleOwner,
        input.creatorId ? eq(outfits.creatorId, input.creatorId) : undefined, input.brandId ? eq(outfits.brandId, input.brandId) : undefined,
        input.cursor ? lt(outfits.id, input.cursor) : undefined)).orderBy(desc(outfits.id)).limit(input.limit);
      return this.loadDetails(rows, {db: tx});
    }, READ_SNAPSHOT);
  }
}

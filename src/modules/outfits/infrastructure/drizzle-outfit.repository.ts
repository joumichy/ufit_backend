import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import { outfitImages, outfitItems, outfits } from '../../../shared/infrastructure/database/schema';
import type { Outfit, OutfitDetail, OutfitImage, OutfitItem, OutfitRepository, OutfitStatus, OutfitVisibility } from '../domain/outfit.types';

@Injectable()
export class DrizzleOutfitRepository implements OutfitRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

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
    const [outfit] = await this.database.db.select().from(outfits).where(eq(outfits.id, outfitId)).limit(1);
    if (!outfit) {
      return null;
    }

    const [items, images] = await Promise.all([
      this.database.db.select().from(outfitItems).where(eq(outfitItems.outfitId, outfitId)),
      this.database.db.select().from(outfitImages).where(eq(outfitImages.outfitId, outfitId))
    ]);
    return { outfit, items, images };
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

  async findPublishedPage(input: { limit: number; cursor?: string }): Promise<OutfitDetail[]> {
    const where = input.cursor ? and(eq(outfits.status, 'published'), lt(outfits.id, input.cursor)) : eq(outfits.status, 'published');
    const rows = await this.database.db.select().from(outfits).where(where).orderBy(desc(outfits.id)).limit(input.limit);
    const details = await Promise.all(rows.map((outfit) => this.findById(outfit.id)));
    return details.filter((detail): detail is OutfitDetail => Boolean(detail));
  }
}

import { Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import { creatorFollows, outfits, savedOutfits } from '../../../shared/infrastructure/database/schema';
import type { SavedOutfit, SavedRepository } from '../application/saved.service';

@Injectable()
export class DrizzleSavedRepository implements SavedRepository {
  constructor(private readonly database: DatabaseService) {}

  async saveOutfit(userId: string, outfitId: string): Promise<void> {
    await this.database.db
      .insert(savedOutfits)
      .values({ userId, outfitId })
      .onConflictDoNothing({ target: [savedOutfits.userId, savedOutfits.outfitId] });
  }

  async unsaveOutfit(userId: string, outfitId: string): Promise<void> {
    await this.database.db
      .delete(savedOutfits)
      .where(and(eq(savedOutfits.userId, userId), eq(savedOutfits.outfitId, outfitId)));
  }

  async followCreator(userId: string, creatorId: string): Promise<void> {
    await this.database.db
      .insert(creatorFollows)
      .values({ userId, creatorId })
      .onConflictDoNothing({ target: [creatorFollows.userId, creatorFollows.creatorId] });
  }

  async unfollowCreator(userId: string, creatorId: string): Promise<void> {
    await this.database.db
      .delete(creatorFollows)
      .where(and(eq(creatorFollows.userId, userId), eq(creatorFollows.creatorId, creatorId)));
  }

  async findSavedOutfits(userId: string, input: { limit: number }): Promise<SavedOutfit[]> {
    const rows = await this.database.db
      .select({
        id: outfits.id,
        title: outfits.title,
        coverImageUrl: outfits.coverImageUrl,
        totalPriceMin: outfits.totalPriceMin,
        totalPriceMax: outfits.totalPriceMax,
        publishedAt: outfits.publishedAt,
        savedAt: savedOutfits.createdAt
      })
      .from(savedOutfits)
      .innerJoin(outfits, eq(savedOutfits.outfitId, outfits.id))
      .where(and(eq(savedOutfits.userId, userId), eq(outfits.status, 'published')))
      .orderBy(desc(savedOutfits.createdAt))
      .limit(input.limit);

    return rows;
  }
}

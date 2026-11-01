import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import { creatorFollows, creatorProfiles, users, outfits, savedOutfits } from '../../../shared/infrastructure/database/schema';
import {PUBLIC_PROFILE} from '../../../shared/domain/public-profile.contract';
import {PROFILE_EDITING} from '../../../shared/domain/profile-editing.contract';
import {PUBLIC_CREATOR} from '../../creators/public-creator.contract';
import type { SavedOutfit, SavedRepository } from '../application/saved.service';

@Injectable()
export class DrizzleSavedRepository implements SavedRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

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
    await this.database.db.transaction(async tx => {
      const rows = await tx.select({id: creatorProfiles.id}).from(creatorProfiles).innerJoin(users, eq(users.id, creatorProfiles.userId))
        .where(and(eq(creatorProfiles.id, creatorId), eq(creatorProfiles.status, PUBLIC_PROFILE.status), eq(users.status, PUBLIC_PROFILE.userStatus)))
        .for(PROFILE_EDITING.persistence.lock);
      if (!rows.length) throw new NotFoundException(PUBLIC_CREATOR.missing);
      await tx.insert(creatorFollows).values({ userId, creatorId }).onConflictDoNothing({ target: [creatorFollows.userId, creatorFollows.creatorId] });
    });
  }

  async findCreatorFollow(userId: string, creatorId: string): Promise<boolean | null> {
    const rows = await this.database.db.select({following: sql<boolean>`exists (select ${PROFILE_EDITING.persistence.existsProjection} from ${creatorFollows}
      where ${and(eq(creatorFollows.creatorId, creatorProfiles.id), eq(creatorFollows.userId, userId))})`})
      .from(creatorProfiles).innerJoin(users, eq(users.id, creatorProfiles.userId))
      .where(and(eq(creatorProfiles.id, creatorId), eq(creatorProfiles.status, PUBLIC_PROFILE.status), eq(users.status, PUBLIC_PROFILE.userStatus)));
    return rows[PUBLIC_PROFILE.first]?.following ?? null;
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

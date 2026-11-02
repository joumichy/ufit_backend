import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import { creatorFollows, creatorProfiles, users, outfits, savedOutfits } from '../../../shared/infrastructure/database/schema';
import {PUBLIC_PROFILE} from '../../../shared/domain/public-profile.contract';
import {PROFILE_EDITING} from '../../../shared/domain/profile-editing.contract';
import {PUBLIC_CREATOR} from '../../creators/public-creator.contract';
import type {SavedRepository} from '../application/saved.service';
import {SAVED_OUTFITS, type SavedOutfitQuery, type SavedOutfitReference} from '../domain/saved-outfits.contract';
import {publicOutfitVisibility} from '../../outfits/infrastructure/public-outfit-visibility';

const savedPersistence = {lock: 'share', utc: 'UTC', timestamp: 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'} as const;

@Injectable()
export class DrizzleSavedRepository implements SavedRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}

  async saveOutfit(userId: string, outfitId: string): Promise<void> {
    await this.database.db.transaction(async tx => {
      const rows = await tx.select({id: outfits.id}).from(outfits)
        .where(and(eq(outfits.id, outfitId), publicOutfitVisibility({db: tx}))).for(savedPersistence.lock);
      if (!rows.length) throw new NotFoundException(SAVED_OUTFITS.failure.missing);
      await tx.insert(savedOutfits).values({userId, outfitId})
        .onConflictDoNothing({target: [savedOutfits.userId, savedOutfits.outfitId]});
    });
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

  async findSavedOutfits(userId: string, input: SavedOutfitQuery): Promise<SavedOutfitReference[]> {
    const rows = await this.database.db
      .select({
        id: outfits.id,
        savedAt: sql<string>`to_char(${savedOutfits.createdAt} at time zone ${savedPersistence.utc}, ${savedPersistence.timestamp})`
      })
      .from(savedOutfits)
      .innerJoin(outfits, eq(savedOutfits.outfitId, outfits.id))
      .where(and(eq(savedOutfits.userId, userId), publicOutfitVisibility(this.database), input.cursor ?
        sql`(${savedOutfits.createdAt}, ${savedOutfits.outfitId}) < (${input.cursor.savedAt}::timestamptz, ${input.cursor.id}::uuid)` : undefined))
      .orderBy(desc(savedOutfits.createdAt), desc(savedOutfits.outfitId))
      .limit(input.limit);

    return rows;
  }
  async findSavedOutfitIDs(userId: string, ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const rows = await this.database.db.select({id: savedOutfits.outfitId}).from(savedOutfits)
      .innerJoin(outfits, eq(outfits.id, savedOutfits.outfitId))
      .where(and(eq(savedOutfits.userId, userId), inArray(savedOutfits.outfitId, ids), publicOutfitVisibility(this.database)));
    return rows.map(row => row.id);
  }
}

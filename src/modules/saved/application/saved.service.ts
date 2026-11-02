import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {PUBLIC_CREATOR} from '../../creators/public-creator.contract';
import {SAVED_OUTFITS, savedOutfitCursor, savedOutfitIdentities, savedOutfitQuery, savedOutfitReferenceSchema,
  type SavedOutfitPage, type SavedOutfitQuery, type SavedOutfitReference} from '../domain/saved-outfits.contract';

export interface SavedRepository {
  saveOutfit(userId: string, outfitId: string): Promise<void>;
  unsaveOutfit(userId: string, outfitId: string): Promise<void>;
  followCreator(userId: string, creatorId: string): Promise<void>;
  unfollowCreator(userId: string, creatorId: string): Promise<void>;
  findCreatorFollow(userId: string, creatorId: string): Promise<boolean | null>;
  findSavedOutfits(userId: string, input: SavedOutfitQuery): Promise<SavedOutfitReference[]>;
  findSavedOutfitIDs(userId: string, ids: string[]): Promise<string[]>;
}

@Injectable()
export class SavedService {
  constructor(@Inject(SAVED_OUTFITS.repository) private readonly saved: SavedRepository) {}

  async getCreatorFollow(userId: string, creatorId: string): Promise<{following: boolean}> {
    const following = await this.saved.findCreatorFollow(userId, creatorId);
    if (following === null) throw new NotFoundException(PUBLIC_CREATOR.missing);
    return {following};
  }

  async saveOutfit(userId: string, outfitId: string): Promise<{ saved: true }> {
    await this.saved.saveOutfit(userId, outfitId.toLowerCase());
    return { saved: true };
  }

  async unsaveOutfit(userId: string, outfitId: string): Promise<{ saved: false }> {
    await this.saved.unsaveOutfit(userId, outfitId.toLowerCase());
    return { saved: false };
  }

  async followCreator(userId: string, creatorId: string): Promise<{ following: true }> {
    await this.saved.followCreator(userId, creatorId);
    return { following: true };
  }

  async unfollowCreator(userId: string, creatorId: string): Promise<{ following: false }> {
    await this.saved.unfollowCreator(userId, creatorId);
    return { following: false };
  }

  async listSavedOutfits(userId: string, input: unknown): Promise<SavedOutfitPage> {
    const query = savedOutfitQuery(input);
    const rows = await this.saved.findSavedOutfits(userId, {...query, limit: query.limit + SAVED_OUTFITS.page.overflow});
    const items = rows.slice(SAVED_OUTFITS.page.first, query.limit).map(row => savedOutfitReferenceSchema.parse(row));
    return {items, nextCursor: rows.length > query.limit ? savedOutfitCursor(items.at(SAVED_OUTFITS.page.last)!) : null};
  }
  async savedOutfitStates(userId: string, input: unknown): Promise<{items: Array<{id: string; saved: boolean}>}> {
    const ids = savedOutfitIdentities(input), savedIDs = new Set(await this.saved.findSavedOutfitIDs(userId, ids));
    return {items: ids.map(id => ({id, saved: savedIDs.has(id)}))};
  }
}

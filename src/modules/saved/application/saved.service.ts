import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {PUBLIC_CREATOR} from '../../creators/public-creator.contract';

export interface SavedRepository {
  saveOutfit(userId: string, outfitId: string): Promise<void>;
  unsaveOutfit(userId: string, outfitId: string): Promise<void>;
  followCreator(userId: string, creatorId: string): Promise<void>;
  unfollowCreator(userId: string, creatorId: string): Promise<void>;
  findCreatorFollow(userId: string, creatorId: string): Promise<boolean | null>;
  findSavedOutfits(userId: string, input: { limit: number }): Promise<SavedOutfit[]>;
}

export interface SavedOutfit {
  id: string;
  savedAt: Date;
}
export interface SavedOutfitResponse { id: string; savedAt: string }

@Injectable()
export class SavedService {
  constructor(@Inject('SavedRepository') private readonly saved: SavedRepository) {}

  async getCreatorFollow(userId: string, creatorId: string): Promise<{following: boolean}> {
    const following = await this.saved.findCreatorFollow(userId, creatorId);
    if (following === null) throw new NotFoundException(PUBLIC_CREATOR.missing);
    return {following};
  }

  async saveOutfit(userId: string, outfitId: string): Promise<{ saved: true }> {
    await this.saved.saveOutfit(userId, outfitId);
    return { saved: true };
  }

  async unsaveOutfit(userId: string, outfitId: string): Promise<{ saved: false }> {
    await this.saved.unsaveOutfit(userId, outfitId);
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

  async listSavedOutfits(userId: string, input: { limit?: number }): Promise<{ items: SavedOutfitResponse[] }> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const items = await this.saved.findSavedOutfits(userId, { limit });

    return {
      items: items.map(item => ({ id: item.id, savedAt: item.savedAt.toISOString() }))
    };
  }
}

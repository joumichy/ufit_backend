import { Injectable } from '@nestjs/common';
import type { SavedOutfit, SavedRepository } from '../application/saved.service';

@Injectable()
export class InMemorySavedRepository implements SavedRepository {
  private readonly outfits = new Set<string>();
  private readonly follows = new Set<string>();

  async saveOutfit(userId: string, outfitId: string): Promise<void> {
    this.outfits.add(`${userId}:${outfitId}`);
  }

  async unsaveOutfit(userId: string, outfitId: string): Promise<void> {
    this.outfits.delete(`${userId}:${outfitId}`);
  }

  async followCreator(userId: string, creatorId: string): Promise<void> {
    this.follows.add(`${userId}:${creatorId}`);
  }

  async unfollowCreator(userId: string, creatorId: string): Promise<void> {
    this.follows.delete(`${userId}:${creatorId}`);
  }

  async findSavedOutfits(_userId: string, _input: { limit: number }): Promise<SavedOutfit[]> {
    return [];
  }
}

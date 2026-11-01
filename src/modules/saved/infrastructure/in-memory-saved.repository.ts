import { Injectable, NotFoundException } from '@nestjs/common';
import {PUBLIC_CREATOR} from '../../creators/public-creator.contract';
import type { SavedOutfit, SavedRepository } from '../application/saved.service';

const referenceSeparator = ':';

@Injectable()
export class InMemorySavedRepository implements SavedRepository {
  private readonly outfits = new Set<string>();
  private readonly follows = new Set<string>();
  readonly activeCreators = new Set<string>();

  async saveOutfit(userId: string, outfitId: string): Promise<void> {
    this.outfits.add(`${userId}${referenceSeparator}${outfitId}`);
  }

  async unsaveOutfit(userId: string, outfitId: string): Promise<void> {
    this.outfits.delete(`${userId}${referenceSeparator}${outfitId}`);
  }

  async followCreator(userId: string, creatorId: string): Promise<void> {
    if (!this.activeCreators.has(creatorId)) throw new NotFoundException(PUBLIC_CREATOR.missing);
    this.follows.add(`${userId}${referenceSeparator}${creatorId}`);
  }

  async unfollowCreator(userId: string, creatorId: string): Promise<void> {
    this.follows.delete(`${userId}${referenceSeparator}${creatorId}`);
  }
  async findCreatorFollow(userId: string, creatorId: string): Promise<boolean | null> {
    return this.activeCreators.has(creatorId) ? this.follows.has(`${userId}${referenceSeparator}${creatorId}`) : null;
  }

  async findSavedOutfits(_userId: string, _input: { limit: number }): Promise<SavedOutfit[]> {
    return [];
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import {PUBLIC_CREATOR} from '../../creators/public-creator.contract';
import type {SavedRepository} from '../application/saved.service';
import {SAVED_OUTFITS, type SavedOutfitQuery, type SavedOutfitReference} from '../domain/saved-outfits.contract';

const referenceSeparator = ':';
const timestampPrecision = {millisecondsSuffix: 'Z', microsecondsSuffix: '000Z'} as const;

@Injectable()
export class InMemorySavedRepository implements SavedRepository {
  private readonly outfits = new Map<string, SavedOutfitReference>();
  private readonly follows = new Set<string>();
  readonly activeCreators = new Set<string>();
  readonly publicOutfits = new Set<string>();

  async saveOutfit(userId: string, outfitId: string): Promise<void> {
    if (!this.publicOutfits.has(outfitId)) throw new NotFoundException(SAVED_OUTFITS.failure.missing);
    const key = `${userId}${referenceSeparator}${outfitId}`;
    if (!this.outfits.has(key)) this.outfits.set(key, {id: outfitId,
      savedAt: new Date().toISOString().replace(timestampPrecision.millisecondsSuffix, timestampPrecision.microsecondsSuffix)});
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

  async findSavedOutfits(userId: string, input: SavedOutfitQuery): Promise<SavedOutfitReference[]> {
    return [...this.outfits].filter(([key, item]) => key.startsWith(userId + referenceSeparator) && this.publicOutfits.has(item.id))
      .map(([, item]) => item).filter(item => !input.cursor || item.savedAt < input.cursor.savedAt ||
        (item.savedAt === input.cursor.savedAt && item.id < input.cursor.id))
      .sort((left, right) => right.savedAt.localeCompare(left.savedAt) || right.id.localeCompare(left.id))
      .slice(SAVED_OUTFITS.page.first, input.limit);
  }
  async findSavedOutfitIDs(userId: string, ids: string[]): Promise<string[]> {
    return ids.filter(id => this.publicOutfits.has(id) && this.outfits.has(`${userId}${referenceSeparator}${id}`));
  }
}

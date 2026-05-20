import { Inject, Injectable } from '@nestjs/common';

export interface SavedRepository {
  saveOutfit(userId: string, outfitId: string): Promise<void>;
  unsaveOutfit(userId: string, outfitId: string): Promise<void>;
  followCreator(userId: string, creatorId: string): Promise<void>;
  unfollowCreator(userId: string, creatorId: string): Promise<void>;
  findSavedOutfits(userId: string, input: { limit: number }): Promise<SavedOutfit[]>;
}

export interface SavedOutfit {
  id: string;
  title: string;
  coverImageUrl: string;
  totalPriceMin: number;
  totalPriceMax: number;
  publishedAt: Date | null;
  savedAt: Date;
}

export interface SavedOutfitResponse {
  id: string;
  title: string;
  coverImageUrl: string;
  totalPriceMin: number;
  totalPriceMax: number;
  publishedAt: string | null;
  savedAt: string;
}

@Injectable()
export class SavedService {
  constructor(@Inject('SavedRepository') private readonly saved: SavedRepository) {}

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
      items: items.map((item) => ({
        id: item.id,
        title: item.title,
        coverImageUrl: item.coverImageUrl,
        totalPriceMin: item.totalPriceMin,
        totalPriceMax: item.totalPriceMax,
        publishedAt: item.publishedAt?.toISOString() ?? null,
        savedAt: item.savedAt.toISOString()
      }))
    };
  }
}

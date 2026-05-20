import { Inject, Injectable } from '@nestjs/common';

export interface SavedRepository {
  saveOutfit(userId: string, outfitId: string): Promise<void>;
  unsaveOutfit(userId: string, outfitId: string): Promise<void>;
  followCreator(userId: string, creatorId: string): Promise<void>;
  unfollowCreator(userId: string, creatorId: string): Promise<void>;
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
}

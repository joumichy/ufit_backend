import { describe, expect, it } from 'vitest';
import { SavedService, type SavedOutfit, type SavedRepository } from '../../src/modules/saved/application/saved.service';

class FakeSavedRepository implements SavedRepository {
  saved = new Set<string>();
  follows = new Set<string>();
  outfits: SavedOutfit[] = [];

  async saveOutfit(userId: string, outfitId: string): Promise<void> {
    this.saved.add(`${userId}:${outfitId}`);
  }

  async unsaveOutfit(userId: string, outfitId: string): Promise<void> {
    this.saved.delete(`${userId}:${outfitId}`);
  }

  async followCreator(userId: string, creatorId: string): Promise<void> {
    this.follows.add(`${userId}:${creatorId}`);
  }

  async unfollowCreator(userId: string, creatorId: string): Promise<void> {
    this.follows.delete(`${userId}:${creatorId}`);
  }

  async findSavedOutfits(_userId: string, input: { limit: number }): Promise<SavedOutfit[]> {
    return this.outfits.slice(0, input.limit);
  }
}

describe('SavedService', () => {
  it('keeps save and follow commands idempotent at the repository boundary', async () => {
    const repository = new FakeSavedRepository();
    const service = new SavedService(repository);

    await expect(service.saveOutfit('user-1', 'outfit-1')).resolves.toEqual({ saved: true });
    await expect(service.followCreator('user-1', 'creator-1')).resolves.toEqual({ following: true });

    expect(repository.saved.has('user-1:outfit-1')).toBe(true);
    expect(repository.follows.has('user-1:creator-1')).toBe(true);
  });

  it('returns mobile-safe saved outfit cards scoped by the repository', async () => {
    const repository = new FakeSavedRepository();
    repository.outfits = [
      {
        id: 'outfit-1',
        title: 'City Uniform',
        coverImageUrl: 'https://cdn.test/outfit.jpg',
        totalPriceMin: 10000,
        totalPriceMax: 12000,
        publishedAt: new Date('2026-05-20T10:00:00.000Z'),
        savedAt: new Date('2026-05-20T11:00:00.000Z')
      }
    ];
    const service = new SavedService(repository);

    await expect(service.listSavedOutfits('user-1', { limit: 5 })).resolves.toEqual({
      items: [
        {
          id: 'outfit-1',
          title: 'City Uniform',
          coverImageUrl: 'https://cdn.test/outfit.jpg',
          totalPriceMin: 10000,
          totalPriceMax: 12000,
          publishedAt: '2026-05-20T10:00:00.000Z',
          savedAt: '2026-05-20T11:00:00.000Z'
        }
      ]
    });
  });
});

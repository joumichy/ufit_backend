import { describe, expect, it } from 'vitest';
import {randomUUID} from 'node:crypto';
import {NotFoundException} from '@nestjs/common';
import { SavedService, type SavedOutfit, type SavedRepository } from '../../src/modules/saved/application/saved.service';
import {PUBLIC_CREATOR} from '../../src/modules/creators/public-creator.contract';

const fixture = {user: randomUUID(), creator: randomUUID(), outfit: randomUUID()};

class FakeSavedRepository implements SavedRepository {
  saved = new Set<string>();
  follows = new Set<string>();
  outfits: SavedOutfit[] = [];
  activeCreators = new Set<string>([fixture.creator]);

  async saveOutfit(userId: string, outfitId: string): Promise<void> {
    this.saved.add(`${userId}:${outfitId}`);
  }

  async unsaveOutfit(userId: string, outfitId: string): Promise<void> {
    this.saved.delete(`${userId}:${outfitId}`);
  }

  async followCreator(userId: string, creatorId: string): Promise<void> {
    if (!this.activeCreators.has(creatorId)) throw new NotFoundException(PUBLIC_CREATOR.missing);
    this.follows.add(`${userId}:${creatorId}`);
  }

  async unfollowCreator(userId: string, creatorId: string): Promise<void> {
    this.follows.delete(`${userId}:${creatorId}`);
  }
  async findCreatorFollow(userId: string, creatorId: string): Promise<boolean | null> {
    return this.activeCreators.has(creatorId) ? this.follows.has(`${userId}:${creatorId}`) : null;
  }

  async findSavedOutfits(_userId: string, input: { limit: number }): Promise<SavedOutfit[]> {
    return this.outfits.slice(0, input.limit);
  }
}

describe('SavedService', () => {
  it('keeps save and follow commands idempotent at the repository boundary', async () => {
    const repository = new FakeSavedRepository();
    const service = new SavedService(repository);

    await expect(service.saveOutfit(fixture.user, fixture.outfit)).resolves.toEqual({ saved: true });
    await expect(service.followCreator(fixture.user, fixture.creator)).resolves.toEqual({ following: true });

    expect(repository.saved.has(`${fixture.user}:${fixture.outfit}`)).toBe(true);
    expect(repository.follows.has(`${fixture.user}:${fixture.creator}`)).toBe(true);
    await expect(service.getCreatorFollow(fixture.user, fixture.creator)).resolves.toEqual({following: true});
    await expect(service.getCreatorFollow(randomUUID(), fixture.creator)).resolves.toEqual({following: false});
    await service.unfollowCreator(fixture.user, fixture.creator);
    await expect(service.getCreatorFollow(fixture.user, fixture.creator)).resolves.toEqual({following: false});
    repository.activeCreators.clear();
    await expect(service.getCreatorFollow(fixture.user, fixture.creator)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.followCreator(fixture.user, fixture.creator)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns mobile-safe saved outfit cards scoped by the repository', async () => {
    const repository = new FakeSavedRepository();
    repository.outfits = [
      {
        id: 'outfit-1',
        savedAt: new Date('2026-05-20T11:00:00.000Z')
      }
    ];
    const service = new SavedService(repository);

    await expect(service.listSavedOutfits('user-1', { limit: 5 })).resolves.toEqual({
      items: [
        {
          id: 'outfit-1',
          savedAt: '2026-05-20T11:00:00.000Z'
        }
      ]
    });
  });
});

import { describe, expect, it } from 'vitest';
import {randomUUID} from 'node:crypto';
import {NotFoundException} from '@nestjs/common';
import { SavedService, type SavedRepository } from '../../src/modules/saved/application/saved.service';
import {SAVED_OUTFITS, savedOutfitCursor, savedOutfitIdentities, savedOutfitQuery, type SavedOutfitQuery, type SavedOutfitReference} from '../../src/modules/saved/domain/saved-outfits.contract';
import {PUBLIC_CREATOR} from '../../src/modules/creators/public-creator.contract';

const fixture = {user: randomUUID(), creator: randomUUID(), outfit: randomUUID(), time: '2026-05-20T11:00:00.123456Z',
  separator: ':', one: 1, zero: 0, two: 2, five: 5, missing: '00000000-0000-4000-8000-000000000001',
  invalid: {limit: 51, fractionalLimit: 1.5, number: 'no', empty: '', cursor: 'not-json', padding: '=', uuid: 'not-a-uuid',
    date: '2026-02-31T11:00:00.123456Z', precision: '2026-05-20T11:00:00.123Z', offset: '2026-05-20T12:00:00.123456+01:00'}} as const;

class FakeSavedRepository implements SavedRepository {
  saved = new Set<string>();
  follows = new Set<string>();
  outfits: SavedOutfitReference[] = [];
  activeCreators = new Set<string>([fixture.creator]);

  async saveOutfit(userId: string, outfitId: string): Promise<void> {
    this.saved.add(`${userId}${fixture.separator}${outfitId}`);
  }

  async unsaveOutfit(userId: string, outfitId: string): Promise<void> {
    this.saved.delete(`${userId}${fixture.separator}${outfitId}`);
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

  async findSavedOutfits(_userId: string, input: SavedOutfitQuery): Promise<SavedOutfitReference[]> {
    return this.outfits.filter(item => !input.cursor || item.savedAt < input.cursor.savedAt ||
      (item.savedAt === input.cursor.savedAt && item.id < input.cursor.id))
      .sort((left, right) => right.savedAt.localeCompare(left.savedAt) || right.id.localeCompare(left.id))
      .slice(fixture.zero, input.limit);
  }
  async findSavedOutfitIDs(userId: string, ids: string[]): Promise<string[]> {
    return ids.filter(id => this.saved.has(`${userId}${fixture.separator}${id}`));
  }
}

describe('SavedService', () => {
  it('keeps save and follow commands idempotent at the repository boundary', async () => {
    const repository = new FakeSavedRepository();
    const service = new SavedService(repository);

    await expect(service.saveOutfit(fixture.user, fixture.outfit)).resolves.toEqual({ saved: true });
    await expect(service.followCreator(fixture.user, fixture.creator)).resolves.toEqual({ following: true });

    expect(repository.saved.has(`${fixture.user}${fixture.separator}${fixture.outfit}`)).toBe(true);
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
        id: fixture.outfit,
        savedAt: fixture.time
      }
    ];
    const service = new SavedService(repository);

    await expect(service.listSavedOutfits(fixture.user, { limit: fixture.five })).resolves.toEqual({
      items: [
        {
          id: fixture.outfit,
          savedAt: fixture.time
        }
      ], nextCursor: null
    });
  });
  it('keeps tied timestamps stable, retains microseconds and continues after its anchor is removed', async () => {
    const repository = new FakeSavedRepository(), service = new SavedService(repository);
    repository.outfits = Array.from({length: fixture.five}, () => ({id: randomUUID(), savedAt: fixture.time}));
    const ordered = repository.outfits.map(item => item.id).sort().reverse();
    const first = await service.listSavedOutfits(fixture.user, {limit: fixture.two});
    expect(first.items.map(item => item.id)).toEqual(ordered.slice(fixture.zero, fixture.two));
    expect(savedOutfitQuery({cursor: first.nextCursor}).cursor).toEqual(first.items.at(SAVED_OUTFITS.page.last));
    repository.outfits = repository.outfits.filter(item => item.id !== first.items.at(SAVED_OUTFITS.page.last)!.id);
    const second = await service.listSavedOutfits(fixture.user, {limit: fixture.two, cursor: first.nextCursor});
    expect(second.items.map(item => item.id)).toEqual(ordered.slice(fixture.two, fixture.two + fixture.two));
    const third = await service.listSavedOutfits(fixture.user, {limit: fixture.two, cursor: second.nextCursor});
    expect(third.items.map(item => item.id)).toEqual(ordered.slice(fixture.two + fixture.two));
    expect(third.nextCursor).toBeNull();
  });
  it('reads the requested identities in their input order for the authenticated account only', async () => {
    const repository = new FakeSavedRepository(), service = new SavedService(repository);
    await service.saveOutfit(fixture.user, fixture.outfit);
    const input = {ids: [fixture.missing, fixture.outfit.toUpperCase()].join(SAVED_OUTFITS.query.separator)};
    await expect(service.savedOutfitStates(fixture.user, input)).resolves.toEqual({items: [
      {id: fixture.missing, saved: false}, {id: fixture.outfit, saved: true},
    ]});
    await expect(service.savedOutfitStates(randomUUID(), input)).resolves.toEqual({items: [
      {id: fixture.missing, saved: false}, {id: fixture.outfit, saved: false},
    ]});
  });
  it.each([{limit: fixture.zero}, {limit: fixture.invalid.limit}, {limit: fixture.invalid.fractionalLimit}, {limit: fixture.invalid.number},
    {limit: [fixture.one]}, {limit: true}, {limit: null}, {cursor: fixture.invalid.empty}, {cursor: fixture.invalid.cursor},
    {cursor: savedOutfitCursor({id: fixture.outfit, savedAt: fixture.time}) + fixture.invalid.padding}, {userId: fixture.user}, {cursor: null}])
  ('rejects a malformed page before reading persistence: %j', input => {
    expect(() => savedOutfitQuery(input)).toThrow(SAVED_OUTFITS.failure.page);
  });
  it.each([{ids: fixture.invalid.empty}, {ids: fixture.invalid.uuid}, {ids: [fixture.outfit]}, {ids: fixture.outfit, userId: fixture.user},
    {ids: [fixture.outfit, fixture.outfit.toUpperCase()].join(SAVED_OUTFITS.query.separator)},
    {ids: Array.from({length: SAVED_OUTFITS.page.maximum + fixture.one}, () => randomUUID()).join(SAVED_OUTFITS.query.separator)}])
  ('rejects malformed or duplicated identity sets: %j', input => {
    expect(() => savedOutfitIdentities(input)).toThrow(SAVED_OUTFITS.failure.states);
  });
  it.each([
    {id: fixture.outfit, savedAt: fixture.invalid.date},
    {id: fixture.outfit, savedAt: fixture.invalid.precision},
    {id: fixture.outfit, savedAt: fixture.invalid.offset},
    {id: fixture.invalid.uuid, savedAt: fixture.time},
    {id: fixture.outfit, savedAt: fixture.time, userId: fixture.user},
    {savedAt: fixture.time, id: fixture.outfit},
  ])('rejects noncanonical decoded cursor data without rounding or aliases: %j', body => {
    const cursor = Buffer.from(JSON.stringify(body)).toString(SAVED_OUTFITS.cursor.encoding);
    expect(() => savedOutfitQuery({cursor})).toThrow(SAVED_OUTFITS.failure.page);
  });
});

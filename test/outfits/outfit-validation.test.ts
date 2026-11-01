import 'reflect-metadata';
import {randomUUID} from 'node:crypto';
import {plainToInstance} from 'class-transformer';
import {validate} from 'class-validator';
import {describe, expect, it} from 'vitest';
import {CreateOutfitDto, ReviewOutfitDto, UpdateOutfitDto} from '../../src/modules/outfits/application/dto/outfit.dto';
import {OUTFIT_EDITING, OUTFIT_ITEM_TYPES, OUTFIT_STATUS} from '../../src/modules/outfits/domain/outfit-editing.contract';
import {outfitFixture, publicCreator} from './memory-outfit.repository';
const options = {whitelist: true, forbidNonWhitelisted: true};
const data = {title: 'Tenue de travail', description: 'Silhouette structurée.', label: 'Chemise personnelle', padding: '  ', zero: 0, negative: -1} as const;
function payload() {
  return {creatorId: publicCreator.id, requestId: randomUUID(), title: data.title, description: data.description, tagIds: [], images: [outfitFixture.image],
    items: [{externalLabel: data.label, itemType: OUTFIT_ITEM_TYPES[OUTFIT_EDITING.limits.first], position: data.zero, isRequired: true, isShoppable: false}]};
}
describe('Outfit input contract', () => {
  it('accepts canonical ordered content and trims its text', async () => {
    const value = plainToInstance(CreateOutfitDto, {...payload(), title: data.padding + data.title + data.padding});
    expect(await validate(value, options)).toHaveLength(data.zero); expect(value.title).toBe(data.title);
  });
  it('rejects forged authority and alternative cover fields, missing requests and null collections', async () => {
    for (const patch of [{status: OUTFIT_STATUS.published}, {reviewedBy: randomUUID()}, {coverImageUrl: outfitFixture.image.url}, {requestId: null}, {items: null}, {images: null}, {tagIds: null}, {items: [null]}, {images: [null]}]) {
      expect((await validate(plainToInstance(CreateOutfitDto, {...payload(), ...patch}), options)).length).toBeGreaterThan(data.zero);
    }
  });
  it('requires distinct positions and known piece types', async () => {
    const body = payload();
    for (const patch of [{items: [...body.items, ...body.items]}, {images: [...body.images, ...body.images]}, {items: [{...body.items[data.zero], itemType: data.label}]}, {images: [{...outfitFixture.image, position: data.negative}]}]) {
      expect((await validate(plainToInstance(CreateOutfitDto, {...body, ...patch}), options)).length).toBeGreaterThan(data.zero);
    }
  });
  it('requires mutation versions and refuses a caller reviewer identifier or null retained identifiers', async () => {
    for (const body of [{decision: OUTFIT_STATUS.published}, {decision: OUTFIT_STATUS.published, expectedVersion: null}, {decision: OUTFIT_STATUS.published, expectedVersion: OUTFIT_EDITING.versionInitial, reviewerId: randomUUID()}]) {
      expect((await validate(plainToInstance(ReviewOutfitDto, body), options)).length).toBeGreaterThan(data.zero);
    }
    const {creatorId, requestId, ...fields} = payload();
    expect((await validate(plainToInstance(UpdateOutfitDto, {...fields, expectedVersion: OUTFIT_EDITING.versionInitial, items: [{...fields.items[data.zero], id: null}]}), options)).length).toBeGreaterThan(data.zero);
  });
});

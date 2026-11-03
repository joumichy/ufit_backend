import {randomUUID} from 'node:crypto';
import {BadRequestException, ConflictException} from '@nestjs/common';
import {describe, expect, it} from 'vitest';
import {OutfitsService} from '../../src/modules/outfits/application/outfits.service';
import {OUTFIT_EDITING, OUTFIT_STATUS} from '../../src/modules/outfits/domain/outfit-editing.contract';
import {MemoryProductRepository} from '../products/memory-product.repository';
import {MemoryOutfitRepository, outfitFixture, publicCreator} from './memory-outfit.repository';
import {MemoryOutfitMediaReader} from './memory-outfit-media.reader';
const fixture = {title: 'Repères photo', description: 'Silhouette et repères', label: 'Lunettes personnelles', zero: 0, second: 1,
  x: 2300, y: 4200, outside: 10001, fraction: 0.5, count: 2} as const;
function setup() {
  const products = new MemoryProductRepository(), media = new MemoryOutfitMediaReader(), repository = new MemoryOutfitRepository(products, media.assets);
  const service = new OutfitsService(repository, products, media);
  const input = {creatorId: publicCreator.id, requestId: randomUUID(), title: fixture.title, description: fixture.description, tagIds: [],
    images: [outfitFixture.image, {...outfitFixture.image, position: fixture.second}],
    items: [{itemType: 'eyewear' as const, externalLabel: fixture.label, position: fixture.zero, isRequired: true, isShoppable: false}],
    pins: [{imagePosition: fixture.zero, itemPosition: fixture.zero, x: fixture.x, y: fixture.y}]};
  return {service, repository, input};
}
describe('Outfit photo pins', () => {
  it('keeps omission and an empty placement collection as the same creation request', async () => {
    const {service, input} = setup();
    const {pins: _, ...withoutPins} = input;
    const first = await service.createOutfit(outfitFixture.actor, withoutPins);
    const replay = await service.createOutfit(outfitFixture.actor, {...withoutPins, pins: []});
    expect(replay.id).toBe(first.id); expect(replay.version).toBe(first.version); expect(replay.pins).toEqual([]);
  });
  it('persists exact photo/item identities, keeps public feed and detail aligned, and fingerprints placement', async () => {
    const {service, input} = setup();
    let detail = await service.createOutfit(outfitFixture.actor, input);
    const pins = [{imageId: detail.images[fixture.zero].id, itemId: detail.items[fixture.zero].id, x: fixture.x, y: fixture.y}];
    expect(detail.pins).toEqual(pins);
    expect((await service.createOutfit(outfitFixture.actor, input)).pins).toEqual(pins);
    await expect(service.createOutfit(outfitFixture.actor, {...input, pins: [{...input.pins[fixture.zero], x: fixture.y}]})).rejects.toBeInstanceOf(ConflictException);
    detail = await service.publishOutfit(outfitFixture.actor, detail.id, {expectedVersion: detail.version});
    detail = await service.getManagedOutfit(outfitFixture.actor, detail.id);
    const feed = (await service.getPublicFeed({})).items[fixture.zero], published = await service.getPublicDetail(detail.id);
    expect(feed.pins).toEqual(pins); expect(feed.items).toEqual(published.items); expect(feed.images).toEqual(published.images);
    expect(feed.items[fixture.zero].itemType).toBe(input.items[fixture.zero].itemType);
    const reordered = {...input, expectedVersion: detail.version, images: detail.images.map(image => ({id: image.id, url: image.url, position: fixture.second - image.position})),
      items: detail.items.map(item => ({...input.items[fixture.zero], id: item.id})),
      pins: [{...input.pins[fixture.zero], imagePosition: fixture.second}]};
    const updated = await service.updateOutfit(outfitFixture.actor, detail.id, reordered);
    expect(updated.pins).toEqual(pins); expect(updated.images.find(image => image.id === pins[fixture.zero].imageId)?.position).toBe(fixture.second);
    const withoutItem = await service.updateOutfit(outfitFixture.actor, detail.id, {...reordered, expectedVersion: updated.version, items: [], pins: []});
    expect(withoutItem.pins).toEqual([]);
  });
  it('rejects orphan, duplicate and invalid coordinates before aggregate writes', async () => {
    const {service, repository, input} = setup(), pin = input.pins[fixture.zero];
    for (const pins of [[{...pin, itemPosition: fixture.second}], [{...pin, imagePosition: fixture.count}], [pin, pin],
      [{...pin, x: fixture.outside}], [{...pin, y: -fixture.second}], [{...pin, x: fixture.fraction}]]) {
      await expect(service.createOutfit(outfitFixture.actor, {...input, pins})).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(repository.outfits.size).toBe(OUTFIT_EDITING.limits.integerMin);
  });
});

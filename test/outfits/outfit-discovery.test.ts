import {randomUUID} from 'node:crypto';
import {BadRequestException} from '@nestjs/common';
import {describe, expect, it, vi} from 'vitest';
import {OutfitsService} from '../../src/modules/outfits/application/outfits.service';
import {OUTFIT_DISCOVERY as D, PUBLIC_OUTFIT} from '../../src/modules/outfits/domain/public-outfit.contract';
import {OUTFIT_ITEM_TYPES} from '../../src/modules/outfits/domain/outfit-editing.contract';
import {MemoryProductRepository} from '../products/memory-product.repository';
import {MemoryOutfitRepository} from './memory-outfit.repository';
import {MemoryOutfitMediaReader} from './memory-outfit-media.reader';

const P = {query: '  Minimal %_  ', trimmed: 'Minimal %_', invalid: 'unknown', one: 1, zero: 0,
  style: 'style', occasion: 'occasion', season: 'season', label: 'Qualification'} as const;
function setup() {
  const products = new MemoryProductRepository(), media = new MemoryOutfitMediaReader();
  const repository = new MemoryOutfitRepository(products, media.assets);
  return {repository, service: new OutfitsService(repository, products, media)};
}
describe('Public outfit discovery contract', () => {
  it('passes canonical trimmed criteria to persistence before pagination', async () => {
    const {repository, service} = setup(), styleId = randomUUID(), occasionId = randomUUID();
    const read = vi.spyOn(repository, 'findPublishedPage').mockResolvedValue([]);
    expect(await service.getPublicFeed({q: P.query, scope: D.scope.pieces, styleId, occasionId,
      itemType: OUTFIT_ITEM_TYPES[P.zero], limit: P.one})).toEqual({items: [], nextCursor: null});
    expect(read).toHaveBeenCalledExactlyOnceWith({q: P.trimmed, scope: D.scope.pieces, styleId, occasionId,
      itemType: OUTFIT_ITEM_TYPES[P.zero], limit: P.one + PUBLIC_OUTFIT.limits.overflow});
  });
  it.each([
    {q: [P.query]}, {q: P.query.repeat(D.queryMax)}, {scope: P.invalid}, {itemType: P.invalid},
    {styleId: P.invalid}, {occasionId: P.invalid}, {cursor: P.invalid}, {search: P.query},
    {creatorId: randomUUID(), brandId: randomUUID()},
  ])('rejects invalid query without reading persistence: %j', async input => {
    const {repository, service} = setup(), read = vi.spyOn(repository, 'findPublishedPage');
    await expect(service.getPublicFeed(input)).rejects.toBeInstanceOf(BadRequestException);
    expect(read).not.toHaveBeenCalled();
  });
  it('exposes only registry style/occasion options and canonical piece types', async () => {
    const {repository, service} = setup();
    const tags = [P.style, P.occasion, P.season].map(type => ({id: randomUUID(), type, slug: randomUUID(), label: P.label}));
    repository.tags.push(...tags);
    expect(await service.getDiscoveryOptions()).toEqual({tags: tags.filter(tag => tag.type !== P.season), itemTypes: OUTFIT_ITEM_TYPES});
  });
});

import { randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { OutfitsService } from '../../src/modules/outfits/application/outfits.service';
import { BRAND_OUTFIT_INTEGRATIONS } from '../../src/modules/outfits/domain/brand-outfit-integrations.contract';
import { OUTFIT_STATUS, OUTFIT_VISIBILITY } from '../../src/modules/outfits/domain/outfit-editing.contract';
import { PUBLIC_OUTFIT } from '../../src/modules/outfits/domain/public-outfit.contract';
import { PRODUCT_STATUS } from '../../src/modules/products/domain/product-contract';
import { PROFILE_KIND, PROFILE_STATUS } from '../../src/shared/domain/profile-editing.contract';
import { MemoryProductRepository, productFixture } from '../products/memory-product.repository';
import { MemoryOutfitRepository, outfitFixture, publicCreator } from './memory-outfit.repository';
import { MemoryOutfitMediaReader } from './memory-outfit-media.reader';

const Value = { title: 'Une silhouette avec vos pièces', description: 'Composition de qualification.',
  itemType: 'top', customer: 'customer', invalid: 'invalid', first: 0, one: 1,
  pieceKeys: ['itemId', 'name', 'productId', 'productStatus'] } as const;

async function setup() {
  const products = new MemoryProductRepository(), media = new MemoryOutfitMediaReader();
  const repository = new MemoryOutfitRepository(products, media.assets);
  const service = new OutfitsService(repository, products, media);
  repository.owners.set(productFixture.brandID, {id: productFixture.brandID, kind: PROFILE_KIND.brand,
    name: productFixture.brandName, status: PROFILE_STATUS.active});
  repository.members.set(productFixture.brandID, new Set([productFixture.actor.id]));
  async function product(brandId: string = productFixture.brandID) {
    products.brands.set(brandId, {id: brandId, brandName: productFixture.brandName, status: PROFILE_STATUS.active});
    const row = await products.createProduct({brandId, name: productFixture.name, slug: randomUUID(),
      description: productFixture.description, category: productFixture.category, genderTarget: null,
      status: PRODUCT_STATUS.active, basePrice: productFixture.basePrice, currency: productFixture.currency,
      material: null, careInstructions: null, reviewedBy: null, reviewedAt: null, rejectionReason: null,
      creationRequestId: randomUUID(), creationFingerprint: randomUUID()});
    await products.addVariants(row.id, [{sku: randomUUID(), stockQuantity: productFixture.stock, size: null, color: null, priceOverride: null}]);
    await products.addImages(row.id, [productFixture.image]);
    return row;
  }
  async function outfit(productIds: string[], publish = true) {
    let row = await service.createOutfit(outfitFixture.actor, {creatorId: publicCreator.id, requestId: randomUUID(),
      title: Value.title, description: Value.description, images: [outfitFixture.image], tagIds: [],
      items: productIds.map((productId, position) => ({productId, position, itemType: Value.itemType, isRequired: true, isShoppable: true}))});
    if (publish) row = await service.publishOutfit(outfitFixture.actor, row.id, {expectedVersion: row.version});
    return row;
  }
  return {products, repository, service, product, outfit};
}

describe('Brand outfit integrations', () => {
  it('finds creator-authored outfits without treating product ownership as authorship or duplicating the outfit', async () => {
    const {service, repository, product, outfit} = await setup();
    const first = await product(), second = await product(), other = await product(randomUUID());
    const row = await outfit([first.id, second.id, other.id]);
    const read = vi.spyOn(repository, 'findPublishedPage');
    const page = await service.getBrandIntegrations(productFixture.actor, {brandId: productFixture.brandID});
    expect(read).toHaveBeenCalledExactlyOnceWith({productBrandId: productFixture.brandID, cursor: undefined,
      limit: PUBLIC_OUTFIT.limits.default + PUBLIC_OUTFIT.limits.overflow});
    expect(page.brandId).toBe(productFixture.brandID); expect(page.items).toHaveLength(Value.one);
    expect(page.items[Value.first].outfit.id).toBe(row.id);
    expect(page.items[Value.first].outfit.author?.id).toBe(publicCreator.id);
    expect(page.items[Value.first].outfit.brandId).toBeNull();
    expect(page.items[Value.first].pieces.map(piece => piece.productId)).toEqual([first.id, second.id]);
    expect(Object.keys(page.items[Value.first].pieces[Value.first]).sort()).toEqual(Value.pieceKeys);
  });

  it('keeps names and current status for archived products without making them publicly shoppable', async () => {
    const {service, products, product, outfit} = await setup(), own = await product();
    await outfit([own.id]); products.products.set(own.id, {...own, status: PRODUCT_STATUS.archived});
    const page = await service.getBrandIntegrations(productFixture.actor, {brandId: productFixture.brandID});
    expect(page.items[Value.first].pieces[Value.first]).toMatchObject({productId: own.id, name: own.name, productStatus: PRODUCT_STATUS.archived});
    expect(page.items[Value.first].outfit.items[Value.first].product).toBeNull();
  });

  it('excludes private, scheduled and archived outfits while retaining the exact requested page', async () => {
    const {service, repository, product, outfit} = await setup(), own = await product();
    const first = await outfit([own.id]), second = await outfit([own.id]);
    await outfit([own.id], false);
    const planned = await outfit([own.id]); repository.outfits.set(planned.id, {...repository.outfits.get(planned.id)!, status: OUTFIT_STATUS.scheduled, visibility: OUTFIT_VISIBILITY.private});
    const archived = await outfit([own.id]); repository.outfits.set(archived.id, {...repository.outfits.get(archived.id)!, status: OUTFIT_STATUS.archived});
    const page = await service.getBrandIntegrations(productFixture.actor, {brandId: productFixture.brandID, limit: Value.one});
    expect(page.items).toHaveLength(Value.one); expect(page.nextCursor).toBe(page.items[Value.first].outfit.id);
    const next = await service.getBrandIntegrations(productFixture.actor, {brandId: productFixture.brandID, limit: Value.one, cursor: page.nextCursor});
    expect(new Set([...page.items, ...next.items].map(row => row.outfit.id))).toEqual(new Set([first.id, second.id]));
    expect(next.nextCursor).toBeNull();
  });

  it('requires the active brand membership and author role before any integration read', async () => {
    const {service, repository} = await setup(), read = vi.spyOn(repository, 'findPublishedPage');
    const actors = [outfitFixture.actor, {id: productFixture.actor.id, roles: [Value.customer]},
      {id: randomUUID(), roles: productFixture.actor.roles}];
    for (const actor of actors) await expect(service.getBrandIntegrations(actor, {brandId: productFixture.brandID})).rejects.toBeInstanceOf(ForbiddenException);
    repository.owners.get(productFixture.brandID)!.status = PROFILE_STATUS.suspended;
    await expect(service.getBrandIntegrations(productFixture.actor, {brandId: productFixture.brandID})).rejects.toBeInstanceOf(ForbiddenException);
    expect(read).not.toHaveBeenCalled();
    repository.owners.get(productFixture.brandID)!.status = PROFILE_STATUS.paused;
    expect(await service.getBrandIntegrations(productFixture.actor, {brandId: productFixture.brandID})).toEqual({brandId: productFixture.brandID, items: [], nextCursor: null});
  });

  it.each([{}, {brandId: Value.invalid}, {brandId: randomUUID(), cursor: Value.invalid},
    {brandId: randomUUID(), limit: Value.first}, {brandId: randomUUID(), limit: PUBLIC_OUTFIT.limits.maximum + Value.one},
    {brandId: randomUUID(), creatorId: randomUUID()}, {brandId: randomUUID(), productBrandId: randomUUID()}])('rejects invalid or aliased queries before persistence: %j', async query => {
    const {service, repository} = await setup(), read = vi.spyOn(repository, 'findEditableOwner');
    await expect(service.getBrandIntegrations(productFixture.actor, query)).rejects.toBeInstanceOf(BadRequestException);
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects an inconsistent piece relation instead of silently omitting the outfit', async () => {
    const {service, repository, product, outfit} = await setup(), own = await product(); await outfit([own.id]);
    vi.spyOn(repository, 'findBrandIntegrationPieces').mockResolvedValueOnce([]);
    vi.spyOn(repository, 'findPublishedPage').mockImplementation(async () => [(await repository.findById([...repository.outfits.keys()][Value.first]))!]);
    await expect(service.getBrandIntegrations(productFixture.actor, {brandId: productFixture.brandID})).rejects.toThrow(BRAND_OUTFIT_INTEGRATIONS.failure.changed);
  });

  it('does not expose the internal product-brand filter through the public feed query', async () => {
    const {service} = await setup();
    await expect(service.getPublicFeed({productBrandId: productFixture.brandID})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects mixed product snapshots rather than emitting conflicting public and private names', async () => {
    const {service, repository, product, outfit} = await setup(), own = await product(); await outfit([own.id]);
    const read = repository.findBrandIntegrationPieces.bind(repository);
    vi.spyOn(repository, 'findBrandIntegrationPieces').mockImplementation(async (...args) => (await read(...args)).map(piece => ({...piece, productStatus: PRODUCT_STATUS.archived})));
    await expect(service.getBrandIntegrations(productFixture.actor, {brandId: productFixture.brandID})).rejects.toThrow(BRAND_OUTFIT_INTEGRATIONS.failure.changed);
  });
});

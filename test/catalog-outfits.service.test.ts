import {MemoryOutfitMediaReader} from './outfits/memory-outfit-media.reader';
import {OUTFIT_EDITING} from '../src/modules/outfits/domain/outfit-editing.contract';
import {MemoryOutfitRepository, fixtureID as id, publicCreator, outfitFixture} from './outfits/memory-outfit.repository';
import {randomUUID} from 'node:crypto';
import {PUBLIC_OUTFIT, PUBLIC_OUTFIT_VISIBILITIES, type PublicOutfitPage} from '../src/modules/outfits/domain/public-outfit.contract';
import {PUBLIC_PROFILE} from '../src/shared/domain/public-profile.contract';
import {MemoryProductRepository, productFixture} from './products/memory-product.repository';
import {MemoryProductMediaReader} from './products/memory-product-media.reader';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ProductsService } from '../src/modules/products/application/products.service';
import type { Product, ProductDetail, ProductImage, ProductRepository, ProductStatus, ProductVariant } from '../src/modules/products/domain/product.types';
import { OutfitsService } from '../src/modules/outfits/application/outfits.service';
import type { Outfit, OutfitDetail, OutfitImage, OutfitItem, OutfitRepository, OutfitStatus, OutfitVisibility } from '../src/modules/outfits/domain/outfit.types';

const publicProfileFixture = {title: 'Tenue publique de profil', description: 'Une silhouette de qualification', image: 'https://cdn.test/profile-outfit.jpg', inspiration: 'Pièce personnelle', itemType: 'top', position: 0, pageSize: 1, empty: 0, nextRow: 1} as const;


function services() {
  const productRepository = new MemoryProductRepository();
  const media = new MemoryOutfitMediaReader(), outfitRepository = new MemoryOutfitRepository(productRepository, media.assets);
  return {
    productRepository,
    outfitRepository,
    productsService: new ProductsService(productRepository, new MemoryProductMediaReader()),
    outfitsService: new OutfitsService(outfitRepository, productRepository, media)
  };
}

describe('Products and outfits services', () => {
  it('paginates public profile outfits by their canonical author and hides private or unavailable authors', async () => {
    const {outfitsService, outfitRepository} = services();
    async function publish() {
      const detail = await outfitsService.createOutfit(outfitFixture.actor, {requestId: randomUUID(), tagIds: [],creatorId: publicCreator.id, title: publicProfileFixture.title,
        description: publicProfileFixture.description, images: [{url: publicProfileFixture.image, position: OUTFIT_EDITING.limits.first}],
        items: [{itemType: publicProfileFixture.itemType, externalLabel: publicProfileFixture.inspiration, position: publicProfileFixture.position, isRequired: true, isShoppable: false}]});
      await outfitsService.publishOutfit(outfitFixture.actor, detail.id, {expectedVersion: (await outfitsService.getManagedOutfit(outfitFixture.actor, detail.id)).version});
      return detail.id;
    }
    const first = await publish(), second = await publish();
    const page = await outfitsService.getPublicFeed({creatorId: publicCreator.id, limit: publicProfileFixture.pageSize});
    expect(page.items).toHaveLength(publicProfileFixture.pageSize); expect(page.nextCursor).toBe(page.items[publicProfileFixture.position].id);
    const next = await outfitsService.getPublicFeed({creatorId: publicCreator.id, limit: publicProfileFixture.pageSize, cursor: page.nextCursor});
    expect(new Set([...page.items, ...next.items].map(row => row.id))).toEqual(new Set([first, second])); expect(next.nextCursor).toBeNull();
    expect((await outfitsService.getPublicFeed({creatorId: randomUUID()})).items).toHaveLength(publicProfileFixture.empty);
    await expect(outfitsService.getPublicFeed({creatorId: publicCreator.id, brandId: randomUUID()})).rejects.toBeInstanceOf(BadRequestException);
    const hidden = outfitRepository.outfits.get(first)!; hidden.visibility = 'private';
    await expect(outfitsService.getPublicDetail(first)).rejects.toBeInstanceOf(NotFoundException);
    const unavailable = outfitRepository.outfits.get(second)!; unavailable.creatorId = randomUUID();
    await expect(outfitsService.getPublicDetail(second)).rejects.toBeInstanceOf(NotFoundException);
    expect((await outfitsService.getPublicFeed({})).items).toHaveLength(publicProfileFixture.empty);
  });

  it('publishes products directly for members and only exposes active products publicly', async () => {
    const { productsService } = services();
    const detail = await productsService.createProduct(productFixture.actor, {requestId: randomUUID(), currency: productFixture.currency,
      brandId: productFixture.brandID,
      name: 'Tailored Coat',
      description: 'Structured wool coat',
      category: 'outerwear',
      basePrice: 42000,
      variants: [{ sku: 'COAT-1', stockQuantity: 3 }],
      images: [{ url: 'https://cdn.test/coat.jpg', position: 0, kind: 'product' }]
    });

    expect(productsService.toPublicProduct(detail)).toBeNull();
    await expect(productsService.publishProduct({id: productFixture.adminID, roles: [...productFixture.adminRoles]}, detail.product.id, {expectedVersion: detail.product.version})).rejects.toBeInstanceOf(ForbiddenException);

    const published = await productsService.publishProduct(productFixture.actor, detail.product.id, {expectedVersion: (await productsService.getManagedProduct(productFixture.actor, detail.product.id)).product.version});
    expect(published.product.status).toBe('active');

    const active = await productsService.getManagedProduct(productFixture.actor, detail.product.id);
    expect(active.product.status).toBe('active');
    expect(productsService.toPublicProduct(active)?.price).toEqual({ min: 42000, max: 42000, currency: 'CHF' });
  });

  it('allows non-shoppable outfit pieces and calculates total price from active server products', async () => {
    const { productsService, outfitsService } = services();
    const product = await productsService.createProduct(productFixture.actor, {requestId: randomUUID(), currency: productFixture.currency, images: [productFixture.image],
      brandId: productFixture.brandID,
      name: 'Leather Loafer',
      description: 'Black loafer',
      category: 'shoes',
      basePrice: 26000,
      variants: [{ sku: 'LOAFER-42', stockQuantity: 2, priceOverride: 24000 }]
    });
    await productsService.publishProduct(productFixture.actor, product.product.id, {expectedVersion: (await productsService.getManagedProduct(productFixture.actor, product.product.id)).product.version});

    const outfit = await outfitsService.createOutfit(outfitFixture.actor, {requestId: randomUUID(), tagIds: [],
      creatorId: id('creator'),
      title: 'City Uniform',
      description: 'A sharp weekday silhouette',
      images: [{url: 'https://cdn.test/outfit.jpg', position: OUTFIT_EDITING.limits.first}],
      items: [
        { productId: product.product.id, itemType: 'shoes', position: 1, isRequired: true, isShoppable: true },
        { externalLabel: 'Vintage white shirt', itemType: 'top', position: 0, isRequired: true, isShoppable: false }
      ]
    });

    expect(outfit.items).toHaveLength(2);
    await outfitsService.publishOutfit(outfitFixture.actor, outfit.id, {expectedVersion: (await outfitsService.getManagedOutfit(outfitFixture.actor, outfit.id)).version});
    expect((await outfitsService.getPublicDetail(outfit.id)).prices).toEqual([{currency: 'CHF', min: 24000, max: 24000}]);
  });

  it('publishes separate canonical price groups for international outfits', async () => {
    const { productsService, outfitsService } = services();
    const definitions = [{ currency: 'CHF', price: 10090 }, { currency: 'EUR', price: 9000 }];
    const items: Array<{productId: string; itemType: 'top'; position: number; isRequired: boolean; isShoppable: boolean}> = [];
    for (const [position, definition] of definitions.entries()) {
      const detail = await productsService.createProduct(productFixture.actor, {requestId: randomUUID(), images: [productFixture.image],  brandId: productFixture.brandID, name: definition.currency,
        description: 'International price contract', category: 'top',
        basePrice: definition.price, currency: definition.currency,
        variants: [{sku: definition.currency, stockQuantity: 2}] });
      await productsService.publishProduct(productFixture.actor, detail.product.id, {expectedVersion: (await productsService.getManagedProduct(productFixture.actor, detail.product.id)).product.version});
      items.push({productId: detail.product.id, itemType: 'top', position, isRequired: true, isShoppable: true});
    }
    const outfit = await outfitsService.createOutfit(outfitFixture.actor, {requestId: randomUUID(), tagIds: [], creatorId: id('creator'), title: 'International',
      description: 'Two independent currency totals', images: [{url: 'https://cdn.test/outfit.jpg', position: OUTFIT_EDITING.limits.first}], items });
    await outfitsService.publishOutfit(outfitFixture.actor, outfit.id, {expectedVersion: (await outfitsService.getManagedOutfit(outfitFixture.actor, outfit.id)).version});
    const card = (await outfitsService.getPublicFeed({limit: 1})).items[0];
    expect(card.prices).toEqual([{currency: 'CHF', min: 10090, max: 10090}, {currency: 'EUR', min: 9000, max: 9000}]);
    expect(card).not.toHaveProperty('currency');
    expect(card).not.toHaveProperty('totalPriceMax');
    expect(card.author).toEqual(publicCreator);
  });

  it('keeps public feed/detail limited to published outfits and paginates basics', async () => {
    const { productsService, outfitsService } = services();
    const product = await productsService.createProduct(productFixture.actor, {requestId: randomUUID(), currency: productFixture.currency, images: [productFixture.image],
      brandId: productFixture.brandID,
      name: 'Fine Knit',
      description: 'Merino knit',
      category: 'top',
      basePrice: 18000,
      variants: [{ sku: 'KNIT-M', stockQuantity: 5 }]
    });
    await productsService.publishProduct(productFixture.actor, product.product.id, {expectedVersion: (await productsService.getManagedProduct(productFixture.actor, product.product.id)).product.version});

    const draft = await outfitsService.createOutfit(outfitFixture.actor, {requestId: randomUUID(), tagIds: [],
      creatorId: id('creator'),
      title: 'Quiet Draft',
      description: 'Should remain private',
      images: [{url: 'https://cdn.test/draft.jpg', position: OUTFIT_EDITING.limits.first}],
      items: [{ productId: product.product.id, itemType: 'top', position: 0, isRequired: true, isShoppable: true }]
    });
    const published = await outfitsService.createOutfit(outfitFixture.actor, {requestId: randomUUID(), tagIds: [],
      creatorId: id('creator'),
      title: 'Published Fit',
      description: 'Visible in feed',
      images: [{url: 'https://cdn.test/published.jpg', position: OUTFIT_EDITING.limits.first}],
      items: [{ productId: product.product.id, itemType: 'top', position: 0, isRequired: true, isShoppable: true }]
    });
    await outfitsService.publishOutfit(outfitFixture.actor, published.id, {expectedVersion: (await outfitsService.getManagedOutfit(outfitFixture.actor, published.id)).version});

    const feed = await outfitsService.getPublicFeed({ limit: 1 });
    expect(feed.items).toEqual([expect.objectContaining({ id: published.id, title: 'Published Fit' })]);
    await expect(outfitsService.getPublicDetail(draft.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(outfitsService.getPublicDetail(published.id)).resolves.toMatchObject({
      id: published.id,
      items: [expect.objectContaining({ product: expect.objectContaining({ price: 18000 }) })]
    });
  });

});

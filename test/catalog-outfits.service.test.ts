import {MemoryOutfitMediaReader} from './outfits/memory-outfit-media.reader';
import {OUTFIT_EDITING} from '../src/modules/outfits/domain/outfit-editing.contract';
import {MemoryOutfitRepository, fixtureID as id, publicCreator, outfitFixture} from './outfits/memory-outfit.repository';
import {randomUUID} from 'node:crypto';
import {PUBLIC_OUTFIT, PUBLIC_OUTFIT_VISIBILITIES, type PublicOutfitPage} from '../src/modules/outfits/domain/public-outfit.contract';
import {PUBLIC_PROFILE} from '../src/shared/domain/public-profile.contract';
import {MemoryProductRepository, productFixture} from './products/memory-product.repository';
import {MemoryProductMediaReader} from './products/memory-product-media.reader';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ProductsService } from '../src/modules/products/application/products.service';
import type { Product, ProductDetail, ProductImage, ProductRepository, ProductStatus, ProductVariant } from '../src/modules/products/domain/product.types';
import { OutfitsService } from '../src/modules/outfits/application/outfits.service';
import type { Outfit, OutfitDetail, OutfitImage, OutfitItem, OutfitRepository, OutfitStatus, OutfitVisibility } from '../src/modules/outfits/domain/outfit.types';
import { EditorialService } from '../src/modules/editorial/application/editorial.service';
import type { EditorialCollection, EditorialCollectionDetail, EditorialCollectionItem, EditorialRepository } from '../src/modules/editorial/domain/editorial.types';

const publicProfileFixture = {title: 'Tenue publique de profil', description: 'Une silhouette de qualification', image: 'https://cdn.test/profile-outfit.jpg', inspiration: 'Pièce personnelle', itemType: 'top', position: 0, pageSize: 1, empty: 0, nextRow: 1} as const;

class MemoryEditorialRepository implements EditorialRepository {
  collection: EditorialCollection = {
    id: id('collection'),
    title: 'Public Edit',
    subtitle: null,
    description: 'Published collection',
    coverImageUrl: null,
    status: 'published',
    createdBy: id('admin'),
    publishedAt: new Date('2026-05-20T00:00:00.000Z')
  };
  items: EditorialCollectionItem[] = [];

  async createCollection(input: Parameters<EditorialRepository['createCollection']>[0]): Promise<EditorialCollection> {
    this.collection = { id: id('collection'), status: 'draft', publishedAt: null, ...input };
    return this.collection;
  }

  async addItems(collectionId: string, items: Parameters<EditorialRepository['addItems']>[1]): Promise<EditorialCollectionItem[]> {
    const rows = items.map((item, index) => ({ id: id(`editor${index}`), collectionId, ...item }));
    this.items.push(...rows);
    return rows;
  }

  async publishCollection(): Promise<EditorialCollection> {
    this.collection = { ...this.collection, status: 'published', publishedAt: new Date('2026-05-20T00:00:00.000Z') };
    return this.collection;
  }

  async findPublishedCollections(): Promise<EditorialCollectionDetail[]> {
    return [{ collection: this.collection, items: this.items }];
  }
}

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
      await outfitsService.submitOutfit(outfitFixture.actor, detail.id, {expectedVersion: (await outfitsService.getManagedOutfit(outfitFixture.actor, detail.id)).version});
      await outfitsService.reviewOutfit(outfitFixture.admin, detail.id, {expectedVersion: (await outfitsService.getManagedOutfit(outfitFixture.actor, detail.id)).version,decision: PUBLIC_OUTFIT.status});
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

  it('moves product through submit and review statuses and only exposes active products publicly', async () => {
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
    await expect(productsService.reviewProduct(detail.product.id, {expectedVersion: (await productsService.getManagedProduct(productFixture.actor, detail.product.id)).product.version, reviewerId: productFixture.adminID,  decision: 'active' })).rejects.toBeInstanceOf(ConflictException);

    const submitted = await productsService.submitProduct(productFixture.actor, detail.product.id, {expectedVersion: (await productsService.getManagedProduct(productFixture.actor, detail.product.id)).product.version});
    expect(submitted.product.status).toBe('under_review');

    const active = await productsService.reviewProduct(detail.product.id, {expectedVersion: (await productsService.getManagedProduct(productFixture.actor, detail.product.id)).product.version,  decision: 'active', reviewerId: productFixture.adminID });
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
    await productsService.submitProduct(productFixture.actor, product.product.id, {expectedVersion: (await productsService.getManagedProduct(productFixture.actor, product.product.id)).product.version});
    await productsService.reviewProduct(product.product.id, {expectedVersion: (await productsService.getManagedProduct(productFixture.actor, product.product.id)).product.version, reviewerId: productFixture.adminID,  decision: 'active' });

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
    await outfitsService.submitOutfit(outfitFixture.actor, outfit.id, {expectedVersion: (await outfitsService.getManagedOutfit(outfitFixture.actor, outfit.id)).version});
    await outfitsService.reviewOutfit(outfitFixture.admin, outfit.id, {expectedVersion: (await outfitsService.getManagedOutfit(outfitFixture.actor, outfit.id)).version, decision: 'published' });
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
      await productsService.submitProduct(productFixture.actor, detail.product.id, {expectedVersion: (await productsService.getManagedProduct(productFixture.actor, detail.product.id)).product.version});
      await productsService.reviewProduct(detail.product.id, {expectedVersion: (await productsService.getManagedProduct(productFixture.actor, detail.product.id)).product.version, reviewerId: productFixture.adminID,  decision: 'active' });
      items.push({productId: detail.product.id, itemType: 'top', position, isRequired: true, isShoppable: true});
    }
    const outfit = await outfitsService.createOutfit(outfitFixture.actor, {requestId: randomUUID(), tagIds: [], creatorId: id('creator'), title: 'International',
      description: 'Two independent currency totals', images: [{url: 'https://cdn.test/outfit.jpg', position: OUTFIT_EDITING.limits.first}], items });
    await outfitsService.submitOutfit(outfitFixture.actor, outfit.id, {expectedVersion: (await outfitsService.getManagedOutfit(outfitFixture.actor, outfit.id)).version});
    await outfitsService.reviewOutfit(outfitFixture.admin, outfit.id, {expectedVersion: (await outfitsService.getManagedOutfit(outfitFixture.actor, outfit.id)).version, decision: 'published' });
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
    await productsService.submitProduct(productFixture.actor, product.product.id, {expectedVersion: (await productsService.getManagedProduct(productFixture.actor, product.product.id)).product.version});
    await productsService.reviewProduct(product.product.id, {expectedVersion: (await productsService.getManagedProduct(productFixture.actor, product.product.id)).product.version, reviewerId: productFixture.adminID,  decision: 'active' });

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
    await outfitsService.submitOutfit(outfitFixture.actor, published.id, {expectedVersion: (await outfitsService.getManagedOutfit(outfitFixture.actor, published.id)).version});
    await outfitsService.reviewOutfit(outfitFixture.admin, published.id, {expectedVersion: (await outfitsService.getManagedOutfit(outfitFixture.actor, published.id)).version, decision: 'published' });

    const feed = await outfitsService.getPublicFeed({ limit: 1 });
    expect(feed.items).toEqual([expect.objectContaining({ id: published.id, title: 'Published Fit' })]);
    await expect(outfitsService.getPublicDetail(draft.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(outfitsService.getPublicDetail(published.id)).resolves.toMatchObject({
      id: published.id,
      items: [expect.objectContaining({ product: expect.objectContaining({ price: 18000 }) })]
    });
  });

  it('filters editorial public collection items to published outfits and active products', async () => {
    const { productsService, productRepository, outfitsService, outfitRepository } = services();
    const editorialRepository = new MemoryEditorialRepository();
    const editorialService = new EditorialService(editorialRepository, outfitRepository, productRepository);

    const activeProduct = await productsService.createProduct(productFixture.actor, {requestId: randomUUID(), currency: productFixture.currency, variants: [{sku: productFixture.skuPrefix + randomUUID(), stockQuantity: productFixture.stock}], images: [productFixture.image],
      brandId: productFixture.brandID,
      name: 'Active Belt',
      description: 'Clean belt',
      category: 'accessory',
      basePrice: 9000
    });
    await productsService.submitProduct(productFixture.actor, activeProduct.product.id, {expectedVersion: (await productsService.getManagedProduct(productFixture.actor, activeProduct.product.id)).product.version});
    await productsService.reviewProduct(activeProduct.product.id, {expectedVersion: (await productsService.getManagedProduct(productFixture.actor, activeProduct.product.id)).product.version, reviewerId: productFixture.adminID,  decision: 'active' });

    const draftProduct = await productsService.createProduct(productFixture.actor, {requestId: randomUUID(), currency: productFixture.currency, variants: [{sku: productFixture.skuPrefix + randomUUID(), stockQuantity: productFixture.stock}], images: [productFixture.image],
      brandId: productFixture.brandID,
      name: 'Draft Belt',
      description: 'Hidden belt',
      category: 'accessory',
      basePrice: 8000
    });

    const publishedOutfit = await outfitsService.createOutfit(outfitFixture.actor, {requestId: randomUUID(), tagIds: [],
      creatorId: id('creator'),
      title: 'Editorial Fit',
      description: 'Visible outfit',
      images: [{url: 'https://cdn.test/editorial.jpg', position: OUTFIT_EDITING.limits.first}],
      items: [{ productId: activeProduct.product.id, itemType: 'accessory', position: 0, isRequired: true, isShoppable: true }]
    });
    await outfitsService.submitOutfit(outfitFixture.actor, publishedOutfit.id, {expectedVersion: (await outfitsService.getManagedOutfit(outfitFixture.actor, publishedOutfit.id)).version});
    await outfitsService.reviewOutfit(outfitFixture.admin, publishedOutfit.id, {expectedVersion: (await outfitsService.getManagedOutfit(outfitFixture.actor, publishedOutfit.id)).version, decision: 'published' });

    const draftOutfit = await outfitsService.createOutfit(outfitFixture.actor, {requestId: randomUUID(), tagIds: [],
      creatorId: id('creator'),
      title: 'Hidden Fit',
      description: 'Hidden outfit',
      images: [{url: 'https://cdn.test/hidden.jpg', position: OUTFIT_EDITING.limits.first}],
      items: [{ productId: activeProduct.product.id, itemType: 'accessory', position: 0, isRequired: true, isShoppable: true }]
    });

    editorialRepository.items = [
      { id: id('e1'), collectionId: editorialRepository.collection.id, itemType: 'outfit', outfitId: publishedOutfit.id, productId: null, position: 0 },
      { id: id('e2'), collectionId: editorialRepository.collection.id, itemType: 'outfit', outfitId: draftOutfit.id, productId: null, position: 1 },
      { id: id('e3'), collectionId: editorialRepository.collection.id, itemType: 'product', outfitId: null, productId: activeProduct.product.id, position: 2 },
      { id: id('e4'), collectionId: editorialRepository.collection.id, itemType: 'product', outfitId: null, productId: draftProduct.product.id, position: 3 }
    ];

    await expect(editorialService.getPublicCollections()).resolves.toEqual([
      expect.objectContaining({
        items: [
          expect.objectContaining({ outfitId: publishedOutfit.id }),
          expect.objectContaining({ productId: activeProduct.product.id })
        ]
      })
    ]);
  });
});

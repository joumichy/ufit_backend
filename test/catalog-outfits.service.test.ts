import {randomUUID} from 'node:crypto';
import {MemoryProductRepository, productFixture} from './products/memory-product.repository';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ProductsService } from '../src/modules/products/application/products.service';
import type { Product, ProductDetail, ProductImage, ProductRepository, ProductStatus, ProductVariant } from '../src/modules/products/domain/product.types';
import { OutfitsService } from '../src/modules/outfits/application/outfits.service';
import type { Outfit, OutfitDetail, OutfitImage, OutfitItem, OutfitRepository, OutfitStatus, OutfitVisibility } from '../src/modules/outfits/domain/outfit.types';
import { EditorialService } from '../src/modules/editorial/application/editorial.service';
import type { EditorialCollection, EditorialCollectionDetail, EditorialCollectionItem, EditorialRepository } from '../src/modules/editorial/domain/editorial.types';

const id = (name: string) => `00000000-0000-4000-8000-${name.padStart(12, '0').slice(0, 12)}`;

class MemoryOutfitRepository implements OutfitRepository {
  outfits = new Map<string, Outfit>();
  items: OutfitItem[] = [];
  images: OutfitImage[] = [];
  private sequence = 1;

  async createOutfit(input: Parameters<OutfitRepository['createOutfit']>[0]): Promise<Outfit> {
    const outfit: Outfit = {
      id: id(`outfit${this.sequence++}`),
      status: 'draft',
      visibility: 'private',
      totalPriceMin: 0,
      totalPriceMax: 0,
      publishedAt: null,
      createdAt: new Date('2026-05-20T00:00:00.000Z'),
      updatedAt: new Date('2026-05-20T00:00:00.000Z'),
      ...input
    };
    this.outfits.set(outfit.id, outfit);
    return outfit;
  }

  async addItems(outfitId: string, items: Parameters<OutfitRepository['addItems']>[1]): Promise<OutfitItem[]> {
    const rows = items.map((item) => ({ id: id(`item${this.sequence++}`), outfitId, ...item }));
    this.items.push(...rows);
    return rows;
  }

  async addImages(outfitId: string, images: Parameters<OutfitRepository['addImages']>[1]): Promise<OutfitImage[]> {
    const rows = images.map((image) => ({ id: id(`image${this.sequence++}`), outfitId, ...image }));
    this.images.push(...rows);
    return rows;
  }

  async findById(outfitId: string): Promise<OutfitDetail | null> {
    const outfit = this.outfits.get(outfitId);
    return outfit
      ? {
          outfit,
          author: null,
          items: this.items.filter((item) => item.outfitId === outfitId),
          images: this.images.filter((image) => image.outfitId === outfitId)
        }
      : null;
  }

  async updateStatus(outfitId: string, status: OutfitStatus, visibility: OutfitVisibility, reviewerId?: string, rejectionReason?: string): Promise<Outfit> {
    const outfit = this.outfits.get(outfitId);
    if (!outfit) {
      throw new Error('missing outfit');
    }
    const updated = {
      ...outfit,
      status,
      visibility,
      reviewedBy: reviewerId,
      reviewedAt: status === 'published' || status === 'rejected' ? new Date('2026-05-20T00:00:00.000Z') : null,
      rejectionReason: status === 'rejected' ? rejectionReason ?? null : null,
      publishedAt: status === 'published' ? new Date('2026-05-20T00:00:00.000Z') : null
    };
    this.outfits.set(outfitId, updated);
    return updated;
  }

  async updateTotals(outfitId: string, totalPriceMin: number, totalPriceMax: number): Promise<Outfit> {
    const outfit = this.outfits.get(outfitId);
    if (!outfit) {
      throw new Error('missing outfit');
    }
    const updated = { ...outfit, totalPriceMin, totalPriceMax };
    this.outfits.set(outfitId, updated);
    return updated;
  }

  async findPublishedPage(input: { limit: number; cursor?: string }): Promise<OutfitDetail[]> {
    const rows = [...this.outfits.values()]
      .filter((outfit) => outfit.status === 'published')
      .sort((a, b) => b.id.localeCompare(a.id))
      .filter((outfit) => (input.cursor ? outfit.id < input.cursor : true))
      .slice(0, input.limit);
    const details = await Promise.all(rows.map((outfit) => this.findById(outfit.id)));
    return details.filter((detail): detail is OutfitDetail => Boolean(detail));
  }
}

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
  const outfitRepository = new MemoryOutfitRepository();
  return {
    productRepository,
    outfitRepository,
    productsService: new ProductsService(productRepository),
    outfitsService: new OutfitsService(outfitRepository, productRepository)
  };
}

describe('Products and outfits services', () => {
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

    const outfit = await outfitsService.createOutfit({
      creatorId: id('creator'),
      title: 'City Uniform',
      description: 'A sharp weekday silhouette',
      coverImageUrl: 'https://cdn.test/outfit.jpg',
      items: [
        { productId: product.product.id, itemType: 'shoes', position: 1, isRequired: true, isShoppable: true },
        { externalLabel: 'Vintage white shirt', itemType: 'top', position: 0, isRequired: true, isShoppable: false }
      ]
    });

    expect(outfit.items).toHaveLength(2);
    await outfitsService.submitOutfit(outfit.outfit.id);
    await outfitsService.reviewOutfit(outfit.outfit.id, { decision: 'published' });
    expect((await outfitsService.getPublicDetail(outfit.outfit.id)).prices).toEqual([{currency: 'CHF', min: 24000, max: 24000}]);
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
    const outfit = await outfitsService.createOutfit({ creatorId: id('creator'), title: 'International',
      description: 'Two independent currency totals', coverImageUrl: 'https://cdn.test/outfit.jpg', items });
    await outfitsService.submitOutfit(outfit.outfit.id);
    await outfitsService.reviewOutfit(outfit.outfit.id, { decision: 'published' });
    const card = (await outfitsService.getPublicFeed({limit: 1})).items[0];
    expect(card.prices).toEqual([{currency: 'CHF', min: 10090, max: 10090}, {currency: 'EUR', min: 9000, max: 9000}]);
    expect(card).not.toHaveProperty('currency');
    expect(card).not.toHaveProperty('totalPriceMax');
    expect(card.author).toBeNull();
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

    const draft = await outfitsService.createOutfit({
      creatorId: id('creator'),
      title: 'Quiet Draft',
      description: 'Should remain private',
      coverImageUrl: 'https://cdn.test/draft.jpg',
      items: [{ productId: product.product.id, itemType: 'top', position: 0, isRequired: true, isShoppable: true }]
    });
    const published = await outfitsService.createOutfit({
      creatorId: id('creator'),
      title: 'Published Fit',
      description: 'Visible in feed',
      coverImageUrl: 'https://cdn.test/published.jpg',
      items: [{ productId: product.product.id, itemType: 'top', position: 0, isRequired: true, isShoppable: true }]
    });
    await outfitsService.submitOutfit(published.outfit.id);
    await outfitsService.reviewOutfit(published.outfit.id, { decision: 'published', reviewerId: id('admin') });

    const feed = await outfitsService.getPublicFeed({ limit: 1 });
    expect(feed.items).toEqual([expect.objectContaining({ id: published.outfit.id, title: 'Published Fit' })]);
    await expect(outfitsService.getPublicDetail(draft.outfit.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(outfitsService.getPublicDetail(published.outfit.id)).resolves.toMatchObject({
      id: published.outfit.id,
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

    const publishedOutfit = await outfitsService.createOutfit({
      creatorId: id('creator'),
      title: 'Editorial Fit',
      description: 'Visible outfit',
      coverImageUrl: 'https://cdn.test/editorial.jpg',
      items: [{ productId: activeProduct.product.id, itemType: 'accessory', position: 0, isRequired: true, isShoppable: true }]
    });
    await outfitsService.submitOutfit(publishedOutfit.outfit.id);
    await outfitsService.reviewOutfit(publishedOutfit.outfit.id, { decision: 'published' });

    const draftOutfit = await outfitsService.createOutfit({
      creatorId: id('creator'),
      title: 'Hidden Fit',
      description: 'Hidden outfit',
      coverImageUrl: 'https://cdn.test/hidden.jpg',
      items: [{ productId: activeProduct.product.id, itemType: 'accessory', position: 0, isRequired: true, isShoppable: true }]
    });

    editorialRepository.items = [
      { id: id('e1'), collectionId: editorialRepository.collection.id, itemType: 'outfit', outfitId: publishedOutfit.outfit.id, productId: null, position: 0 },
      { id: id('e2'), collectionId: editorialRepository.collection.id, itemType: 'outfit', outfitId: draftOutfit.outfit.id, productId: null, position: 1 },
      { id: id('e3'), collectionId: editorialRepository.collection.id, itemType: 'product', outfitId: null, productId: activeProduct.product.id, position: 2 },
      { id: id('e4'), collectionId: editorialRepository.collection.id, itemType: 'product', outfitId: null, productId: draftProduct.product.id, position: 3 }
    ];

    await expect(editorialService.getPublicCollections()).resolves.toEqual([
      expect.objectContaining({
        items: [
          expect.objectContaining({ outfitId: publishedOutfit.outfit.id }),
          expect.objectContaining({ productId: activeProduct.product.id })
        ]
      })
    ]);
  });
});

import {randomUUID} from 'node:crypto';
import {ConflictException} from '@nestjs/common';
import {isUUID} from 'class-validator';
import type {Product, ProductDetail, ProductImage, ProductRepository, ProductStatus, ProductVariant} from '../../src/modules/products/domain/product.types';
import {PRODUCT_EDITING, PRODUCT_STATUS, PRODUCT_VARIANT_STATUS} from '../../src/modules/products/domain/product-contract';
import type {AuthenticatedUser} from '../../src/modules/identity/domain/user.types';

export const productFixture = {
  actor: {id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', roles: ['brand_owner']} satisfies Pick<AuthenticatedUser, 'id' | 'roles'>,
  adminID: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  brandID: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  image: {url: 'https://cdn.test/product.jpg', position: 0, kind: 'product'} as const,
  firstIndex: 0, createdProductCount: 1, invalidVersion: 0, restockQuantity: 5, changedName: 'Changed', revisedName: 'Nouvelle veste', rollbackName: 'Must rollback', name: 'Veste Ufit', description: 'Veste de qualification', category: 'Veste', basePrice: 12345, currency: 'CHF', skuPrefix: 'CATALOG-', stock: 2, timestamp: new Date('2026-05-20T00:00:00.000Z'),
  invalid: 'Invalid product fixture contract',
} as const;
export class MemoryProductRepository implements ProductRepository {
  products = new Map<string, Product>();
  variants: ProductVariant[] = [];
  images: ProductImage[] = [];
  members = new Set([productFixture.brandID + productFixture.actor.id]);
  activeBrands = new Set<string>([productFixture.brandID]);
  private requests = new Map<string, {id: string; fingerprint: string}>();
  async transaction<T>(operation: (repository: ProductRepository) => Promise<T>): Promise<T> {
    const before = structuredClone({products: this.products, variants: this.variants, images: this.images, requests: this.requests});
    try { return await operation(this); }
    catch (error) { this.products = before.products; this.variants = before.variants; this.images = before.images; this.requests = before.requests; throw error; }
  }
  async readSnapshot<T>(operation: (repository: ProductRepository) => Promise<T>): Promise<T> { return operation(this); }
  async hasBrandMembership(brandId: string, userId: string) { return this.members.has(brandId + userId); }
  async lockBrandMembership(brandId: string, userId: string) { return this.members.has(brandId + userId); }
  async lockProduct(productId: string) { return this.products.get(productId); }
  async findByCreationRequest(brandId: string, requestId: string) {
    const request = this.requests.get(brandId + requestId);
    const detail = request ? await this.findById(request.id) : null;
    return detail && request ? {detail, fingerprint: request.fingerprint} : null;
  }
  async list(query: Parameters<ProductRepository['list']>[0]) {
    const rows = [...this.products.values()].filter(row => (!query.brandId || row.brandId === query.brandId) && (!query.status || row.status === query.status) && (!query.cursor || row.id > query.cursor)).sort((a, b) => a.id.localeCompare(b.id));
    const page = rows.slice(PRODUCT_EDITING.limits.firstIndex, query.limit);
    const items = await Promise.all(page.map(row => this.findById(row.id)));
    return {items: items as ProductDetail[], nextCursor: rows.length > query.limit ? page.at(PRODUCT_EDITING.limits.lastIndex)!.id : null};
  }
  async createProduct(input: Parameters<ProductRepository['createProduct']>[0]): Promise<Product> {
    if (!isUUID(input.brandId) || !isUUID(input.creationRequestId)) throw new Error(productFixture.invalid);
    const {creationRequestId, creationFingerprint, ...fields} = input;
    const product: Product = {...fields, id: randomUUID(), version: PRODUCT_EDITING.versionInitial, status: input.status ?? PRODUCT_STATUS.draft,
      createdAt: productFixture.timestamp, updatedAt: productFixture.timestamp};
    this.products.set(product.id, product);
    this.requests.set(input.brandId + creationRequestId, {id: product.id, fingerprint: creationFingerprint});
    return product;
  }
  async addVariants(productId: string, variants: Parameters<ProductRepository['addVariants']>[1]): Promise<ProductVariant[]> {
    if (!this.products.has(productId)) throw new Error(productFixture.invalid);
    const rows = variants.map(variant => ({...variant, id: randomUUID(), productId, status: variant.status ?? PRODUCT_VARIANT_STATUS.active}));
    if (new Set([...this.variants, ...rows].map(row => row.sku)).size !== this.variants.length + rows.length) throw new Error(PRODUCT_EDITING.failure.sku.message);
    this.variants.push(...rows); return rows;
  }
  async addImages(productId: string, images: Parameters<ProductRepository['addImages']>[1]): Promise<ProductImage[]> {
    if (!this.products.has(productId)) throw new Error(productFixture.invalid);
    const rows = images.map(image => ({...image, id: randomUUID(), productId}));
    this.images.push(...rows); return rows;
  }
  async findById(productId: string): Promise<ProductDetail | null> {
    const product = this.products.get(productId);
    return product ? {product, variants: this.variants.filter(row => row.productId === productId), images: this.images.filter(row => row.productId === productId)} : null;
  }
  async findActiveByIds(productIds: string[]): Promise<ProductDetail[]> {
    const details = await Promise.all(productIds.map(id => this.findById(id)));
    return details.filter((detail): detail is ProductDetail => detail !== null && detail.product.status === PRODUCT_STATUS.active && this.activeBrands.has(detail.product.brandId));
  }
  async replaceProduct(productId: string, input: Parameters<ProductRepository['replaceProduct']>[1]): Promise<void> {
    const product = this.products.get(productId); if (!product) throw new Error(productFixture.invalid);
    this.products.set(productId, {...product, ...input.fields, version: product.version + PRODUCT_EDITING.versionStep, status: PRODUCT_STATUS.draft, reviewedBy: null, reviewedAt: null, rejectionReason: null});
    for (const variant of input.variants) {
      const {id, expectedStockQuantity, ...fields} = variant;
      const existing = this.variants.find(row => row.id === id && row.productId === productId);
      if (id) {
        if (!existing || existing.stockQuantity !== expectedStockQuantity) throw new ConflictException(PRODUCT_EDITING.failure.stockChanged);
        Object.assign(existing, fields);
      } else this.variants.push({...fields, id: randomUUID(), productId});
    }
    const retained = input.images.flatMap(image => image.id ? [image.id] : []);
    this.images = this.images.filter(row => row.productId !== productId || retained.includes(row.id));
    for (const image of input.images) {
      const existing = this.images.find(row => row.id === image.id && row.productId === productId);
      if (existing) Object.assign(existing, image); else this.images.push({...image, id: randomUUID(), productId});
    }
  }
  async setVariantStock(productId: string, variantId: string, expectedQuantity: number, quantity: number): Promise<boolean> {
    const variant = this.variants.find(row => row.productId === productId && row.id === variantId && row.stockQuantity === expectedQuantity && row.status !== PRODUCT_VARIANT_STATUS.archived);
    if (!variant) return false;
    variant.stockQuantity = quantity; variant.status = quantity > PRODUCT_EDITING.limits.integerMin ? PRODUCT_VARIANT_STATUS.active : PRODUCT_VARIANT_STATUS.outOfStock;
    return true;
  }
  async bumpVersion(productId: string): Promise<void> {
    const product = this.products.get(productId); if (!product) throw new Error(productFixture.invalid);
    this.products.set(productId, {...product, version: product.version + PRODUCT_EDITING.versionStep});
  }
  async updateStatus(productId: string, status: ProductStatus, reviewerId?: string, rejectionReason?: string): Promise<Product> {
    const product = this.products.get(productId); if (!product) throw new Error(productFixture.invalid);
    const reviewed = status === PRODUCT_STATUS.active || status === PRODUCT_STATUS.rejected;
    const updated = {...product, status, version: product.version + PRODUCT_EDITING.versionStep, reviewedBy: reviewed ? reviewerId ?? null : null,
      reviewedAt: reviewed ? productFixture.timestamp : null, rejectionReason: status === PRODUCT_STATUS.rejected ? rejectionReason ?? null : null};
    this.products.set(productId, updated); return updated;
  }
}

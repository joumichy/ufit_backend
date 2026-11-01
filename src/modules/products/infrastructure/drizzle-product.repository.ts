import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, ne, notInArray, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import type { DatabaseSession } from '../../../shared/infrastructure/database/database-session';
import { brandMembers, brandProfiles, productImages, products, productVariants, productMediaAssets } from '../../../shared/infrastructure/database/schema';
import { PRODUCT_MEDIA } from '../../media/domain/product-media.contract';
import { PROFILE_EDITING, PROFILE_STATUS } from '../../../shared/domain/profile-editing.contract';
import { PRODUCT_EDITING, PRODUCT_STATUS, PRODUCT_VARIANT_STATUS } from '../domain/product-contract';
import type { Product, ProductContentUpdate, ProductDetail, ProductImage, ProductListPage, ProductListQuery, ProductRepository, ProductStatus, ProductVariant, ProductSelectionQuery } from '../domain/product.types';

const productProjection = {id: products.id, brandId: products.brandId, version: products.version, name: products.name, slug: products.slug,
  description: products.description, category: products.category, genderTarget: products.genderTarget, status: products.status,
  basePrice: products.basePrice, currency: products.currency, material: products.material, careInstructions: products.careInstructions,
  reviewedBy: products.reviewedBy, reviewedAt: products.reviewedAt, rejectionReason: products.rejectionReason, createdAt: products.createdAt, updatedAt: products.updatedAt};
const variantProjection = {id: productVariants.id, productId: productVariants.productId, size: productVariants.size, color: productVariants.color,
  sku: productVariants.sku, stockQuantity: productVariants.stockQuantity, priceOverride: productVariants.priceOverride, status: productVariants.status};
const imageProjection = {id: productImages.id, productId: productImages.productId, url: productImages.url, position: productImages.position, kind: productImages.kind};
const brandProjection = {id: brandProfiles.id, brandName: brandProfiles.brandName, status: brandProfiles.status};

@Injectable()
export class DrizzleProductRepository implements ProductRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}

  transaction<T>(operation: (repository: ProductRepository) => Promise<T>): Promise<T> {
    return this.database.db.transaction(tx => operation(new DrizzleProductRepository({db: tx})));
  }
  readSnapshot<T>(operation: (repository: ProductRepository) => Promise<T>): Promise<T> {
    return this.database.db.transaction(tx => operation(new DrizzleProductRepository({db: tx})),
      {isolationLevel: PRODUCT_EDITING.persistence.readIsolation, accessMode: PRODUCT_EDITING.persistence.readAccess});
  }
  private memberQuery(brandId: string, userId: string) {
    return this.database.db.select({id: brandProfiles.id}).from(brandProfiles)
      .innerJoin(brandMembers, and(eq(brandMembers.brandProfileId, brandProfiles.id), eq(brandMembers.userId, userId), eq(brandMembers.status, PROFILE_EDITING.persistence.memberActive)))
      .where(and(eq(brandProfiles.id, brandId), ne(brandProfiles.status, PROFILE_STATUS.suspended)));
  }
  async hasBrandMembership(brandId: string, userId: string): Promise<boolean> {
    const [row] = await this.memberQuery(brandId, userId);
    return row !== undefined;
  }
  async lockBrandMembership(brandId: string, userId: string): Promise<boolean> {
    const [row] = await this.memberQuery(brandId, userId).for(PRODUCT_EDITING.persistence.lock);
    return row !== undefined;
  }
  async hasReadyProductMedia(brandId: string, ids: string[]): Promise<boolean> {
    if (!ids.length) return true;
    const rows = await this.database.db.select({id: productMediaAssets.id}).from(productMediaAssets)
      .where(and(inArray(productMediaAssets.id, ids), eq(productMediaAssets.brandId, brandId), eq(productMediaAssets.status, PRODUCT_MEDIA.status.ready)));
    return rows.length === new Set(ids).size;
  }
  async lockProduct(productId: string): Promise<Product | undefined> {
    const [row] = await this.database.db.select(productProjection).from(products).where(eq(products.id, productId)).for(PRODUCT_EDITING.persistence.lock);
    return row;
  }
  async findByCreationRequest(brandId: string, requestId: string): Promise<{detail: ProductDetail; fingerprint: string | null} | null> {
    const [row] = await this.database.db.select({id: products.id, fingerprint: products.creationFingerprint}).from(products)
      .where(and(eq(products.brandId, brandId), eq(products.creationRequestId, requestId)));
    if (!row) return null;
    const detail = await this.findById(row.id);
    return detail ? {detail, fingerprint: row.fingerprint} : null;
  }
  async list(query: ProductListQuery): Promise<ProductListPage> {
    const rows = await this.database.db.select({product: productProjection, brand: brandProjection}).from(products)
      .innerJoin(brandProfiles, eq(brandProfiles.id, products.brandId))
      .where(and(query.brandId ? eq(products.brandId, query.brandId) : undefined,
        query.status ? eq(products.status, query.status) : undefined, query.cursor ? gt(products.id, query.cursor) : undefined))
      .orderBy(products.id).limit(query.limit + PRODUCT_EDITING.limits.pageOverflow);
    const page = rows.slice(PRODUCT_EDITING.limits.firstIndex, query.limit);
    const ids = page.map(row => row.product.id);
    if (!ids.length) return {items: [], nextCursor: null};
    const [variants, images] = await Promise.all([
      this.database.db.select(variantProjection).from(productVariants).where(inArray(productVariants.productId, ids)).orderBy(productVariants.id),
      this.database.db.select(imageProjection).from(productImages).where(inArray(productImages.productId, ids)).orderBy(productImages.position, productImages.id)
    ]);
    return {items: page.map(({product, brand}) => ({product, brand, variants: variants.filter(row => row.productId === product.id), images: images.filter(row => row.productId === product.id)})),
      nextCursor: rows.length > query.limit ? page.at(PRODUCT_EDITING.limits.lastIndex)!.product.id : null};
  }
  async findSelectablePage(query: ProductSelectionQuery): Promise<ProductListPage> {
    const rows = await this.database.db.select({product: productProjection, brand: brandProjection}).from(products)
      .innerJoin(brandProfiles, and(eq(brandProfiles.id, products.brandId), eq(brandProfiles.status, PROFILE_STATUS.active)))
      .where(and(eq(products.status, PRODUCT_STATUS.active), query.brandId ? eq(products.brandId, query.brandId) : undefined, query.cursor ? gt(products.id, query.cursor) : undefined,
        query.search ? sql`position(lower(${query.search}) in lower(${products.name})) > ${PRODUCT_EDITING.limits.integerMin}` : undefined))
      .orderBy(products.id).limit(query.limit + PRODUCT_EDITING.limits.pageOverflow);
    const page = rows.slice(PRODUCT_EDITING.limits.firstIndex, query.limit), ids = page.map(row => row.product.id);
    if (!ids.length) return {items: [], nextCursor: null};
    const variants = await this.database.db.select(variantProjection).from(productVariants).where(inArray(productVariants.productId, ids)).orderBy(productVariants.id);
    const images = await this.database.db.select(imageProjection).from(productImages).where(inArray(productImages.productId, ids)).orderBy(productImages.position, productImages.id);
    return {items: page.map(({product, brand}) => ({product, brand, variants: variants.filter(variant => variant.productId === product.id), images: images.filter(image => image.productId === product.id)})),
      nextCursor: rows.length > query.limit ? page.at(PRODUCT_EDITING.limits.lastIndex)!.product.id : null};
  }
  async createProduct(input: Parameters<ProductRepository['createProduct']>[0]): Promise<Product> {
    const [row] = await this.database.db.insert(products).values({...input, status: input.status ?? PRODUCT_STATUS.draft}).returning(productProjection);
    return row;
  }
  async addVariants(productId: string, variants: Parameters<ProductRepository['addVariants']>[1]): Promise<ProductVariant[]> {
    if (!variants.length) return [];
    return this.database.db.insert(productVariants)
      .values(variants.map(variant => ({...variant, productId, status: variant.status ?? PRODUCT_VARIANT_STATUS.active}))).returning(variantProjection);
  }
  async addImages(productId: string, images: Parameters<ProductRepository['addImages']>[1]): Promise<ProductImage[]> {
    if (!images.length) return [];
    return this.database.db.insert(productImages).values(images.map(image => ({...image, productId}))).returning(imageProjection);
  }
  async findById(productId: string): Promise<ProductDetail | null> {
    const [row] = await this.database.db.select({product: productProjection, brand: brandProjection}).from(products)
      .innerJoin(brandProfiles, eq(brandProfiles.id, products.brandId)).where(eq(products.id, productId));
    if (!row) return null;
    const [variants, images] = await Promise.all([
      this.database.db.select(variantProjection).from(productVariants).where(eq(productVariants.productId, productId)).orderBy(productVariants.id),
      this.database.db.select(imageProjection).from(productImages).where(eq(productImages.productId, productId)).orderBy(productImages.position, productImages.id)
    ]);
    return {...row, variants, images};
  }
  async findActiveByIds(productIds: string[]): Promise<ProductDetail[]> {
    if (!productIds.length) return [];
    const rows = await this.database.db.select({product: productProjection, brand: brandProjection}).from(products)
      .innerJoin(brandProfiles, and(eq(brandProfiles.id, products.brandId), eq(brandProfiles.status, PROFILE_STATUS.active)))
      .where(and(inArray(products.id, productIds), eq(products.status, PRODUCT_STATUS.active)));
    if (!rows.length) return [];
    const activeIDs = rows.map(row => row.product.id);
    const [variants, images] = await Promise.all([
      this.database.db.select(variantProjection).from(productVariants).where(inArray(productVariants.productId, activeIDs)),
      this.database.db.select(imageProjection).from(productImages).where(inArray(productImages.productId, activeIDs))
    ]);
    return rows.map(({product, brand}) => ({product, brand, variants: variants.filter(variant => variant.productId === product.id), images: images.filter(image => image.productId === product.id)}));
  }
  async replaceProduct(productId: string, input: ProductContentUpdate): Promise<void> {
    await this.database.db.update(products).set({...input.fields, status: PRODUCT_STATUS.draft, reviewedBy: null, reviewedAt: null, rejectionReason: null,
      version: sql`${products.version} + ${PRODUCT_EDITING.versionStep}`, updatedAt: new Date()}).where(eq(products.id, productId));
    const ordered = [...input.variants].sort((left, right) => (left.id ?? left.sku).localeCompare(right.id ?? right.sku));
    for (const variant of ordered) {
      const {id, expectedStockQuantity, ...values} = variant;
      if (id) {
        const [row] = await this.database.db.update(productVariants).set({...values, updatedAt: new Date()})
          .where(and(eq(productVariants.id, id), eq(productVariants.productId, productId), eq(productVariants.stockQuantity, expectedStockQuantity!))).returning({id: productVariants.id});
        if (!row) throw new ConflictException(PRODUCT_EDITING.failure.stockChanged);
      } else await this.database.db.insert(productVariants).values({...values, productId});
    }
    const retainedImages = input.images.flatMap(image => image.id ? [image.id] : []);
    await this.database.db.delete(productImages).where(and(eq(productImages.productId, productId),
      retainedImages.length ? notInArray(productImages.id, retainedImages) : undefined));
    for (const image of input.images) {
      const {id, ...values} = image;
      if (id) await this.database.db.update(productImages).set(values).where(and(eq(productImages.id, id), eq(productImages.productId, productId)));
      else await this.database.db.insert(productImages).values({...values, productId});
    }
  }
  async setVariantStock(productId: string, variantId: string, expectedQuantity: number, quantity: number): Promise<boolean> {
    const [row] = await this.database.db.update(productVariants).set({stockQuantity: quantity,
      status: quantity > PRODUCT_EDITING.limits.integerMin ? PRODUCT_VARIANT_STATUS.active : PRODUCT_VARIANT_STATUS.outOfStock, updatedAt: new Date()})
      .where(and(eq(productVariants.id, variantId), eq(productVariants.productId, productId), eq(productVariants.stockQuantity, expectedQuantity), ne(productVariants.status, PRODUCT_VARIANT_STATUS.archived)))
      .returning({id: productVariants.id});
    return row !== undefined;
  }
  async bumpVersion(productId: string): Promise<void> {
    await this.database.db.update(products).set({version: sql`${products.version} + ${PRODUCT_EDITING.versionStep}`, updatedAt: new Date()}).where(eq(products.id, productId));
  }
  async updateStatus(productId: string, status: ProductStatus, reviewerId?: string, rejectionReason?: string): Promise<Product> {
    const reviewed = status === PRODUCT_STATUS.active || status === PRODUCT_STATUS.rejected;
    const [row] = await this.database.db.update(products).set({status, reviewedBy: reviewed ? reviewerId ?? null : null,
      reviewedAt: reviewed ? new Date() : null, rejectionReason: status === PRODUCT_STATUS.rejected ? rejectionReason : null,
      version: sql`${products.version} + ${PRODUCT_EDITING.versionStep}`, updatedAt: new Date()}).where(eq(products.id, productId)).returning(productProjection);
    return row;
  }
}

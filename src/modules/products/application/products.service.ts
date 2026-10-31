import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { DrizzleQueryError } from 'drizzle-orm';
import { PRODUCT_REPOSITORY, type Product, type ProductContentUpdate, type ProductDetail, type ProductDetailResponse, type ProductRepository } from '../domain/product.types';
import { PRODUCT_MEDIA } from '../../media/domain/product-media.contract';
import type { ProductMediaReader } from '../../media/domain/product-media.types';
import { PRODUCT_ADMIN_ROLES, PRODUCT_CURRENCIES, PRODUCT_EDITING, PRODUCT_STATUS, PRODUCT_STATUSES, PRODUCT_VARIANT_STATUS } from '../domain/product-contract';
import type { AuthenticatedUser } from '../../identity/domain/user.types';
import { CreateProductDto, ProductFieldsDto, ProductVersionDto, ReviewProductDto, UpdateProductDto, UpdateProductStockDto } from './dto/product.dto';

enum ProductMutationAccess { MemberOnly, Moderation }
type ProductActor = Pick<AuthenticatedUser, 'id' | 'roles'>;
const pageContract = z.object({brandId: z.uuid().optional(), status: z.enum(PRODUCT_STATUSES).optional(), cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(PRODUCT_EDITING.limits.pageMin).max(PRODUCT_EDITING.limits.pageMax).default(PRODUCT_EDITING.limits.pageDefault)}).strict();
const slugRules = {normalization: 'NFKD', emptyText: '', separator: '-', fallback: 'product', marks: /[\u0300-\u036f]/g, parts: /[^a-z0-9]+/g, edges: /^-|-$/g} as const;
export interface PublicProductDto {
  id: string; brandId: string; name: string; description: string; category: string;
  price: {min: number; max: number; currency: string};
  images: Array<{url: string; position: number; kind: string}>;
  variants: Array<{id: string; size: string | null; color: string | null; stockQuantity: number; price: number}>;
}
@Injectable()
export class ProductsService {
  constructor(@Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository,
    @Inject(PRODUCT_MEDIA.reader) private readonly media: ProductMediaReader) {}

  private isAdmin(user: ProductActor): boolean { return PRODUCT_ADMIN_ROLES.some(role => user.roles.includes(role)); }
  async listProducts(user: ProductActor, raw: unknown) {
    const parsed = pageContract.safeParse(raw);
    if (!parsed.success || (!this.isAdmin(user) && !parsed.data.brandId)) throw new BadRequestException(PRODUCT_EDITING.failure.invalidPage);
    const page = await this.products.readSnapshot(async repository => {
      if (!this.isAdmin(user) && !await repository.hasBrandMembership(parsed.data.brandId!, user.id)) throw new ForbiddenException(PRODUCT_EDITING.failure.access);
      return repository.list(parsed.data);
    });
    return {...page, items: await this.present(page.items)};
  }
  async getManagedProduct(user: ProductActor, productId: string): Promise<ProductDetailResponse> {
    const detail = await this.products.readSnapshot(async repository => {
      const detail = await this.requireProduct(repository, productId);
      if (!this.isAdmin(user) && !await repository.hasBrandMembership(detail.product.brandId, user.id)) throw new ForbiddenException(PRODUCT_EDITING.failure.access);
      return detail;
    });
    return (await this.present([detail]))[PRODUCT_EDITING.limits.firstIndex];
  }
  async recoverCreation(user: ProductActor, brandId: string, requestId: string): Promise<ProductDetailResponse> {
    const detail = await this.products.readSnapshot(async repository => {
      if (!await repository.hasBrandMembership(brandId, user.id)) throw new ForbiddenException(PRODUCT_EDITING.failure.access);
      const existing = await repository.findByCreationRequest(brandId, requestId);
      if (!existing) throw new NotFoundException(PRODUCT_EDITING.failure.missing);
      return existing.detail;
    });
    return (await this.present([detail]))[PRODUCT_EDITING.limits.firstIndex];
  }
  async createProduct(user: ProductActor, input: CreateProductDto): Promise<ProductDetailResponse> {
    const fields = this.fields(input);
    const variants = input.variants.map(variant => ({size: variant.size ?? null, color: variant.color ?? null, sku: variant.sku,
      stockQuantity: variant.stockQuantity, priceOverride: variant.priceOverride ?? null}));
    const images = [...input.images].sort((left, right) => left.position - right.position);
    const fingerprint = createHash(PRODUCT_EDITING.creation.hash).update(JSON.stringify({fields, variants, images})).digest(PRODUCT_EDITING.creation.encoding);
    const detail = await this.write(async repository => {
      if (!await repository.lockBrandMembership(input.brandId, user.id)) throw new ForbiddenException(PRODUCT_EDITING.failure.access);
      const existing = await repository.findByCreationRequest(input.brandId, input.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new ConflictException(PRODUCT_EDITING.failure.request);
        return existing.detail;
      }
      await this.requireMedia(repository, input.brandId, input.images);
      const slug = fields.name.normalize(slugRules.normalization).replace(slugRules.marks, slugRules.emptyText).toLowerCase()
        .replace(slugRules.parts, slugRules.separator).replace(slugRules.edges, slugRules.emptyText) || slugRules.fallback;
      const product = await repository.createProduct({...fields, brandId: input.brandId, creationRequestId: input.requestId, creationFingerprint: fingerprint,
        slug: slug + slugRules.separator + input.requestId.toLowerCase(), reviewedBy: null, reviewedAt: null, rejectionReason: null});
      await repository.addVariants(product.id, variants);
      await repository.addImages(product.id, images);
      return this.requireProduct(repository, product.id);
    });
    return (await this.present([detail]))[PRODUCT_EDITING.limits.firstIndex];
  }
  async updateProduct(user: ProductActor, productId: string, input: UpdateProductDto): Promise<ProductDetailResponse> {
    return this.mutateProduct(user, productId, input.expectedVersion, async (repository, detail) => {
      if (detail.product.status === PRODUCT_STATUS.underReview || detail.product.status === PRODUCT_STATUS.archived) throw new ConflictException(PRODUCT_EDITING.failure.state);
      const retainedIDs = input.variants.flatMap(variant => variant.id ? [variant.id] : []);
      if (new Set(retainedIDs).size !== retainedIDs.length || retainedIDs.length !== detail.variants.length ||
          detail.variants.some(variant => !retainedIDs.includes(variant.id)) || input.variants.some(variant => variant.id ? variant.expectedStockQuantity === undefined : variant.expectedStockQuantity !== undefined)) {
        throw new BadRequestException(PRODUCT_EDITING.failure.variants);
      }
      const imageIDs = input.images.flatMap(image => image.id ? [image.id] : []);
      if (new Set(imageIDs).size !== imageIDs.length || imageIDs.some(id => !detail.images.some(image => image.id === id))) throw new BadRequestException(PRODUCT_EDITING.failure.images);
      await this.requireMedia(repository, detail.product.brandId, input.images);
      await repository.replaceProduct(productId, {fields: this.fields(input), variants: input.variants.map(variant => ({...variant,
        size: variant.size ?? null, color: variant.color ?? null, priceOverride: variant.priceOverride ?? null})), images: input.images});
    });
  }
  async updateStock(user: ProductActor, productId: string, input: UpdateProductStockDto): Promise<ProductDetailResponse> {
    return this.mutateProduct(user, productId, input.expectedVersion, async (repository, detail) => {
      if (detail.product.status === PRODUCT_STATUS.archived) throw new ConflictException(PRODUCT_EDITING.failure.state);
      if (!await repository.setVariantStock(productId, input.variantId, input.expectedStockQuantity, input.stockQuantity)) throw new ConflictException(PRODUCT_EDITING.failure.stockChanged);
      await repository.bumpVersion(productId);
    });
  }
  async submitProduct(user: ProductActor, productId: string, input: ProductVersionDto): Promise<ProductDetailResponse> {
    return this.mutateProduct(user, productId, input.expectedVersion, async (repository, detail) => {
      if (detail.product.status !== PRODUCT_STATUS.draft && detail.product.status !== PRODUCT_STATUS.rejected) throw new ConflictException(PRODUCT_EDITING.failure.state);
      this.requireComplete(detail);
      await this.requireMedia(repository, detail.product.brandId, detail.images);
      await repository.updateStatus(productId, PRODUCT_STATUS.underReview);
    });
  }
  async archiveProduct(user: ProductActor, productId: string, input: ProductVersionDto): Promise<ProductDetailResponse> {
    return this.mutateProduct(user, productId, input.expectedVersion, async (repository, detail) => {
      if (detail.product.status === PRODUCT_STATUS.archived) throw new ConflictException(PRODUCT_EDITING.failure.state);
      await repository.updateStatus(productId, PRODUCT_STATUS.archived);
    }, ProductMutationAccess.Moderation);
  }
  async restoreProduct(user: ProductActor, productId: string, input: ProductVersionDto): Promise<ProductDetailResponse> {
    return this.mutateProduct(user, productId, input.expectedVersion, async (repository, detail) => {
      if (detail.product.status !== PRODUCT_STATUS.archived) throw new ConflictException(PRODUCT_EDITING.failure.state);
      await repository.updateStatus(productId, PRODUCT_STATUS.draft);
    }, ProductMutationAccess.Moderation);
  }
  async reviewProduct(productId: string, input: ReviewProductDto & {reviewerId: string}): Promise<ProductDetailResponse> {
    const before = await this.products.readSnapshot(repository => this.requireProduct(repository, productId));
    this.requireReviewable(before, input);
    // Link creation must succeed before the decision commits and its existing controller audit runs.
    const displays = await this.media.resolveImages(before.images.map(image => ({brandId: before.product.brandId, url: image.url})));
    const reviewed = await this.write(async repository => {
      const product = await repository.lockProduct(productId);
      if (!product) throw new NotFoundException(PRODUCT_EDITING.failure.missing);
      const detail = await this.requireProduct(repository, productId);
      this.requireReviewable(detail, input);
      if (input.decision === PRODUCT_STATUS.active) await this.requireMedia(repository, detail.product.brandId, detail.images);
      await repository.updateStatus(productId, input.decision, input.reviewerId, input.rejectionReason ?? undefined);
      return this.requireProduct(repository, productId);
    });
    return this.project([reviewed], displays)[PRODUCT_EDITING.limits.firstIndex];
  }
  async getPublicProduct(productId: string): Promise<PublicProductDto | null> {
    const [detail] = await this.products.findActiveByIds([productId]);
    return detail ? this.toPublicProduct(detail) : null;
  }
  private fields(input: ProductFieldsDto): ProductContentUpdate['fields'] {
    return {name: input.name, description: input.description, category: input.category, genderTarget: input.genderTarget ?? null,
      basePrice: input.basePrice, currency: input.currency, material: input.material ?? null, careInstructions: input.careInstructions ?? null};
  }
  private async mutateProduct(user: ProductActor, productId: string, version: number, operation: (repository: ProductRepository, detail: ProductDetail) => Promise<void>, access = ProductMutationAccess.MemberOnly): Promise<ProductDetailResponse> {
    const changed = await this.write(async repository => {
      const product = await repository.lockProduct(productId);
      if (!product) throw new NotFoundException(PRODUCT_EDITING.failure.missing);
      if ((access !== ProductMutationAccess.Moderation || !this.isAdmin(user)) && !await repository.lockBrandMembership(product.brandId, user.id)) throw new ForbiddenException(PRODUCT_EDITING.failure.access);
      this.requireVersion(product, version);
      await operation(repository, await this.requireProduct(repository, productId));
      return this.requireProduct(repository, productId);
    });
    return (await this.present([changed]))[PRODUCT_EDITING.limits.firstIndex];
  }
  private async requireMedia(repository: ProductRepository, brandId: string, images: Array<{url: string}>): Promise<void> {
    const ids = this.media.assetIDs(images.map(image => image.url));
    if (!await repository.hasReadyProductMedia(brandId, ids)) throw new BadRequestException(PRODUCT_MEDIA.failure.ownership);
  }
  private async present(details: ProductDetail[]): Promise<ProductDetailResponse[]> {
    const sources = details.flatMap(detail => detail.images.map(image => ({brandId: detail.product.brandId, url: image.url})));
    const displays = await this.media.resolveImages(sources);
    return this.project(details, displays);
  }
  private project(details: ProductDetail[], displays: Map<string, string>): ProductDetailResponse[] {
    return details.map(detail => ({...detail, images: detail.images.map(image => {
      const displayUrl = displays.get(image.url);
      if (!displayUrl) throw new ServiceUnavailableException(PRODUCT_MEDIA.failure.unavailable);
      return {...image, displayUrl};
    })}));
  }
  private requireVersion(product: Product, expected: number) {
    if (product.version !== expected) throw new ConflictException(PRODUCT_EDITING.failure.changed);
  }
  private requireReviewable(detail: ProductDetail, input: ReviewProductDto): void {
    this.requireVersion(detail.product, input.expectedVersion);
    if (detail.product.status !== PRODUCT_STATUS.underReview) throw new ConflictException(PRODUCT_EDITING.failure.state);
    if (input.decision === PRODUCT_STATUS.rejected && !input.rejectionReason?.trim()) throw new BadRequestException(PRODUCT_EDITING.failure.reason);
    if (input.decision === PRODUCT_STATUS.active) this.requireComplete(detail);
  }
  private requireComplete(detail: ProductDetail) {
    if (detail.variants.filter(variant => variant.status === PRODUCT_VARIANT_STATUS.active).length < PRODUCT_EDITING.limits.readyVariants ||
        detail.images.length < PRODUCT_EDITING.limits.readyImages || !detail.product.name.trim() || !detail.product.description.trim() ||
        !detail.product.category.trim() || !PRODUCT_CURRENCIES.includes(detail.product.currency)) throw new BadRequestException(PRODUCT_EDITING.failure.incomplete);
  }
  private async write<T>(operation: (repository: ProductRepository) => Promise<T>): Promise<T> {
    try { return await this.products.transaction(operation); }
    catch (error) {
      if (!(error instanceof DrizzleQueryError)) throw error;
      const pg = error.cause as {code?: string; constraint?: string};
      if (pg.code === PRODUCT_EDITING.persistence.uniqueViolation && pg.constraint === PRODUCT_EDITING.persistence.skuConstraint) throw new ConflictException(PRODUCT_EDITING.failure.sku);
      throw error;
    }
  }
  private async requireProduct(repository: ProductRepository, productId: string): Promise<ProductDetail> {
    const detail = await repository.findById(productId);
    if (!detail) throw new NotFoundException(PRODUCT_EDITING.failure.missing);
    return detail;
  }
  toPublicProduct(detail: ProductDetail): PublicProductDto | null {
    if (detail.product.status !== PRODUCT_STATUS.active) {
      return null;
    }

    const activeVariants = detail.variants.filter((variant) => variant.status === PRODUCT_VARIANT_STATUS.active);
    const prices = activeVariants.map((variant) => variant.priceOverride ?? detail.product.basePrice);
    const min = prices.length ? Math.min(...prices) : detail.product.basePrice;
    const max = prices.length ? Math.max(...prices) : detail.product.basePrice;

    return {
      id: detail.product.id,
      brandId: detail.product.brandId,
      name: detail.product.name,
      description: detail.product.description,
      category: detail.product.category,
      price: { min, max, currency: detail.product.currency },
      images: detail.images
        .sort((a, b) => a.position - b.position)
        .map((image) => ({ url: image.url, position: image.position, kind: image.kind })),
      variants: activeVariants.map((variant) => ({
        id: variant.id,
        size: variant.size,
        color: variant.color,
        stockQuantity: variant.stockQuantity,
        price: variant.priceOverride ?? detail.product.basePrice
      }))
    };
  }

}

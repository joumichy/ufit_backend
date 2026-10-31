import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PRODUCT_REPOSITORY, type ProductDetail, type ProductRepository } from '../../products/domain/product.types';
import { OUTFIT_REPOSITORY, type OutfitAuthor, type OutfitDetail, type OutfitItem, type OutfitRepository } from '../domain/outfit.types';
import { CreateOutfitDto, ReviewOutfitDto } from './dto/outfit.dto';

export interface OutfitPriceDto { currency: string; min: number; max: number }

export interface OutfitCardDto {
  id: string;
  title: string;
  coverImageUrl: string;
  prices: OutfitPriceDto[];
  author: OutfitAuthor | null;
  creatorId: string | null;
  brandId: string | null;
  publishedAt: string | null;
}

export interface OutfitDetailDto extends OutfitCardDto {
  description: string;
  creatorId: string | null;
  brandId: string | null;
  images: Array<{ url: string; position: number }>;
  items: Array<{
    id: string;
    itemType: string;
    label: string;
    position: number;
    isRequired: boolean;
    isShoppable: boolean;
    stylingNote: string | null;
    product: null | { id: string; name: string; brandId: string; price: number; currency: string; imageUrl: string | null };
  }>;
}

@Injectable()
export class OutfitsService {
  constructor(
    @Inject(OUTFIT_REPOSITORY) private readonly outfits: OutfitRepository,
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository
  ) {}

  async createOutfit(input: CreateOutfitDto): Promise<OutfitDetail> {
    if (!input.creatorId && !input.brandId) {
      throw new BadRequestException('An outfit requires a creatorId or brandId');
    }
    if (!input.items.length) {
      throw new BadRequestException('An outfit requires at least one item');
    }
    this.assertItemsAreCoherent(input.items);

    const productDetails = await this.products.findActiveByIds(this.uniqueShoppableProductIds(input.items));
    this.assertAllShoppableProductsAreActive(input.items, productDetails);

    const outfit = await this.outfits.createOutfit({
      creatorId: input.creatorId ?? null,
      brandId: input.brandId ?? null,
      title: input.title,
      description: input.description,
      coverImageUrl: input.coverImageUrl,
      genderTarget: input.genderTarget ?? null,
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null
    });

    await this.outfits.addItems(
      outfit.id,
      input.items.map((item) => ({
        productId: item.productId ?? null,
        externalLabel: item.externalLabel ?? null,
        itemType: item.itemType,
        position: item.position,
        isRequired: item.isRequired,
        isShoppable: item.isShoppable,
        stylingNote: item.stylingNote ?? null
      }))
    );

    if (input.images?.length) {
      await this.outfits.addImages(outfit.id, input.images);
    }

    return this.requireOutfit(outfit.id);
  }

  async submitOutfit(outfitId: string): Promise<OutfitDetail> {
    const detail = await this.requireOutfit(outfitId);
    if (detail.outfit.status !== 'draft' && detail.outfit.status !== 'rejected') {
      throw new BadRequestException('Only draft or rejected outfits can be submitted');
    }
    await this.outfits.updateStatus(outfitId, 'under_review', 'private');
    return this.requireOutfit(outfitId);
  }

  async reviewOutfit(outfitId: string, input: ReviewOutfitDto): Promise<OutfitDetail> {
    const detail = await this.requireOutfit(outfitId);
    if (detail.outfit.status !== 'under_review') {
      throw new BadRequestException('Only outfits under review can be reviewed');
    }
    if (input.decision === 'rejected' && !input.rejectionReason) {
      throw new BadRequestException('A rejection reason is required');
    }

    if (input.decision === 'published') {
      await this.assertPublishedOutfitProductsRemainActive(detail.items);
    }

    await this.outfits.updateStatus(
      outfitId,
      input.decision,
      input.decision === 'published' ? 'public' : 'private',
      input.reviewerId,
      input.rejectionReason
    );
    return this.requireOutfit(outfitId);
  }

  async getPublicFeed(input: { limit?: number; cursor?: string }): Promise<{ items: OutfitCardDto[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const rows = await this.outfits.findPublishedPage({ limit: limit + 1, cursor: input.cursor });
    const page = rows.slice(0, limit);
    const productIds = this.uniqueShoppableProductIds(page.flatMap(detail => detail.items));
    const products = await this.products.findActiveByIds(productIds);
    return {
      items: page.map((detail) => this.toOutfitCard(detail, products)),
      nextCursor: rows.length > limit ? (page.at(-1)?.outfit.id ?? null) : null
    };
  }

  async getPublicDetail(outfitId: string): Promise<OutfitDetailDto> {
    const detail = await this.requireOutfit(outfitId);
    if (detail.outfit.status !== 'published') {
      throw new NotFoundException('Public outfit not found');
    }
    return this.toOutfitDetail(detail, await this.products.findActiveByIds(this.uniqueShoppableProductIds(detail.items)));
  }

  toOutfitCard(detail: OutfitDetail, products: ProductDetail[]): OutfitCardDto {
    return {
      id: detail.outfit.id,
      title: detail.outfit.title,
      coverImageUrl: detail.outfit.coverImageUrl,
      prices: this.priceGroups(detail.items, products),
      author: detail.author,
      creatorId: detail.outfit.creatorId,
      brandId: detail.outfit.brandId,
      publishedAt: detail.outfit.publishedAt?.toISOString() ?? null
    };
  }

  toOutfitDetail(detail: OutfitDetail, products: ProductDetail[]): OutfitDetailDto {
    const byId = new Map(products.map((product) => [product.product.id, product]));
    return {
      ...this.toOutfitCard(detail, products),
      description: detail.outfit.description,
      creatorId: detail.outfit.creatorId,
      brandId: detail.outfit.brandId,
      images: detail.images.sort((a, b) => a.position - b.position).map((image) => ({ url: image.url, position: image.position })),
      items: detail.items
        .sort((a, b) => a.position - b.position)
        .map((item) => {
          const product = item.productId ? byId.get(item.productId) : undefined;
          return {
            id: item.id,
            itemType: item.itemType,
            label: product?.product.name ?? item.externalLabel ?? 'Piece',
            position: item.position,
            isRequired: item.isRequired,
            isShoppable: item.isShoppable && Boolean(product),
            stylingNote: item.stylingNote,
            product: product
              ? {
                  id: product.product.id,
                  name: product.product.name,
                  brandId: product.product.brandId,
                  price: this.minProductPrice(product),
                  currency: product.product.currency,
                  imageUrl: product.images.sort((a, b) => a.position - b.position)[0]?.url ?? null
                }
              : null
          };
        })
    };
  }

  private priceGroups(items: OutfitItem[], products: ProductDetail[]): OutfitPriceDto[] {
    const selectedIds = new Set(this.uniqueShoppableProductIds(items));
    const groups = new Map<string, OutfitPriceDto>();
    for (const detail of products) {
      if (!selectedIds.has(detail.product.id)) continue;
      const prices = detail.variants.filter(variant => variant.status === 'active')
        .map(variant => variant.priceOverride ?? detail.product.basePrice);
      const minimum = prices.length ? Math.min(...prices) : detail.product.basePrice;
      const maximum = prices.length ? Math.max(...prices) : detail.product.basePrice;
      const group = groups.get(detail.product.currency);
      if (group) { group.min += minimum; group.max += maximum; }
      else { groups.set(detail.product.currency, { currency: detail.product.currency, min: minimum, max: maximum }); }
    }
    return [...groups.values()].sort((left, right) => left.currency.localeCompare(right.currency));
  }

  private assertItemsAreCoherent(items: Array<{ productId?: string; externalLabel?: string; isShoppable: boolean }>): void {
    for (const item of items) {
      if (item.isShoppable && !item.productId) {
        throw new BadRequestException('Shoppable outfit items require a productId');
      }
      if (!item.isShoppable && !item.productId && !item.externalLabel) {
        throw new BadRequestException('Non-shoppable outfit items require a label or productId');
      }
    }
  }

  private assertAllShoppableProductsAreActive(items: Array<{ productId?: string | null; isShoppable: boolean }>, products: ProductDetail[]): void {
    const activeIds = new Set(products.map((detail) => detail.product.id));
    for (const productId of this.uniqueShoppableProductIds(items)) {
      if (!activeIds.has(productId)) {
        throw new BadRequestException('Only active products can be used as shoppable outfit items');
      }
    }
  }

  private async assertPublishedOutfitProductsRemainActive(items: OutfitItem[]): Promise<void> {
    const products = await this.products.findActiveByIds(this.uniqueShoppableProductIds(items));
    this.assertAllShoppableProductsAreActive(items, products);
  }

  private uniqueShoppableProductIds(items: Array<{ productId?: string | null; isShoppable: boolean }>): string[] {
    return [...new Set(items.filter((item) => item.isShoppable && item.productId).map((item) => item.productId as string))];
  }

  private minProductPrice(product: ProductDetail): number {
    const activeVariantPrices = product.variants
      .filter((variant) => variant.status === 'active')
      .map((variant) => variant.priceOverride ?? product.product.basePrice);
    return activeVariantPrices.length ? Math.min(...activeVariantPrices) : product.product.basePrice;
  }

  private async requireOutfit(outfitId: string): Promise<OutfitDetail> {
    const detail = await this.outfits.findById(outfitId);
    if (!detail) {
      throw new NotFoundException('Outfit not found');
    }
    return detail;
  }
}

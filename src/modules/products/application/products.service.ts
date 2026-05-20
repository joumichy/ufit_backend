import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PRODUCT_REPOSITORY, type ProductDetail, type ProductRepository } from '../domain/product.types';
import { CreateProductDto, ReviewProductDto } from './dto/product.dto';

export interface PublicProductDto {
  id: string;
  brandId: string;
  name: string;
  description: string;
  category: string;
  price: { min: number; max: number; currency: string };
  images: Array<{ url: string; position: number; kind: string }>;
  variants: Array<{ id: string; size: string | null; color: string | null; stockQuantity: number; price: number }>;
}

@Injectable()
export class ProductsService {
  constructor(@Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository) {}

  async createProduct(input: CreateProductDto): Promise<ProductDetail> {
    const product = await this.products.createProduct({
      brandId: input.brandId,
      name: input.name,
      slug: input.slug,
      description: input.description,
      category: input.category,
      genderTarget: input.genderTarget ?? null,
      basePrice: input.basePrice,
      currency: input.currency ?? 'CHF',
      material: input.material ?? null,
      careInstructions: input.careInstructions ?? null,
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null
    });

    if (input.variants?.length) {
      await this.products.addVariants(
        product.id,
        input.variants.map((variant) => ({
          size: variant.size ?? null,
          color: variant.color ?? null,
          sku: variant.sku,
          stockQuantity: variant.stockQuantity,
          priceOverride: variant.priceOverride ?? null
        }))
      );
    }

    if (input.images?.length) {
      await this.products.addImages(product.id, input.images);
    }

    const detail = await this.products.findById(product.id);
    if (!detail) {
      throw new NotFoundException('Product was not found after creation');
    }
    return detail;
  }

  async submitProduct(productId: string): Promise<ProductDetail> {
    const detail = await this.requireProduct(productId);
    if (detail.product.status !== 'draft' && detail.product.status !== 'rejected') {
      throw new BadRequestException('Only draft or rejected products can be submitted for review');
    }

    await this.products.updateStatus(productId, 'under_review');
    return this.requireProduct(productId);
  }

  async reviewProduct(productId: string, input: ReviewProductDto): Promise<ProductDetail> {
    const detail = await this.requireProduct(productId);
    if (detail.product.status !== 'under_review') {
      throw new BadRequestException('Only products under review can be reviewed');
    }
    if (input.decision === 'rejected' && !input.rejectionReason) {
      throw new BadRequestException('A rejection reason is required');
    }

    await this.products.updateStatus(productId, input.decision, input.reviewerId, input.rejectionReason);
    return this.requireProduct(productId);
  }

  toPublicProduct(detail: ProductDetail): PublicProductDto | null {
    if (detail.product.status !== 'active') {
      return null;
    }

    const activeVariants = detail.variants.filter((variant) => variant.status === 'active');
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

  private async requireProduct(productId: string): Promise<ProductDetail> {
    const detail = await this.products.findById(productId);
    if (!detail) {
      throw new NotFoundException('Product not found');
    }
    return detail;
  }
}

import { Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import { productImages, products, productVariants } from '../../../shared/infrastructure/database/schema';
import type { Product, ProductDetail, ProductImage, ProductRepository, ProductStatus, ProductVariant } from '../domain/product.types';

@Injectable()
export class DrizzleProductRepository implements ProductRepository {
  constructor(private readonly database: DatabaseService) {}

  async createProduct(input: Parameters<ProductRepository['createProduct']>[0]): Promise<Product> {
    const [row] = await this.database.db
      .insert(products)
      .values({ ...input, status: input.status ?? 'draft' })
      .returning();
    return row;
  }

  async addVariants(productId: string, variants: Parameters<ProductRepository['addVariants']>[1]): Promise<ProductVariant[]> {
    if (!variants.length) {
      return [];
    }
    return this.database.db
      .insert(productVariants)
      .values(variants.map((variant) => ({ ...variant, productId, status: variant.status ?? 'active' })))
      .returning();
  }

  async addImages(productId: string, images: Parameters<ProductRepository['addImages']>[1]): Promise<ProductImage[]> {
    if (!images.length) {
      return [];
    }
    return this.database.db.insert(productImages).values(images.map((image) => ({ ...image, productId }))).returning();
  }

  async findById(productId: string): Promise<ProductDetail | null> {
    const [product] = await this.database.db.select().from(products).where(eq(products.id, productId)).limit(1);
    if (!product) {
      return null;
    }

    const [variants, images] = await Promise.all([
      this.database.db.select().from(productVariants).where(eq(productVariants.productId, productId)),
      this.database.db.select().from(productImages).where(eq(productImages.productId, productId))
    ]);

    return { product, variants, images };
  }

  async findActiveByIds(productIds: string[]): Promise<ProductDetail[]> {
    if (!productIds.length) {
      return [];
    }
    const rows = await this.database.db
      .select()
      .from(products)
      .where(inArray(products.id, productIds));
    const activeRows = rows.filter((product) => product.status === 'active');
    const [variants, images] = await Promise.all([
      this.database.db.select().from(productVariants).where(inArray(productVariants.productId, activeRows.map((product) => product.id))),
      this.database.db.select().from(productImages).where(inArray(productImages.productId, activeRows.map((product) => product.id)))
    ]);

    return activeRows.map((product) => ({
      product,
      variants: variants.filter((variant) => variant.productId === product.id),
      images: images.filter((image) => image.productId === product.id)
    }));
  }

  async updateStatus(productId: string, status: ProductStatus, reviewerId?: string, rejectionReason?: string): Promise<Product> {
    const [row] = await this.database.db
      .update(products)
      .set({
        status,
        reviewedBy: reviewerId,
        reviewedAt: status === 'active' || status === 'rejected' ? new Date() : null,
        rejectionReason: status === 'rejected' ? rejectionReason : null,
        updatedAt: new Date()
      })
      .where(eq(products.id, productId))
      .returning();
    return row;
  }
}

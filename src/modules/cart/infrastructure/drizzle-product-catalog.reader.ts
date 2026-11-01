import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import { brandProfiles, products, productVariants } from '../../../shared/infrastructure/database/schema';
import type { ProductCatalogReader, ProductVariantQuote } from '../application/cart.service';

@Injectable()
export class DrizzleProductCatalogReader implements ProductCatalogReader {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async getVariantQuote(productVariantId: string): Promise<ProductVariantQuote> {
    const [row] = await this.database.db
      .select({
        productId: products.id,
        productStatus: products.status,
        brandId: products.brandId,
        brandStatus: brandProfiles.status,
        basePrice: products.basePrice,
        currency: products.currency,
        productVariantId: productVariants.id,
        variantStatus: productVariants.status,
        stockQuantity: productVariants.stockQuantity,
        priceOverride: productVariants.priceOverride
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .innerJoin(brandProfiles, eq(products.brandId, brandProfiles.id))
      .where(eq(productVariants.id, productVariantId))
      .limit(1);

    if (!row || row.brandStatus !== 'active' || row.productStatus !== 'active' || row.variantStatus !== 'active' || row.stockQuantity <= 0) {
      throw new NotFoundException('Product variant is not available');
    }

    return {
      productId: row.productId,
      productVariantId: row.productVariantId,
      brandId: row.brandId,
      unitPrice: row.priceOverride ?? row.basePrice,
      currency: row.currency,
      stockQuantity: row.stockQuantity
    };
  }
}

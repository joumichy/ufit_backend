import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DrizzleProductCatalogReader } from '../../src/modules/cart/infrastructure/drizzle-product-catalog.reader';
import type { DatabaseService } from '../../src/shared/infrastructure/database/database.service';

interface CatalogRow {
  productId: string;
  productStatus: string;
  brandId: string;
  brandStatus: string;
  basePrice: number;
  currency: string;
  productVariantId: string;
  variantStatus: string;
  stockQuantity: number;
  priceOverride: number | null;
}

function activeCatalogRow(overrides: Partial<CatalogRow> = {}): CatalogRow {
  return {
    productId: 'product-1',
    productStatus: 'active',
    brandId: 'brand-1',
    brandStatus: 'active',
    basePrice: 12000,
    currency: 'CHF',
    productVariantId: 'variant-1',
    variantStatus: 'active',
    stockQuantity: 4,
    priceOverride: 9900,
    ...overrides
  };
}

function readerWithRows(rows: CatalogRow[]) {
  const query = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows)
  };
  const database = {
    db: {
      select: vi.fn(() => query)
    }
  } as unknown as DatabaseService;

  return new DrizzleProductCatalogReader(database);
}

describe('DrizzleProductCatalogReader', () => {
  it('quotes active variants with the server-side price override', async () => {
    const reader = readerWithRows([activeCatalogRow()]);

    await expect(reader.getVariantQuote('variant-1')).resolves.toMatchObject({
      productId: 'product-1',
      productVariantId: 'variant-1',
      brandId: 'brand-1',
      unitPrice: 9900,
      currency: 'CHF',
      stockQuantity: 4
    });
  });

  it('falls back to the product base price when the variant has no override', async () => {
    const reader = readerWithRows([activeCatalogRow({ priceOverride: null })]);

    await expect(reader.getVariantQuote('variant-1')).resolves.toMatchObject({
      unitPrice: 12000
    });
  });

  it.each([
    ['missing variant', []],
    ['suspended brand', [activeCatalogRow({ brandStatus: 'suspended' })]],
    ['inactive product', [activeCatalogRow({ productStatus: 'draft' })]],
    ['archived variant', [activeCatalogRow({ variantStatus: 'archived' })]],
    ['out-of-stock variant status', [activeCatalogRow({ variantStatus: 'out_of_stock' })]],
    ['empty stock', [activeCatalogRow({ stockQuantity: 0 })]]
  ])('refuses %s', async (_caseName, rows) => {
    const reader = readerWithRows(rows);

    await expect(reader.getVariantQuote('variant-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

import type { ProductStatus } from '../../products/domain/product.types';

export const BRAND_OUTFIT_INTEGRATIONS = {
  route: 'brand-integrations',
  failure: {
    page: 'Invalid brand outfit integration page',
    changed: 'Brand outfit integrations changed; reload',
  },
} as const;

export interface BrandOutfitIntegrationPiece {
  itemId: string;
  productId: string;
  name: string;
  productStatus: ProductStatus;
}

export interface BrandOutfitIntegrationReference extends BrandOutfitIntegrationPiece {
  outfitId: string;
}

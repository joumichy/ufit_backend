import type { PRODUCT_STATUSES, PRODUCT_VARIANT_STATUSES, PRODUCT_IMAGE_KINDS } from './product-contract';
import type { PROFILE_STATUSES } from '../../../shared/domain/profile-editing.contract';
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export type ProductVariantStatus = (typeof PRODUCT_VARIANT_STATUSES)[number];
import type { GenderTarget } from '../../../shared/domain/gender-target';
export type { GenderTarget } from '../../../shared/domain/gender-target';

export interface Product {
  id: string;
  brandId: string;
  version: number;
  name: string;
  slug: string;
  description: string;
  category: string;
  genderTarget: GenderTarget | null;
  status: ProductStatus;
  basePrice: number;
  currency: string;
  material: string | null;
  careInstructions: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductVariant {
  id: string;
  productId: string;
  size: string | null;
  color: string | null;
  sku: string;
  stockQuantity: number;
  priceOverride: number | null;
  status: ProductVariantStatus;
}

export interface ProductImage {
  id: string;
  productId: string;
  url: string;
  position: number;
  kind: (typeof PRODUCT_IMAGE_KINDS)[number];
}

export interface ProductDetail {
  product: Product;
  brand: {id: string; brandName: string; status: (typeof PROFILE_STATUSES)[number]};
  variants: ProductVariant[];
  images: ProductImage[];
}

export interface ProductListQuery {brandId?: string; status?: ProductStatus; cursor?: string; limit: number;}
export interface ProductSelectionQuery {brandId?: string; cursor?: string; search?: string; limit: number;}
export interface ProductListPage {items: ProductDetail[]; nextCursor: string | null;}
export interface ProductDetailResponse extends Omit<ProductDetail, 'images'> { images: Array<ProductImage & {displayUrl: string}>; }
export interface ProductListResponse {items: ProductDetailResponse[]; nextCursor: string | null;}
export interface ProductRepository {
  transaction<T>(operation: (repository: ProductRepository) => Promise<T>): Promise<T>;
  readSnapshot<T>(operation: (repository: ProductRepository) => Promise<T>): Promise<T>;
  hasBrandMembership(brandId: string, userId: string): Promise<boolean>;
  lockBrandMembership(brandId: string, userId: string): Promise<boolean>;
  hasReadyProductMedia(brandId: string, ids: string[]): Promise<boolean>;
  lockProduct(productId: string): Promise<Product | undefined>;
  findByCreationRequest(brandId: string, requestId: string): Promise<{detail: ProductDetail; fingerprint: string | null} | null>;
  list(query: ProductListQuery): Promise<ProductListPage>;
  replaceProduct(productId: string, input: ProductContentUpdate): Promise<void>;
  setVariantStock(productId: string, variantId: string, expectedQuantity: number, quantity: number): Promise<boolean>;
  bumpVersion(productId: string): Promise<void>;
  createProduct(input: Omit<Product, 'id' | 'version' | 'status' | 'createdAt' | 'updatedAt'> & { status?: ProductStatus; creationRequestId: string; creationFingerprint: string }): Promise<Product>;
  addVariants(productId: string, variants: Array<Omit<ProductVariant, 'id' | 'productId' | 'status'> & { status?: ProductVariantStatus }>): Promise<ProductVariant[]>;
  addImages(productId: string, images: Array<Omit<ProductImage, 'id' | 'productId'>>): Promise<ProductImage[]>;
  findById(productId: string): Promise<ProductDetail | null>;
  findSelectablePage(query: ProductSelectionQuery): Promise<ProductListPage>;
  findActiveByIds(productIds: string[]): Promise<ProductDetail[]>;
  updateStatus(productId: string, status: ProductStatus, reviewerId?: string, rejectionReason?: string): Promise<Product>;
}

export const PRODUCT_REPOSITORY = Symbol('PRODUCT_REPOSITORY');

export interface ProductContentUpdate {
  fields: Pick<Product, 'name' | 'description' | 'category' | 'genderTarget' | 'basePrice' | 'currency' | 'material' | 'careInstructions'>;
  variants: Array<Omit<ProductVariant, 'id' | 'productId'> & {id?: string; expectedStockQuantity?: number}>;
  images: Array<Omit<ProductImage, 'id' | 'productId'> & {id?: string}>;
}

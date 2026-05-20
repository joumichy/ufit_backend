export type ProductStatus = 'draft' | 'under_review' | 'active' | 'rejected' | 'archived';
export type ProductVariantStatus = 'active' | 'out_of_stock' | 'archived';
export type GenderTarget = 'male' | 'female' | 'unisex';

export interface Product {
  id: string;
  brandId: string;
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
  reviewedBy?: string | null;
  reviewedAt?: Date | null;
  rejectionReason?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
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
  kind: 'product' | 'worn' | 'detail' | 'lookbook';
}

export interface ProductDetail {
  product: Product;
  variants: ProductVariant[];
  images: ProductImage[];
}

export interface ProductRepository {
  createProduct(input: Omit<Product, 'id' | 'status' | 'createdAt' | 'updatedAt'> & { status?: ProductStatus }): Promise<Product>;
  addVariants(productId: string, variants: Array<Omit<ProductVariant, 'id' | 'productId' | 'status'> & { status?: ProductVariantStatus }>): Promise<ProductVariant[]>;
  addImages(productId: string, images: Array<Omit<ProductImage, 'id' | 'productId'>>): Promise<ProductImage[]>;
  findById(productId: string): Promise<ProductDetail | null>;
  findActiveByIds(productIds: string[]): Promise<ProductDetail[]>;
  updateStatus(productId: string, status: ProductStatus, reviewerId?: string, rejectionReason?: string): Promise<Product>;
}

export const PRODUCT_REPOSITORY = Symbol('PRODUCT_REPOSITORY');

import type { ProductMediaStatus } from './product-media.contract';

export interface ProductMediaAsset {
  id: string; brandId: string; uploadedBy: string; requestId: string; fingerprint: string;
  byteSize: number; contentType: string; objectPath: string; status: ProductMediaStatus;
  createdAt: Date; updatedAt: Date;
}
export interface ProductMediaRepository {
  reserve(input: Omit<ProductMediaAsset, 'status' | 'createdAt' | 'updatedAt'>): Promise<ProductMediaAsset>;
  markReady(asset: ProductMediaAsset, userId: string): Promise<ProductMediaAsset>;
  findByIds(ids: string[]): Promise<ProductMediaAsset[]>;
  findOwnedReady(id: string, userId: string): Promise<ProductMediaAsset | null>;
  findPublic(id: string, canonicalUrl: string): Promise<ProductMediaAsset | null>;
}
export interface ProductMediaStorage {
  uploadOrVerify(path: string, bytes: Buffer, fingerprint: string): Promise<void>;
  sign(paths: string[]): Promise<Map<string, string>>;
}
export interface ProductMediaReader {
  assetIDs(urls: string[]): string[];
  resolveImages(sources: Array<{brandId: string; url: string}>): Promise<Map<string, string>>;
}
export interface UploadedProductImage {id: string; brandId: string; url: string; displayUrl: string}

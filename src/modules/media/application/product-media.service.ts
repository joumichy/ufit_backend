import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PRODUCT_MEDIA } from '../domain/product-media.contract';
import { ProductMediaLocator } from './product-media-locator';
import type { ProductMediaAsset, ProductMediaReader, ProductMediaRepository, ProductMediaStorage, UploadedProductImage } from '../domain/product-media.types';

export interface ProductImageFile {buffer: Buffer; mimetype: string; size: number}
@Injectable()
export class ProductMediaService implements ProductMediaReader {
  constructor(
    @Inject(PRODUCT_MEDIA.repository) private readonly repository: ProductMediaRepository,
    @Inject(PRODUCT_MEDIA.storage) private readonly storage: ProductMediaStorage,
    @Inject(PRODUCT_MEDIA.locator) private readonly locator: ProductMediaLocator,
  ) {}
  assetIDs(urls: string[]): string[] {
    try { return [...new Set(urls.flatMap(url => { const id = this.locator.id(url); return id ? [id] : []; }))]; }
    catch (error) { if (error instanceof ServiceUnavailableException) throw error; throw new BadRequestException(PRODUCT_MEDIA.failure.ownership); }
  }
  async upload(userId: string, input: {brandId: string; requestId: string}, file?: ProductImageFile): Promise<UploadedProductImage> {
    this.validateFile(file);
    const id = randomUUID();
    const fingerprint = createHash(PRODUCT_MEDIA.hash.algorithm).update(file.buffer).digest(PRODUCT_MEDIA.hash.encoding);
    const asset = await this.repository.reserve({id, brandId: input.brandId, uploadedBy: userId, requestId: input.requestId, fingerprint,
      byteSize: file.buffer.length, contentType: PRODUCT_MEDIA.mime, objectPath: input.brandId + PRODUCT_MEDIA.storageSettings.separator + id + PRODUCT_MEDIA.extension});
    if (asset.status !== PRODUCT_MEDIA.status.ready) await this.storage.uploadOrVerify(asset.objectPath, file.buffer, asset.fingerprint);
    // Membership can change during the external upload; it must still authorize the returned asset.
    const ready = await this.repository.markReady(asset, userId);
    return this.presentAsset(ready);
  }
  async resolveImages(sources: Array<{brandId: string; url: string}>): Promise<Map<string, string>> {
    const ids = this.assetIDs(sources.map(source => source.url));
    const assets = await this.repository.findByIds(ids);
    const byId = new Map(assets.map(asset => [asset.id, asset]));
    const internal = sources.flatMap(source => {
      const id = this.locator.id(source.url);
      if (!id) return [];
      const asset = byId.get(id);
      if (!asset || asset.status !== PRODUCT_MEDIA.status.ready || asset.brandId !== source.brandId) throw new BadRequestException(PRODUCT_MEDIA.failure.ownership);
      return [asset];
    });
    const signed = await this.storage.sign(internal.map(asset => asset.objectPath));
    return new Map(sources.map(source => {
      const id = this.locator.id(source.url);
      if (!id) return [source.url, source.url];
      const asset = byId.get(id)!;
      const displayUrl = signed.get(asset.objectPath);
      if (!displayUrl) throw new ServiceUnavailableException(PRODUCT_MEDIA.failure.unavailable);
      return [source.url, displayUrl];
    }));
  }
  async publicImage(id: string): Promise<string> {
    const asset = await this.repository.findPublic(id, this.locator.url(id));
    if (!asset) throw new NotFoundException(PRODUCT_MEDIA.failure.missing);
    return (await this.presentAsset(asset)).displayUrl;
  }
  private async presentAsset(asset: ProductMediaAsset): Promise<UploadedProductImage> {
    const signed = await this.storage.sign([asset.objectPath]);
    const displayUrl = signed.get(asset.objectPath);
    if (!displayUrl) throw new ServiceUnavailableException(PRODUCT_MEDIA.failure.unavailable);
    return {id: asset.id, brandId: asset.brandId, url: this.locator.url(asset.id), displayUrl};
  }
  private validateFile(file?: ProductImageFile): asserts file is ProductImageFile {
    const image = PRODUCT_MEDIA.image;
    if (!file || file.mimetype !== PRODUCT_MEDIA.mime || file.size !== file.buffer.length || file.buffer.length < image.minimumBytes || file.buffer.length > PRODUCT_MEDIA.maxBytes ||
      !file.buffer.subarray(image.firstIndex, image.prefix.length).equals(Buffer.from(image.prefix)) ||
      !file.buffer.subarray(-image.suffix.length).equals(Buffer.from(image.suffix))) throw new BadRequestException(PRODUCT_MEDIA.failure.file);
  }
}

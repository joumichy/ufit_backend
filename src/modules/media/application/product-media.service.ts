import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PRODUCT_MEDIA } from '../domain/product-media.contract';
import { MediaAssetLocator } from './media-asset-locator';
import {prepareImageUpload} from './prepare-image-upload';
import type {ImageStorage, ImageUploadFile} from '../domain/image-upload.contract';
import type { ProductMediaAsset, ProductMediaReader, ProductMediaRepository, UploadedProductImage } from '../domain/product-media.types';

@Injectable()
export class ProductMediaService implements ProductMediaReader {
  constructor(
    @Inject(PRODUCT_MEDIA.repository) private readonly repository: ProductMediaRepository,
    @Inject(PRODUCT_MEDIA.storage) private readonly storage: ImageStorage,
    @Inject(PRODUCT_MEDIA.locator) private readonly locator: MediaAssetLocator,
  ) {}
  assetIDs(urls: string[]): string[] {
    try { return [...new Set(urls.flatMap(url => { const id = this.locator.id(url); return id ? [id] : []; }))]; }
    catch (error) { if (error instanceof ServiceUnavailableException) throw error; throw new BadRequestException(PRODUCT_MEDIA.failure.ownership); }
  }
  async upload(userId: string, input: {brandId: string; requestId: string}, file?: ImageUploadFile): Promise<UploadedProductImage> {
    const image = prepareImageUpload(file, PRODUCT_MEDIA.failure.file);
    const id = randomUUID();
    const fingerprint = image.fingerprint;
    const asset = await this.repository.reserve({id, brandId: input.brandId, uploadedBy: userId, requestId: input.requestId, fingerprint,
      byteSize: image.bytes.length, contentType: PRODUCT_MEDIA.mime, objectPath: input.brandId + PRODUCT_MEDIA.storageSettings.separator + id + PRODUCT_MEDIA.extension});
    if (asset.status !== PRODUCT_MEDIA.status.ready) await this.storage.uploadOrVerify(asset.objectPath, image.bytes, asset.fingerprint);
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
  async privateImage(userId: string, id: string): Promise<UploadedProductImage> {
    const asset = await this.repository.findOwnedReady(id, userId);
    if (!asset) throw new NotFoundException(PRODUCT_MEDIA.failure.missing);
    return this.presentAsset(asset);
  }
  private async presentAsset(asset: ProductMediaAsset): Promise<UploadedProductImage> {
    const signed = await this.storage.sign([asset.objectPath]);
    const displayUrl = signed.get(asset.objectPath);
    if (!displayUrl) throw new ServiceUnavailableException(PRODUCT_MEDIA.failure.unavailable);
    return {id: asset.id, brandId: asset.brandId, url: this.locator.url(asset.id), displayUrl};
  }
}

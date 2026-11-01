import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { MediaAssetLocator } from '../../src/modules/media/application/media-asset-locator';
import { PRODUCT_MEDIA } from '../../src/modules/media/domain/product-media.contract';
import type { ProductMediaReader } from '../../src/modules/media/domain/product-media.types';

export const mediaReaderFixture = {origin: 'https://media.test', signedOrigin: 'https://signed.media.test/'} as const;
export class MemoryProductMediaReader implements ProductMediaReader {
  readonly locator = new MediaAssetLocator(() => mediaReaderFixture.origin, PRODUCT_MEDIA);
  readonly assets = new Map<string, {brandId: string; displayUrl: string}>();
  failReads = false;
  assetIDs(urls: string[]): string[] { return [...new Set(urls.flatMap(url => { const id = this.locator.id(url); return id ? [id] : []; }))]; }
  async resolveImages(sources: Array<{brandId: string; url: string}>): Promise<Map<string, string>> {
    if (this.failReads) throw new ServiceUnavailableException(PRODUCT_MEDIA.failure.unavailable);
    return new Map(sources.map(source => {
      const id = this.locator.id(source.url);
      if (!id) return [source.url, source.url];
      const asset = this.assets.get(id);
      if (!asset || asset.brandId !== source.brandId) throw new BadRequestException(PRODUCT_MEDIA.failure.ownership);
      return [source.url, asset.displayUrl];
    }));
  }
}

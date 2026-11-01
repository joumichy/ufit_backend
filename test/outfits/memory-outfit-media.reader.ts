import {BadRequestException, ServiceUnavailableException} from '@nestjs/common';
import {MediaAssetLocator} from '../../src/modules/media/application/media-asset-locator';
import {OUTFIT_MEDIA} from '../../src/modules/media/domain/outfit-media.contract';
import type {OutfitMediaReader, OutfitMediaSource} from '../../src/modules/media/domain/outfit-media.types';
import type {ProfileOwner} from '../../src/shared/domain/profile-editing.contract';
export interface OutfitMediaFixtureAsset {owner: ProfileOwner; displayUrl: string; status: (typeof OUTFIT_MEDIA.statuses)[number];}
const fixture = {origin: 'https://media.test'} as const;
export class MemoryOutfitMediaReader implements OutfitMediaReader {
  readonly locator = new MediaAssetLocator(() => fixture.origin, OUTFIT_MEDIA);
  readonly assets = new Map<string, OutfitMediaFixtureAsset>();
  failReads = false;
  assetIDs(urls: string[]) { return [...new Set(urls.flatMap(url => {const id = this.locator.id(url); return id ? [id] : [];}))]; }
  async resolveImages(sources: OutfitMediaSource[]): Promise<Map<string, string>> {
    if (this.failReads) throw new ServiceUnavailableException(OUTFIT_MEDIA.failure.unavailable);
    return new Map(sources.map(source => {
      const id = this.locator.id(source.url);
      if (!id) return [source.url, source.url];
      const asset = this.assets.get(id);
      if (!asset || asset.status !== OUTFIT_MEDIA.status.ready || !source.owner || asset.owner.creatorId !== source.owner.creatorId || asset.owner.brandId !== source.owner.brandId) throw new BadRequestException(OUTFIT_MEDIA.failure.ownership);
      return [source.url, asset.displayUrl];
    }));
  }
}

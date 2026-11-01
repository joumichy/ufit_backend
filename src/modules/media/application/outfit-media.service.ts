import {randomUUID} from 'node:crypto';
import {BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException} from '@nestjs/common';
import {canAuthorProfile, PROFILE_KIND, type ProfileOwner} from '../../../shared/domain/profile-editing.contract';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {OUTFIT_MEDIA} from '../domain/outfit-media.contract';
import type {OutfitMediaAsset, OutfitMediaReader, OutfitMediaRepository, OutfitMediaSource, UploadedOutfitImage} from '../domain/outfit-media.types';
import type {ImageStorage, ImageUploadFile} from '../domain/image-upload.contract';
import {MediaAssetLocator} from './media-asset-locator';
import {prepareImageUpload} from './prepare-image-upload';

type MediaActor = Pick<AuthenticatedUser, 'id' | 'roles'>;
@Injectable()
export class OutfitMediaService implements OutfitMediaReader {
  constructor(@Inject(OUTFIT_MEDIA.repository) private readonly repository: OutfitMediaRepository,
    @Inject(OUTFIT_MEDIA.storage) private readonly storage: ImageStorage,
    @Inject(OUTFIT_MEDIA.locator) private readonly locator: MediaAssetLocator) {}
  assetIDs(urls: string[]): string[] {
    try { return [...new Set(urls.flatMap(url => {const id = this.locator.id(url); return id ? [id] : [];}))]; }
    catch (error) {if (error instanceof ServiceUnavailableException) throw error; throw new BadRequestException(OUTFIT_MEDIA.failure.ownership);}
  }
  async upload(user: MediaActor, input: {creatorId?: string; brandId?: string; requestId: string}, file?: ImageUploadFile): Promise<UploadedOutfitImage> {
    const creatorId = input.creatorId?.toLowerCase() ?? null, brandId = input.brandId?.toLowerCase() ?? null;
    let owner: ProfileOwner;
    if (creatorId !== null && brandId === null) owner = {creatorId, brandId};
    else if (brandId !== null && creatorId === null) owner = {creatorId, brandId};
    else throw new BadRequestException(OUTFIT_MEDIA.failure.owner);
    if (!canAuthorProfile(user.roles, owner)) throw new ForbiddenException(OUTFIT_MEDIA.failure.access);
    const image = prepareImageUpload(file, OUTFIT_MEDIA.failure.file), id = randomUUID();
    const kind = owner.creatorId !== null ? PROFILE_KIND.creator : PROFILE_KIND.brand, ownerID = owner.creatorId !== null ? owner.creatorId : owner.brandId;
    const asset = await this.repository.reserve({...owner, id, uploadedBy: user.id, requestId: input.requestId, fingerprint: image.fingerprint,
      byteSize: image.bytes.length, contentType: OUTFIT_MEDIA.mime,
      objectPath: kind + OUTFIT_MEDIA.storageSettings.separator + ownerID + OUTFIT_MEDIA.storageSettings.separator + id + OUTFIT_MEDIA.extension});
    if (asset.status !== OUTFIT_MEDIA.status.ready) await this.storage.uploadOrVerify(asset.objectPath, image.bytes, asset.fingerprint);
    const ready = await this.repository.markReady(asset, user.id);
    return this.presentAsset(ready);
  }
  async resolveImages(sources: OutfitMediaSource[]): Promise<Map<string, string>> {
    const assets = await this.repository.findByIds(this.assetIDs(sources.map(source => source.url))), byID = new Map(assets.map(asset => [asset.id, asset]));
    const internal = sources.flatMap(source => {
      const id = this.locator.id(source.url);
      if (!id) return [];
      const asset = byID.get(id);
      if (!asset || asset.status !== OUTFIT_MEDIA.status.ready || !source.owner || asset.creatorId !== source.owner.creatorId || asset.brandId !== source.owner.brandId) throw new BadRequestException(OUTFIT_MEDIA.failure.ownership);
      return [asset];
    });
    const signed = await this.storage.sign(internal.map(asset => asset.objectPath));
    return new Map(sources.map(source => {
      const id = this.locator.id(source.url);
      if (!id) return [source.url, source.url];
      const asset = byID.get(id)!, displayUrl = signed.get(asset.objectPath);
      if (!displayUrl) throw new ServiceUnavailableException(OUTFIT_MEDIA.failure.unavailable);
      return [source.url, displayUrl];
    }));
  }
  async publicImage(id: string): Promise<string> {
    const asset = await this.repository.findPublic(id, this.locator.url(id));
    if (!asset) throw new NotFoundException(OUTFIT_MEDIA.failure.missing);
    return (await this.presentAsset(asset)).displayUrl;
  }
  async privateImage(user: MediaActor, id: string): Promise<UploadedOutfitImage> {
    const asset = await this.repository.findOwnedReady(id, user.id);
    if (!asset || !canAuthorProfile(user.roles, asset)) throw new NotFoundException(OUTFIT_MEDIA.failure.missing);
    return this.presentAsset(asset);
  }
  private async presentAsset(asset: OutfitMediaAsset): Promise<UploadedOutfitImage> {
    const signed = await this.storage.sign([asset.objectPath]), displayUrl = signed.get(asset.objectPath);
    if (!displayUrl) throw new ServiceUnavailableException(OUTFIT_MEDIA.failure.unavailable);
    const owner: ProfileOwner = asset.creatorId !== null ? {creatorId: asset.creatorId, brandId: null} : {creatorId: null, brandId: asset.brandId};
    return {...owner, id: asset.id, url: this.locator.url(asset.id), displayUrl};
  }
}

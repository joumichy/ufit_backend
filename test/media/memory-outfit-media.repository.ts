import {ConflictException, ForbiddenException} from '@nestjs/common';
import {PROFILE_EDITING, PROFILE_STATUS, type ProfileOwner, type ProfileOwnerInfo} from '../../src/shared/domain/profile-editing.contract';
import {OUTFIT_MEDIA} from '../../src/modules/media/domain/outfit-media.contract';
import type {OutfitMediaAsset, OutfitMediaRepository, OutfitMediaReservation} from '../../src/modules/media/domain/outfit-media.types';
const fixture = {timestamp: new Date('2026-11-01T00:00:00.000Z')} as const;
export class MemoryOutfitMediaRepository implements OutfitMediaRepository {
  readonly assets = new Map<string, OutfitMediaAsset>();
  readonly owners = new Map<string, {status: ProfileOwnerInfo['status']; members: Set<string>}>();
  readonly publicURLs = new Map<string, string>();
  ownerKey(owner: ProfileOwner) { return JSON.stringify({creatorId: owner.creatorId, brandId: owner.brandId}); }
  allow(owner: ProfileOwner, userId: string) { this.owners.set(this.ownerKey(owner), {status: PROFILE_STATUS.active, members: new Set([userId])}); }
  private mayWrite(owner: ProfileOwner, userId: string) {
    const profile = this.owners.get(this.ownerKey(owner));
    return profile !== undefined && profile.members.has(userId) && PROFILE_EDITING.writableStatuses.some(status => status === profile.status);
  }
  async reserve(input: OutfitMediaReservation): Promise<OutfitMediaAsset> {
    if (!this.mayWrite(input, input.uploadedBy)) throw new ForbiddenException(OUTFIT_MEDIA.failure.access);
    const previous = [...this.assets.values()].find(asset => this.ownerKey(asset) === this.ownerKey(input) && asset.requestId === input.requestId);
    if (previous) {
      if (previous.fingerprint !== input.fingerprint || previous.byteSize !== input.byteSize || previous.contentType !== input.contentType) throw new ConflictException(OUTFIT_MEDIA.failure.request);
      return previous;
    }
    const asset: OutfitMediaAsset = {...input, status: OUTFIT_MEDIA.status.pending, createdAt: fixture.timestamp, updatedAt: fixture.timestamp};
    this.assets.set(asset.id, asset); return asset;
  }
  async markReady(asset: OutfitMediaAsset, userId: string) {
    if (!this.mayWrite(asset, userId)) throw new ForbiddenException(OUTFIT_MEDIA.failure.access);
    const ready = {...asset, status: OUTFIT_MEDIA.status.ready}; this.assets.set(asset.id, ready); return ready;
  }
  async findByIds(ids: string[]) { return [...this.assets.values()].filter(asset => ids.includes(asset.id)); }
  async findOwnedReady(id: string, userId: string) {
    const asset = this.assets.get(id); return asset && asset.status === OUTFIT_MEDIA.status.ready && this.mayWrite(asset, userId) ? asset : null;
  }
  async findPublic(id: string, url: string) {
    const asset = this.assets.get(id);
    return asset && asset.status === OUTFIT_MEDIA.status.ready && this.publicURLs.get(id) === url && this.owners.get(this.ownerKey(asset))?.status === PROFILE_STATUS.active ? asset : null;
  }
}

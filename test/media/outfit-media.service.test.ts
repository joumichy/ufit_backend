import {randomUUID} from 'node:crypto';
import {BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException} from '@nestjs/common';
import {describe, expect, it} from 'vitest';
import {PROFILE_AUTHOR_ROLES, PROFILE_STATUS} from '../../src/shared/domain/profile-editing.contract';
import type {AuthenticatedUser} from '../../src/modules/identity/domain/user.types';
import {OutfitMediaService} from '../../src/modules/media/application/outfit-media.service';
import {MediaAssetLocator} from '../../src/modules/media/application/media-asset-locator';
import {IMAGE_UPLOAD} from '../../src/modules/media/domain/image-upload.contract';
import {OUTFIT_MEDIA} from '../../src/modules/media/domain/outfit-media.contract';
import {PRODUCT_MEDIA} from '../../src/modules/media/domain/product-media.contract';
import {MemoryImageStorage} from './memory-image.storage';
import {MemoryOutfitMediaRepository} from './memory-outfit-media.repository';
const fixture = {origin: 'https://media.test', external: 'https://cdn.test/outfit.jpg', payload: 'outfit image', changed: 'different image',
  first: 0, zero: 0, one: 1, two: 2, png: 'image/png', customer: 'customer'} as const;
function setup() {
  const user = {id: randomUUID(), roles: [PROFILE_AUTHOR_ROLES.creator, PROFILE_AUTHOR_ROLES.brandOwner]} satisfies Pick<AuthenticatedUser, 'id' | 'roles'>;
  const owner = {creatorId: randomUUID(), brandId: null} as const, brand = {creatorId: null, brandId: randomUUID()} as const;
  const repository = new MemoryOutfitMediaRepository(), storage = new MemoryImageStorage(OUTFIT_MEDIA.failure.unavailable), locator = new MediaAssetLocator(() => fixture.origin, OUTFIT_MEDIA);
  repository.allow(owner, user.id); repository.allow(brand, user.id);
  const bytes = Buffer.concat([Buffer.from(IMAGE_UPLOAD.image.prefix), Buffer.from(fixture.payload), Buffer.from(IMAGE_UPLOAD.image.suffix)]);
  const file = {buffer: bytes, mimetype: IMAGE_UPLOAD.mime, size: bytes.length}, input = {creatorId: owner.creatorId, requestId: randomUUID()};
  return {user, owner, brand, repository, storage, locator, input, file, service: new OutfitMediaService(repository, storage, locator)};
}
describe('Owned outfit media', () => {
  it('uploads and recovers one immutable asset with a canonical private projection', async () => {
    const s = setup(), first = await s.service.upload(s.user, s.input, s.file), replay = await s.service.upload(s.user, s.input, s.file);
    expect(replay.id).toBe(first.id); expect(first.creatorId).toBe(s.owner.creatorId); expect(first.brandId).toBeNull();
    expect(s.repository.assets.size).toBe(fixture.one); expect(s.storage.uploadCalls).toBe(fixture.one);
    expect(first.url).toBe(s.locator.url(first.id)); expect(first).not.toHaveProperty('uploadedBy'); expect(first).not.toHaveProperty('objectPath');
    const bytes = Buffer.concat([Buffer.from(IMAGE_UPLOAD.image.prefix), Buffer.from(fixture.changed), Buffer.from(IMAGE_UPLOAD.image.suffix)]);
    await expect(s.service.upload(s.user, s.input, {...s.file, buffer: bytes, size: bytes.length})).rejects.toBeInstanceOf(ConflictException);
  });
  it('supports brand ownership but still requires the corresponding actor role and membership', async () => {
    const s = setup(), input = {brandId: s.brand.brandId, requestId: randomUUID()};
    const brand = await s.service.upload(s.user, input, s.file); expect(brand.creatorId).toBeNull(); expect(brand.brandId).toBe(s.brand.brandId);
    await expect(s.service.upload({...s.user, roles: [PROFILE_AUTHOR_ROLES.creator]}, {...input, requestId: randomUUID()}, s.file)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.service.upload({id: randomUUID(), roles: s.user.roles}, {...input, requestId: randomUUID()}, s.file)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.service.upload(s.user, {...s.input, brandId: s.brand.brandId}, s.file)).rejects.toBeInstanceOf(BadRequestException);
  });
  it('leaves failed uploads pending and resumes the same asset after storage and membership recovery', async () => {
    const s = setup(); s.storage.afterUpload = () => s.repository.owners.get(s.repository.ownerKey(s.owner))!.members.clear();
    await expect(s.service.upload(s.user, s.input, s.file)).rejects.toBeInstanceOf(ForbiddenException);
    const pending = [...s.repository.assets.values()][fixture.first]; expect(pending.status).toBe(OUTFIT_MEDIA.status.pending);
    await expect(s.service.privateImage(s.user, pending.id)).rejects.toBeInstanceOf(NotFoundException);
    s.repository.allow(s.owner, s.user.id); s.storage.afterUpload = undefined;
    const retried = await s.service.upload(s.user, s.input, s.file);
    expect(retried.id).toBe(pending.id); expect(s.repository.assets.size).toBe(fixture.one); expect(s.storage.files.size).toBe(fixture.one); expect(s.storage.uploadCalls).toBe(fixture.two);
  });
  it('rejects invalid files before reserving an asset', async () => {
    const s = setup();
    await expect(s.service.upload(s.user, s.input)).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.service.upload(s.user, s.input, {...s.file, mimetype: fixture.png})).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.service.upload(s.user, s.input, {...s.file, size: fixture.zero})).rejects.toBeInstanceOf(BadRequestException);
    expect(s.repository.assets.size).toBe(fixture.zero);
  });
  it('keeps private reads scoped and asks the repository for a public reference', async () => {
    const s = setup(), asset = await s.service.upload(s.user, s.input, s.file);
    expect(await s.service.privateImage(s.user, asset.id)).toEqual(asset);
    await expect(s.service.privateImage({id: randomUUID(), roles: s.user.roles}, asset.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.service.publicImage(asset.id)).rejects.toBeInstanceOf(NotFoundException);
    s.repository.publicURLs.set(asset.id, asset.url); expect(await s.service.publicImage(asset.id)).toBe(asset.displayUrl);
    s.repository.owners.get(s.repository.ownerKey(s.owner))!.status = PROFILE_STATUS.paused;
    await expect(s.service.publicImage(asset.id)).rejects.toBeInstanceOf(NotFoundException);
    expect((await s.service.privateImage(s.user, asset.id)).id).toBe(asset.id);
  });
  it('rejects foreign, unowned editorial and other-family internal links while preserving external sources', async () => {
    const s = setup(), asset = await s.service.upload(s.user, s.input, s.file);
    const displays = await s.service.resolveImages([{owner: s.owner, url: asset.url}, {owner: null, url: fixture.external}]);
    expect(displays.get(asset.url)).toBe(asset.displayUrl); expect(displays.get(fixture.external)).toBe(fixture.external);
    await expect(s.service.resolveImages([{owner: s.brand, url: asset.url}])).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.service.resolveImages([{owner: null, url: asset.url}])).rejects.toBeInstanceOf(BadRequestException);
    const product = new MediaAssetLocator(() => fixture.origin, PRODUCT_MEDIA);
    expect(() => s.service.assetIDs([product.url(randomUUID())])).toThrow(BadRequestException);
    s.storage.omitSignedPath = true;
    await expect(s.service.resolveImages([{owner: s.owner, url: asset.url}])).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

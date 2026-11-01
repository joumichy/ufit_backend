import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ProductMediaService } from '../../src/modules/media/application/product-media.service';
import { ProductMediaLocator } from '../../src/modules/media/application/product-media-locator';
import { PRODUCT_MEDIA } from '../../src/modules/media/domain/product-media.contract';
import type { ProductMediaAsset, ProductMediaRepository, ProductMediaStorage } from '../../src/modules/media/domain/product-media.types';

const fixture = {
  origin: 'https://media.test', external: 'https://cdn.test/image.jpg', signed: 'https://signed.test/', payload: 'image payload', changed: 'changed image payload', invalid: 'Invalid media fixture contract',
  timestamp: new Date('2026-10-31T00:00:00.000Z'), first: 0, firstCall: 1, missingSize: 0, malformedOrigin: 'https://media.test/extra',
} as const;
class MemoryMediaRepository implements ProductMediaRepository {
  readonly assets = new Map<string, ProductMediaAsset>();
  readonly members = new Set<string>();
  readonly publicURLs = new Map<string, string>();
  private authorize(brandId: string, userId: string) { if (!this.members.has(brandId + userId)) throw new ForbiddenException(PRODUCT_MEDIA.failure.access); }
  async reserve(input: Parameters<ProductMediaRepository['reserve']>[0]) {
    this.authorize(input.brandId, input.uploadedBy);
    const previous = [...this.assets.values()].find(asset => asset.brandId === input.brandId && asset.requestId === input.requestId);
    if (previous) {
      if (previous.fingerprint !== input.fingerprint || previous.byteSize !== input.byteSize || previous.contentType !== input.contentType) throw new ConflictException(PRODUCT_MEDIA.failure.request);
      return previous;
    }
    const asset: ProductMediaAsset = {...input, status: PRODUCT_MEDIA.status.pending, createdAt: fixture.timestamp, updatedAt: fixture.timestamp};
    this.assets.set(asset.id, asset); return asset;
  }
  async markReady(asset: ProductMediaAsset, userId: string) {
    this.authorize(asset.brandId, userId);
    const existing = this.assets.get(asset.id);
    if (!existing || existing.brandId !== asset.brandId || existing.fingerprint !== asset.fingerprint) throw new Error(fixture.invalid);
    const ready = {...existing, status: PRODUCT_MEDIA.status.ready}; this.assets.set(asset.id, ready); return ready;
  }
  async findByIds(ids: string[]) { return [...this.assets.values()].filter(asset => ids.includes(asset.id)); }
  async findOwnedReady(id: string, userId: string) {
    const asset = this.assets.get(id);
    return asset && asset.status === PRODUCT_MEDIA.status.ready && this.members.has(asset.brandId + userId) ? asset : null;
  }
  async findPublic(id: string, url: string) { return this.publicURLs.get(id) === url ? this.assets.get(id) ?? null : null; }
}
class MemoryMediaStorage implements ProductMediaStorage {
  readonly files = new Map<string, Buffer>();
  uploadCalls = fixture.missingSize;
  failUpload = false;
  omitSignedPath = false;
  afterUpload?: () => void;
  async uploadOrVerify(path: string, bytes: Buffer, fingerprint: string) {
    if (createHash(PRODUCT_MEDIA.hash.algorithm).update(bytes).digest(PRODUCT_MEDIA.hash.encoding) !== fingerprint) throw new Error(fixture.invalid);
    this.uploadCalls += fixture.firstCall;
    if (this.failUpload) throw new ServiceUnavailableException(PRODUCT_MEDIA.failure.unavailable);
    const previous = this.files.get(path);
    if (previous && !previous.equals(bytes)) throw new Error(fixture.invalid);
    this.files.set(path, bytes); this.afterUpload?.();
  }
  async sign(paths: string[]) {
    if (paths.some(path => !this.files.has(path))) throw new ServiceUnavailableException(PRODUCT_MEDIA.failure.unavailable);
    return this.omitSignedPath ? new Map<string, string>() : new Map(paths.map(path => [path, fixture.signed + path]));
  }
}
function setup() {
  const brandId = randomUUID(), userId = randomUUID(), requestId = randomUUID();
  const repository = new MemoryMediaRepository(), storage = new MemoryMediaStorage(), locator = new ProductMediaLocator(() => fixture.origin);
  repository.members.add(brandId + userId);
  const buffer = Buffer.concat([Buffer.from(PRODUCT_MEDIA.image.prefix), Buffer.from(fixture.payload), Buffer.from(PRODUCT_MEDIA.image.suffix)]);
  return {brandId, userId, input: {brandId, requestId}, repository, storage, locator, file: {buffer, size: buffer.length, mimetype: PRODUCT_MEDIA.mime}, service: new ProductMediaService(repository, storage, locator)};
}
describe('Product media ownership and recovery', () => {
  it('renews a ready private image only for a current member without making it public', async () => {
    const s = setup(), asset = await s.service.upload(s.userId, s.input, s.file);
    expect(await s.service.privateImage(s.userId, asset.id)).toEqual(asset);
    await expect(s.service.privateImage(randomUUID(), asset.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.service.publicImage(asset.id)).rejects.toBeInstanceOf(NotFoundException);
    s.repository.members.clear();
    await expect(s.service.privateImage(s.userId, asset.id)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('does not sign an incomplete or unknown asset for a member', async () => {
    const s = setup(); s.storage.failUpload = true;
    await expect(s.service.upload(s.userId, s.input, s.file)).rejects.toBeInstanceOf(ServiceUnavailableException);
    const pending = [...s.repository.assets.values()][fixture.first];
    await expect(s.service.privateImage(s.userId, pending.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.service.privateImage(s.userId, randomUUID())).rejects.toBeInstanceOf(NotFoundException);
  });
  it('replays the same upload without a second asset or overwrite and separates stable/read URLs', async () => {
    const s = setup();
    const first = await s.service.upload(s.userId, s.input, s.file);
    const replay = await s.service.upload(s.userId, s.input, s.file);
    expect(replay.id).toBe(first.id); expect(s.repository.assets.size).toBe(fixture.firstCall); expect(s.storage.uploadCalls).toBe(fixture.firstCall);
    expect(first.url).toBe(s.locator.url(first.id)); expect(first.displayUrl).toBe(fixture.signed + s.repository.assets.get(first.id)!.objectPath);
    expect(first).not.toHaveProperty('fingerprint'); expect(first).not.toHaveProperty('objectPath');
  });
  it('rejects changed content for an existing request before touching storage', async () => {
    const s = setup(); await s.service.upload(s.userId, s.input, s.file);
    const buffer = Buffer.concat([Buffer.from(PRODUCT_MEDIA.image.prefix), Buffer.from(fixture.changed), Buffer.from(PRODUCT_MEDIA.image.suffix)]);
    await expect(s.service.upload(s.userId, s.input, {...s.file, buffer, size: buffer.length})).rejects.toBeInstanceOf(ConflictException);
    expect(s.storage.uploadCalls).toBe(fixture.firstCall);
  });
  it('keeps the reserved identity after provider failure and completes that same asset on retry', async () => {
    const s = setup(); s.storage.failUpload = true;
    await expect(s.service.upload(s.userId, s.input, s.file)).rejects.toBeInstanceOf(ServiceUnavailableException);
    const pending = [...s.repository.assets.values()][fixture.first]; expect(pending.status).toBe(PRODUCT_MEDIA.status.pending);
    s.storage.failUpload = false;
    const ready = await s.service.upload(s.userId, s.input, s.file);
    expect(ready.id).toBe(pending.id); expect(s.repository.assets.size).toBe(fixture.firstCall);
  });
  it('denies non-members and rechecks a membership revoked while the provider uploads', async () => {
    const s = setup();
    await expect(s.service.upload(randomUUID(), s.input, s.file)).rejects.toBeInstanceOf(ForbiddenException);
    expect(s.storage.uploadCalls).toBe(fixture.missingSize);
    s.storage.afterUpload = () => s.repository.members.clear();
    await expect(s.service.upload(s.userId, s.input, s.file)).rejects.toBeInstanceOf(ForbiddenException);
    expect([...s.repository.assets.values()][fixture.first].status).toBe(PRODUCT_MEDIA.status.pending);
  });
  it('requires actual upload bytes, matching size and JPEG framing before reserving anything', async () => {
    const s = setup();
    for (const file of [undefined, {...s.file, size: fixture.missingSize}, {...s.file, buffer: Buffer.from(fixture.payload), size: Buffer.byteLength(fixture.payload)}]) {
      await expect(s.service.upload(s.userId, s.input, file)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(s.repository.assets.size).toBe(fixture.missingSize);
  });
  it('resolves the exact owner URLs in one batch and rejects foreign or incomplete read results', async () => {
    const s = setup(); const asset = await s.service.upload(s.userId, s.input, s.file);
    const result = await s.service.resolveImages([{brandId: s.brandId, url: asset.url}, {brandId: s.brandId, url: fixture.external}]);
    expect(result.get(asset.url)).toBe(asset.displayUrl); expect(result.get(fixture.external)).toBe(fixture.external);
    await expect(s.service.resolveImages([{brandId: randomUUID(), url: asset.url}])).rejects.toBeInstanceOf(BadRequestException);
    s.storage.omitSignedPath = true;
    await expect(s.service.resolveImages([{brandId: s.brandId, url: asset.url}])).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it('does not treat a ready private asset as publicly eligible', async () => {
    const s = setup(); const asset = await s.service.upload(s.userId, s.input, s.file);
    await expect(s.service.publicImage(asset.id)).rejects.toBeInstanceOf(NotFoundException);
    s.repository.publicURLs.set(asset.id, asset.url);
    expect(await s.service.publicImage(asset.id)).toBe(asset.displayUrl);
  });
  it('uses canonical asset IDs and rejects URL variants or missing configuration', () => {
    const s = setup(), id = randomUUID(), canonical = s.locator.url(id);
    expect(s.service.assetIDs([canonical, canonical, fixture.external])).toEqual([id]);
    expect(() => s.service.assetIDs([canonical + PRODUCT_MEDIA.storageSettings.separator])).toThrow(BadRequestException);
    const locator = new ProductMediaLocator(() => fixture.malformedOrigin);
    expect(() => locator.url(id)).toThrow(ServiceUnavailableException);
  });
});

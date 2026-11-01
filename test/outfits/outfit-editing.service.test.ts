import {ServiceUnavailableException} from '@nestjs/common';
import {OUTFIT_MEDIA} from '../../src/modules/media/domain/outfit-media.contract';
import {MemoryOutfitMediaReader} from './memory-outfit-media.reader';
import {randomUUID} from 'node:crypto';
import {BadRequestException, ConflictException, ForbiddenException, NotFoundException} from '@nestjs/common';
import {describe, expect, it, vi} from 'vitest';
import {OutfitsService} from '../../src/modules/outfits/application/outfits.service';
import type {CreateOutfitDto, UpdateOutfitDto} from '../../src/modules/outfits/application/dto/outfit.dto';
import {OUTFIT_EDITING, OUTFIT_STATUS, OUTFIT_VISIBILITY} from '../../src/modules/outfits/domain/outfit-editing.contract';
import {MemoryProductRepository} from '../products/memory-product.repository';
import {MemoryOutfitRepository, outfitFixture, publicCreator} from './memory-outfit.repository';

const data = {
  title: 'Tenue de travail', changedTitle: 'Tenue corrigée', description: 'Silhouette sobre et structurée.', inspiration: 'Chemise personnelle',
  reason: 'Préciser la silhouette', empty: '', count: 1, zero: 0, invalidReason: '   ', failure: 'Interrupted aggregate write',
  itemType: 'top', customerRole: 'customer', otherRole: 'creator',
} as const;
function setup() {
  const products = new MemoryProductRepository(), media = new MemoryOutfitMediaReader(), repository = new MemoryOutfitRepository(products, media.assets);
  const service = new OutfitsService(repository, products, media);
  const input: CreateOutfitDto = {requestId: randomUUID(), creatorId: publicCreator.id, title: data.title, description: data.description,
    tagIds: [], images: [outfitFixture.image], items: [{itemType: data.itemType, externalLabel: data.inspiration, position: data.zero, isRequired: true, isShoppable: false}]};
  return {repository, service, input, media};
}
type Detail = Awaited<ReturnType<OutfitsService['getManagedOutfit']>>;
function changes(detail: Detail): UpdateOutfitDto {
  return {expectedVersion: detail.version, title: detail.title, description: detail.description, genderTarget: detail.genderTarget,
    tagIds: detail.tags.map(tag => tag.id), images: detail.images,
    items: detail.items.map(item => ({id: item.id, productId: item.productId, externalLabel: item.externalLabel, itemType: item.itemType,
      position: item.position, isRequired: item.isRequired, isShoppable: item.isShoppable, stylingNote: item.stylingNote}))};
}
describe('Owned outfit editing', () => {
  it('requires the owning approved profile even when a caller has a creator role', async () => {
    const {service, input} = setup();
    const other = {id: randomUUID(), roles: [data.otherRole]}, customer = {id: outfitFixture.actor.id, roles: [data.customerRole]};
    await expect(service.createOutfit(other, input)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.createOutfit(customer, input)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.createOutfit(outfitFixture.actor, {...input, brandId: randomUUID()})).rejects.toBeInstanceOf(BadRequestException);
    const created = await service.createOutfit(outfitFixture.actor, input);
    await expect(service.getManagedOutfit(other, created.id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.listManagedOutfits(other, {creatorId: publicCreator.id})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.updateOutfit(outfitFixture.admin, created.id, changes(created))).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('recovers the same creation and rejects reuse with a different payload', async () => {
    const {service, repository, input} = setup();
    const first = await service.createOutfit(outfitFixture.actor, input), replay = await service.createOutfit(outfitFixture.actor, {...input,
      items: input.items.map(item => Object.fromEntries(Object.entries(item).reverse()) as typeof item),
      images: input.images.map(image => Object.fromEntries(Object.entries(image).reverse()) as typeof image)});
    expect(replay.id).toBe(first.id); expect(replay.items.map(item => item.id)).toEqual(first.items.map(item => item.id));
    expect(repository.outfits.size).toBe(data.count);
    expect((await service.recoverCreation(outfitFixture.actor, {creatorId: publicCreator.id}, input.requestId)).id).toBe(first.id);
    await expect(service.createOutfit(outfitFixture.actor, {...input, title: data.changedTitle})).rejects.toBeInstanceOf(ConflictException);
    await expect(service.recoverCreation(outfitFixture.actor, {creatorId: publicCreator.id}, randomUUID())).rejects.toBeInstanceOf(NotFoundException);
  });
  it('rolls the entire aggregate and creation request back when an image write fails', async () => {
    const {service, repository, input} = setup();
    const addImages = repository.addImages.bind(repository), failure = new Error(data.failure);
    vi.spyOn(repository, 'addImages').mockImplementation(async (id, images) => { await addImages(id, images); throw failure; });
    await expect(service.createOutfit(outfitFixture.actor, input)).rejects.toBe(failure);
    expect(repository.outfits.size).toBe(data.zero); expect(repository.items).toHaveLength(data.zero); expect(repository.images).toHaveLength(data.zero);
    await expect(service.recoverCreation(outfitFixture.actor, {creatorId: publicCreator.id}, input.requestId)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('keeps versioned decisions, correction identities and public visibility coherent', async () => {
    const {service, input} = setup(); let detail = await service.createOutfit(outfitFixture.actor, input);
    const itemIDs = detail.items.map(item => item.id), imageIDs = detail.images.map(image => image.id);
    detail = await service.submitOutfit(outfitFixture.actor, detail.id, {expectedVersion: detail.version});
    const submittedVersion = detail.version;
    await expect(service.updateOutfit(outfitFixture.actor, detail.id, changes(detail))).rejects.toBeInstanceOf(ConflictException);
    await expect(service.reviewOutfit(outfitFixture.actor, detail.id, {expectedVersion: detail.version, decision: OUTFIT_STATUS.published})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.reviewOutfit(outfitFixture.admin, detail.id, {expectedVersion: detail.version, decision: OUTFIT_STATUS.rejected, rejectionReason: data.invalidReason})).rejects.toBeInstanceOf(BadRequestException);
    detail = await service.reviewOutfit(outfitFixture.admin, detail.id, {expectedVersion: detail.version, decision: OUTFIT_STATUS.rejected, rejectionReason: data.reason});
    expect(detail.rejectionReason).toBe(data.reason);
    await expect(service.updateOutfit(outfitFixture.actor, detail.id, {...changes(detail), expectedVersion: submittedVersion})).rejects.toBeInstanceOf(ConflictException);
    detail = await service.updateOutfit(outfitFixture.actor, detail.id, {...changes(detail), title: data.changedTitle});
    expect(detail.status).toBe(OUTFIT_STATUS.draft); expect(detail.rejectionReason).toBeNull();
    detail = await service.submitOutfit(outfitFixture.actor, detail.id, {expectedVersion: detail.version});
    detail = await service.reviewOutfit(outfitFixture.admin, detail.id, {expectedVersion: detail.version, decision: OUTFIT_STATUS.published});
    expect((await service.getPublicDetail(detail.id)).id).toBe(detail.id);
    detail = await service.updateOutfit(outfitFixture.actor, detail.id, changes(detail));
    expect(detail.status).toBe(OUTFIT_STATUS.draft); expect(detail.visibility).toBe(OUTFIT_VISIBILITY.private); expect(detail.reviewedAt).toBeNull();
    await expect(service.getPublicDetail(detail.id)).rejects.toBeInstanceOf(NotFoundException);
    detail = await service.archiveOutfit(outfitFixture.admin, detail.id, {expectedVersion: detail.version});
    detail = await service.restoreOutfit(outfitFixture.actor, detail.id, {expectedVersion: detail.version});
    expect(detail.status).toBe(OUTFIT_STATUS.draft); expect(detail.items.map(item => item.id)).toEqual(itemIDs); expect(detail.images.map(image => image.id)).toEqual(imageIDs);
  });
  it('rejects foreign or pending owned media and prepares private links before committing a review', async () => {
    const {service, repository, input, media} = setup(), assetID = randomUUID();
    const owner = {creatorId: publicCreator.id, brandId: null} as const;
    const displayUrl = outfitFixture.image.url;
    media.assets.set(assetID, {owner, displayUrl, status: OUTFIT_MEDIA.status.pending});
    const body = {...input, images: [{url: media.locator.url(assetID), position: data.zero}]};
    await expect(service.createOutfit(outfitFixture.actor, body)).rejects.toBeInstanceOf(BadRequestException);
    media.assets.set(assetID, {owner: {creatorId: randomUUID(), brandId: null}, displayUrl, status: OUTFIT_MEDIA.status.ready});
    await expect(service.createOutfit(outfitFixture.actor, body)).rejects.toBeInstanceOf(BadRequestException);
    media.assets.set(assetID, {owner, displayUrl, status: OUTFIT_MEDIA.status.ready});
    let detail = await service.createOutfit(outfitFixture.actor, body);
    expect(detail.images[data.zero].displayUrl).toBe(displayUrl);
    detail = await service.submitOutfit(outfitFixture.actor, detail.id, {expectedVersion: detail.version});
    media.failReads = true;
    await expect(service.reviewOutfit(outfitFixture.admin, detail.id, {expectedVersion: detail.version, decision: OUTFIT_STATUS.published})).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(repository.outfits.get(detail.id)?.status).toBe(OUTFIT_STATUS.underReview);
    expect(repository.outfits.get(detail.id)?.version).toBe(detail.version);
  });
  it('rejects incomplete submissions, foreign child IDs, unknown tags and unavailable products without changing the draft', async () => {
    const {service, input} = setup(); const detail = await service.createOutfit(outfitFixture.actor, {...input, description: data.empty, images: []});
    await expect(service.submitOutfit(outfitFixture.actor, detail.id, {expectedVersion: detail.version})).rejects.toBeInstanceOf(BadRequestException);
    const base = {...changes(detail), description: data.description, images: [outfitFixture.image]};
    await expect(service.updateOutfit(outfitFixture.actor, detail.id, {...base, images: [{...outfitFixture.image, id: randomUUID()}]})).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateOutfit(outfitFixture.actor, detail.id, {...base, items: [{...base.items[data.zero], id: randomUUID()}]})).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateOutfit(outfitFixture.actor, detail.id, {...base, tagIds: [randomUUID()]})).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateOutfit(outfitFixture.actor, detail.id, {...base, items: [{...base.items[data.zero], productId: randomUUID(), externalLabel: null, isShoppable: true}]})).rejects.toBeInstanceOf(BadRequestException);
    expect((await service.getManagedOutfit(outfitFixture.actor, detail.id)).version).toBe(OUTFIT_EDITING.versionInitial);
  });
});

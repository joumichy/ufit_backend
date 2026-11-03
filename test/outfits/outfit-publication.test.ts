import {randomUUID} from 'node:crypto';
import {BadRequestException, ConflictException, ForbiddenException, NotFoundException} from '@nestjs/common';
import {describe, expect, it} from 'vitest';
import {OutfitsService} from '../../src/modules/outfits/application/outfits.service';
import {OUTFIT_STATUS as S, OUTFIT_VISIBILITY as V} from '../../src/modules/outfits/domain/outfit-editing.contract';
import {PROFILE_STATUS} from '../../src/shared/domain/profile-editing.contract';
import {MemoryProductRepository} from '../products/memory-product.repository';
import {MemoryOutfitRepository, outfitFixture, publicCreator} from './memory-outfit.repository';
import {MemoryOutfitMediaReader} from './memory-outfit-media.reader';

const fixture = {
  future: '2099-03-29T08:00:00.000Z', later: '2099-03-30T08:00:00.000Z', past: '2000-01-01T00:00:00.000Z',
  zone: 'Europe/Zurich', invalidZone: 'Invalid/Ufit', title: 'Tenue programmée', description: 'Silhouette pour publication différée.',
  empty: '', label: 'Chemise personnelle', type: 'top', zero: 0, end: '2099-04-01T00:00:00.000Z', from: '2099-03-01T00:00:00.000Z',
} as const;
async function setup() {
  const products = new MemoryProductRepository(), media = new MemoryOutfitMediaReader();
  const repository = new MemoryOutfitRepository(products, media.assets), service = new OutfitsService(repository, products, media);
  const detail = await service.createOutfit(outfitFixture.actor, {requestId: randomUUID(), creatorId: publicCreator.id,
    title: fixture.title, description: fixture.description, tagIds: [], images: [outfitFixture.image],
    items: [{itemType: fixture.type, externalLabel: fixture.label, position: fixture.zero, isRequired: true, isShoppable: false}]});
  const plan = (expectedVersion: number, scheduledFor = fixture.future, timeZone = fixture.zone) => ({expectedVersion, scheduledFor, timeZone});
  return {repository, service, detail, plan};
}

describe('Publication calendar', () => {
  it('keeps a planned submission private until admin approval and its date', async () => {
    const {service, detail, plan} = await setup();
    const pending = await service.planPublication(outfitFixture.actor, detail.id, plan(detail.version));
    expect(pending.status).toBe(S.underReview);
    expect(await service.publishScheduledOutfit(detail.id, new Date(fixture.later))).toBe(false);
    await expect(service.getPublicDetail(detail.id)).rejects.toBeInstanceOf(NotFoundException);
    const approved = await service.reviewOutfit(outfitFixture.admin, detail.id, {expectedVersion: pending.version, decision: S.published});
    expect(approved.status).toBe(S.scheduled); expect(approved.visibility).toBe(V.private); expect(approved.publishedAt).toBeNull();
    expect(await service.publishScheduledOutfit(detail.id, new Date(fixture.past))).toBe(false);
    expect(await service.publishScheduledOutfit(detail.id, new Date(fixture.future))).toBe(true);
    const published = await service.getManagedOutfit(outfitFixture.actor, detail.id);
    expect(published.status).toBe(S.published); expect(published.reviewedAt).toBe(approved.reviewedAt);
    expect(published.publishedAt).toBe(fixture.future);
    expect(await service.publishScheduledOutfit(detail.id, new Date(fixture.later))).toBe(false);
  });
  it('rejects past dates, invalid zones, incomplete pairs and incomplete content', async () => {
    const {service, repository, detail, plan} = await setup();
    await expect(service.planPublication(outfitFixture.actor, detail.id, {...plan(detail.version), scheduledFor: fixture.past})).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.planPublication(outfitFixture.actor, detail.id, {...plan(detail.version), timeZone: fixture.invalidZone})).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.planPublication(outfitFixture.actor, detail.id, {...plan(detail.version), timeZone: null})).rejects.toBeInstanceOf(BadRequestException);
    repository.outfits.get(detail.id)!.description = fixture.empty;
    await expect(service.planPublication(outfitFixture.actor, detail.id, plan(detail.version))).rejects.toBeInstanceOf(BadRequestException);
  });
  it('protects ownership and optimistic versions', async () => {
    const {service, detail, plan} = await setup();
    await expect(service.planPublication({...outfitFixture.actor, id: randomUUID()}, detail.id, plan(detail.version))).rejects.toBeInstanceOf(ForbiddenException);
    await service.planPublication(outfitFixture.actor, detail.id, plan(detail.version));
    await expect(service.planPublication(outfitFixture.actor, detail.id, plan(detail.version))).rejects.toBeInstanceOf(ConflictException);
  });
  it('reschedules an approved unchanged outfit without losing approval; cancellation restores a private draft', async () => {
    const {service, detail, plan} = await setup();
    const pending = await service.planPublication(outfitFixture.actor, detail.id, plan(detail.version));
    const approved = await service.reviewOutfit(outfitFixture.admin, detail.id, {expectedVersion: pending.version, decision: S.published});
    const later = await service.planPublication(outfitFixture.actor, detail.id, {...plan(approved.version), scheduledFor: fixture.later});
    expect(later.status).toBe(S.scheduled); expect(later.reviewedAt).toBe(approved.reviewedAt);
    const cancelled = await service.planPublication(outfitFixture.actor, detail.id, {expectedVersion: later.version, scheduledFor: null, timeZone: null});
    expect(cancelled.status).toBe(S.draft); expect(cancelled.scheduledFor).toBeNull(); expect(cancelled.publicationTimeZone).toBeNull();
    expect(cancelled.reviewedAt).toBeNull(); expect(await service.publishScheduledOutfit(detail.id, new Date(fixture.end))).toBe(false);
  });
  it('archive and restoration remove the old date instead of silently scheduling a later submission', async () => {
    const {service, detail, plan} = await setup();
    const pending = await service.planPublication(outfitFixture.actor, detail.id, plan(detail.version));
    const approved = await service.reviewOutfit(outfitFixture.admin, detail.id, {expectedVersion: pending.version, decision: S.published});
    const archived = await service.archiveOutfit(outfitFixture.actor, detail.id, {expectedVersion: approved.version});
    expect(archived.scheduledFor).toBeNull(); expect(archived.publicationTimeZone).toBeNull();
    const calendar = await service.getPublicationCalendar(outfitFixture.actor, {creatorId: publicCreator.id, from: fixture.from, until: fixture.end});
    expect(calendar.items).toEqual([]);
    const restored = await service.restoreOutfit(outfitFixture.actor, detail.id, {expectedVersion: archived.version});
    expect(restored.status).toBe(S.draft); expect(restored.scheduledFor).toBeNull(); expect(restored.reviewedAt).toBeNull();
    const submitted = await service.submitOutfit(outfitFixture.actor, detail.id, {expectedVersion: restored.version});
    const published = await service.reviewOutfit(outfitFixture.admin, detail.id, {expectedVersion: submitted.version, decision: S.published});
    expect(published.status).toBe(S.published); expect(published.scheduledFor).toBeNull(); expect(published.publishedAt).not.toBeNull();
  });
  it('does not publish a suspended author; a later pass rechecks eligibility', async () => {
    const {service, repository, detail, plan} = await setup();
    const pending = await service.planPublication(outfitFixture.actor, detail.id, plan(detail.version));
    await service.reviewOutfit(outfitFixture.admin, detail.id, {expectedVersion: pending.version, decision: S.published});
    repository.owners.get(publicCreator.id)!.status = PROFILE_STATUS.suspended;
    await expect(service.publishScheduledOutfit(detail.id, new Date(fixture.future))).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.outfits.get(detail.id)?.status).toBe(S.scheduled);
    repository.owners.get(publicCreator.id)!.status = PROFILE_STATUS.active;
    expect(await service.publishScheduledOutfit(detail.id, new Date(fixture.future))).toBe(true);
  });
  it('returns scoped calendar rows and rejects missing owner and oversized date intervals', async () => {
    const {service, detail, plan} = await setup();
    await service.planPublication(outfitFixture.actor, detail.id, plan(detail.version));
    const query = {creatorId: publicCreator.id, from: fixture.from, until: fixture.end};
    const page = await service.getPublicationCalendar(outfitFixture.actor, query);
    expect(page.items.map(row => row.id)).toEqual([detail.id]); expect(page.asOf).toBeTruthy();
    await expect(service.getPublicationCalendar(outfitFixture.actor, {...query, creatorId: randomUUID()})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.getPublicationCalendar(outfitFixture.actor, {from: fixture.from, until: fixture.end})).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getPublicationCalendar(outfitFixture.actor, {...query, from: fixture.past})).rejects.toBeInstanceOf(BadRequestException);
  });
});

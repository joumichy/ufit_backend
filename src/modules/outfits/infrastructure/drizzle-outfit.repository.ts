import {OUTFIT_PUBLICATION as P, type OutfitCalendarQuery} from '../domain/outfit-publication.contract';
import {OUTFIT_MEDIA} from '../../media/domain/outfit-media.contract';
import {findAuthoringProfile, ProfileAccessMode} from '../../../shared/infrastructure/database/profile-authoring-access';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, inArray, isNull, notInArray, gt, gte, lte, sql, exists } from 'drizzle-orm';
import {OUTFIT_EDITING, OUTFIT_STATUS, OUTFIT_VISIBILITY} from '../domain/outfit-editing.contract';
import {PRODUCT_STATUS} from '../../products/domain/product-contract';
import {READ_SNAPSHOT, type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {PUBLIC_PROFILE} from '../../../shared/domain/public-profile.contract';
import type {PublicOutfitPage} from '../domain/public-outfit.contract';
import {publicOutfitVisibility} from './public-outfit-visibility';
import {publicOutfitDiscovery} from './public-outfit-discovery';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import { brandProfiles, creatorProfiles, outfitImages, outfitItems, outfitPins, outfits, users, products, tags, outfitTags, outfitMediaAssets } from '../../../shared/infrastructure/database/schema';
import type { Outfit, OutfitAuthor, OutfitDetail, OutfitImage, OutfitItem, OutfitRepository, OutfitStatus, OutfitVisibility, OutfitOwner, OutfitOwnerInfo, OutfitManagedQuery, OutfitManagedPage, OutfitContentUpdate, OutfitTag } from '../domain/outfit.types';

@Injectable()
export class DrizzleOutfitRepository implements OutfitRepository {
  private withinTransaction = false;
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}

  private scoped(database: DatabaseSession): DrizzleOutfitRepository {
    const repository = new DrizzleOutfitRepository(database); repository.withinTransaction = true; return repository;
  }
  transaction<T>(operation: (repository: OutfitRepository) => Promise<T>): Promise<T> {
    if (this.withinTransaction) return operation(this);
    return this.database.db.transaction(tx => operation(this.scoped({db: tx})));
  }
  readSnapshot<T>(operation: (repository: OutfitRepository) => Promise<T>): Promise<T> {
    if (this.withinTransaction) return operation(this);
    return this.database.db.transaction(tx => operation(this.scoped({db: tx})), READ_SNAPSHOT);
  }
  findEditableOwner(owner: OutfitOwner, userId: string) { return findAuthoringProfile(this.database, owner, userId, ProfileAccessMode.Read); }
  lockEditableOwner(owner: OutfitOwner, userId: string) { return findAuthoringProfile(this.database, owner, userId, ProfileAccessMode.Lock); }
  async lockOwner(owner: OutfitOwner): Promise<void> {
    if (owner.creatorId) await this.database.db.select({id: creatorProfiles.id}).from(creatorProfiles).innerJoin(users, eq(users.id, creatorProfiles.userId))
      .where(eq(creatorProfiles.id, owner.creatorId)).for(OUTFIT_EDITING.persistence.lock);
    else if (owner.brandId) await this.database.db.select({id: brandProfiles.id}).from(brandProfiles).where(eq(brandProfiles.id, owner.brandId)).for(OUTFIT_EDITING.persistence.lock);
  }
  async lockOutfit(id: string): Promise<Outfit | undefined> {
    const [row] = await this.database.db.select().from(outfits).where(eq(outfits.id, id)).for(OUTFIT_EDITING.persistence.lock); return row;
  }
  async findByCreationRequest(owner: OutfitOwner, requestId: string) {
    const [row] = await this.database.db.select({id: outfits.id, fingerprint: outfits.creationFingerprint}).from(outfits)
      .where(and(owner.creatorId ? eq(outfits.creatorId, owner.creatorId) : undefined, owner.brandId ? eq(outfits.brandId, owner.brandId) : undefined,
        eq(outfits.creationRequestId, requestId)));
    if (!row) return null;
    const detail = await this.findById(row.id); return detail ? {detail, fingerprint: row.fingerprint} : null;
  }
  async listManaged(query: OutfitManagedQuery): Promise<OutfitManagedPage> {
    const rows = await this.database.db.select().from(outfits).where(and(query.creatorId ? eq(outfits.creatorId, query.creatorId) : undefined,
      query.brandId ? eq(outfits.brandId, query.brandId) : undefined, query.status ? eq(outfits.status, query.status) : undefined,
      query.cursor ? gt(outfits.id, query.cursor) : undefined)).orderBy(outfits.id).limit(query.limit + OUTFIT_EDITING.limits.overflow);
    const page = rows.slice(OUTFIT_EDITING.limits.first, query.limit);
    return {items: await this.loadDetails(page, this.database), nextCursor: rows.length > query.limit ? page.at(OUTFIT_EDITING.limits.last)!.id : null};
  }
  async listCalendar(query: OutfitCalendarQuery): Promise<OutfitManagedPage> {
    const rows = await this.database.db.select().from(outfits).where(and(
      query.creatorId ? eq(outfits.creatorId, query.creatorId) : undefined,
      query.brandId ? eq(outfits.brandId, query.brandId) : undefined,
      gte(outfits.scheduledFor, query.from), lt(outfits.scheduledFor, query.until),
      query.cursor ? gt(outfits.id, query.cursor) : undefined)).orderBy(outfits.id).limit(query.limit + P.clock.overflow);
    const page = rows.slice(P.clock.first, query.limit);
    return {items: await this.loadDetails(page, this.database), nextCursor: rows.length > query.limit ? page.at(P.clock.last)!.id : null};
  }
  async listDuePublications(now: Date, cursor?: string): Promise<string[]> {
    const rows = await this.database.db.select({id: outfits.id}).from(outfits).where(and(
      eq(outfits.status, OUTFIT_STATUS.scheduled), lte(outfits.scheduledFor, now), cursor ? gt(outfits.id, cursor) : undefined))
      .orderBy(outfits.id).limit(P.clock.batch);
    return rows.map(row => row.id);
  }
  async publishScheduled(id: string, now: Date): Promise<void> {
    await this.database.db.update(outfits).set({status: OUTFIT_STATUS.published, visibility: OUTFIT_VISIBILITY.public,
      publishedAt: now, version: sql`${outfits.version} + ${OUTFIT_EDITING.versionStep}`, updatedAt: now}).where(eq(outfits.id, id));
  }
  async setPublication(id: string, scheduledFor: Date | null, timeZone: string | null): Promise<void> {
    await this.database.db.update(outfits).set({scheduledFor, publicationTimeZone: timeZone,
      status: scheduledFor === null ? OUTFIT_STATUS.draft : OUTFIT_STATUS.scheduled, visibility: OUTFIT_VISIBILITY.private, publishedAt: null,
      version: sql`${outfits.version} + ${OUTFIT_EDITING.versionStep}`, updatedAt: new Date()}).where(eq(outfits.id, id));
  }
  listTags(): Promise<OutfitTag[]> { return this.database.db.select({id: tags.id, type: tags.type, slug: tags.slug, label: tags.label}).from(tags).orderBy(tags.type, tags.label, tags.id); }
  async hasReadyOutfitMedia(owner: OutfitOwner, ids: string[]): Promise<boolean> {
    if (!ids.length) return true;
    const rows = await this.database.db.select({id: outfitMediaAssets.id}).from(outfitMediaAssets).where(and(inArray(outfitMediaAssets.id, ids),
      owner.creatorId !== null ? eq(outfitMediaAssets.creatorId, owner.creatorId) : isNull(outfitMediaAssets.creatorId),
      owner.brandId !== null ? eq(outfitMediaAssets.brandId, owner.brandId) : isNull(outfitMediaAssets.brandId), eq(outfitMediaAssets.status, OUTFIT_MEDIA.status.ready)));
    return rows.length === new Set(ids).size;
  }
  async findSelectableProductIds(ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const rows = await this.database.db.select({id: products.id}).from(products).innerJoin(brandProfiles, eq(brandProfiles.id, products.brandId))
      .where(and(inArray(products.id, ids), eq(products.status, PRODUCT_STATUS.active), eq(brandProfiles.status, PUBLIC_PROFILE.status)))
      .orderBy(products.id);
    return rows.map(row => row.id);
  }
  async replaceTags(id: string, tagIds: string[]): Promise<void> {
    await this.database.db.delete(outfitTags).where(eq(outfitTags.outfitId, id));
    if (tagIds.length) await this.database.db.insert(outfitTags).values(tagIds.map(tagId => ({outfitId: id, tagId})));
  }
  async replacePins(id: string, pins: Parameters<OutfitRepository['replacePins']>[1]): Promise<void> {
    await this.database.db.delete(outfitPins).where(eq(outfitPins.outfitId, id));
    if (!pins.length) return;
    const items = await this.database.db.select().from(outfitItems).where(eq(outfitItems.outfitId, id));
    const images = await this.database.db.select().from(outfitImages).where(eq(outfitImages.outfitId, id));
    await this.database.db.insert(outfitPins).values(pins.map(pin => ({outfitId: id,
      itemId: items.find(item => item.position === pin.itemPosition)!.id,
      imageId: images.find(image => image.position === pin.imagePosition)!.id, x: pin.x, y: pin.y})));
  }
  async replaceContent(id: string, input: OutfitContentUpdate): Promise<void> {
    const itemIds = input.items.flatMap(item => item.id ? [item.id] : []), imageIds = input.images.flatMap(image => image.id ? [image.id] : []);
    await this.database.db.delete(outfitItems).where(and(eq(outfitItems.outfitId, id), itemIds.length ? notInArray(outfitItems.id, itemIds) : undefined));
    for (const item of input.items) {
      if (item.id) await this.database.db.update(outfitItems).set(item).where(and(eq(outfitItems.outfitId, id), eq(outfitItems.id, item.id)));
      else await this.database.db.insert(outfitItems).values({...item, outfitId: id});
    }
    await this.database.db.delete(outfitImages).where(and(eq(outfitImages.outfitId, id), imageIds.length ? notInArray(outfitImages.id, imageIds) : undefined));
    for (const image of input.images) {
      if (image.id) await this.database.db.update(outfitImages).set(image).where(and(eq(outfitImages.outfitId, id), eq(outfitImages.id, image.id)));
      else await this.database.db.insert(outfitImages).values({...image, outfitId: id});
    }
    await this.replaceTags(id, input.tagIds);
    await this.replacePins(id, input.pins);
    await this.database.db.update(outfits).set({...input.fields, status: OUTFIT_STATUS.draft, visibility: OUTFIT_VISIBILITY.private,
      version: sql`${outfits.version} + ${OUTFIT_EDITING.versionStep}`, publishedAt: null, scheduledFor: null, publicationTimeZone: null, updatedAt: new Date()}).where(eq(outfits.id, id));
  }

  async createOutfit(input: Parameters<OutfitRepository['createOutfit']>[0]): Promise<Outfit> {
    const [row] = await this.database.db
      .insert(outfits)
      .values({ ...input, status: OUTFIT_STATUS.draft, visibility: OUTFIT_VISIBILITY.private, totalPriceMin: OUTFIT_EDITING.limits.integerMin, totalPriceMax: OUTFIT_EDITING.limits.integerMin, publishedAt: null })
      .returning();
    return row;
  }

  async addItems(outfitId: string, items: Parameters<OutfitRepository['addItems']>[1]): Promise<OutfitItem[]> {
    if (!items.length) {
      return [];
    }
    return this.database.db.insert(outfitItems).values(items.map((item) => ({ ...item, outfitId }))).returning();
  }

  async addImages(outfitId: string, images: Parameters<OutfitRepository['addImages']>[1]): Promise<OutfitImage[]> {
    if (!images.length) {
      return [];
    }
    return this.database.db.insert(outfitImages).values(images.map((image) => ({ ...image, outfitId }))).returning();
  }

  async findById(outfitId: string): Promise<OutfitDetail | null> {
    if (!this.withinTransaction) return this.readSnapshot(repository => repository.findById(outfitId));
    const rows = await this.database.db.select().from(outfits).where(eq(outfits.id, outfitId));
    const details = await this.loadDetails(rows, this.database);
    return details[OUTFIT_EDITING.limits.first] ?? null;
  }

  private async loadDetails(rows: Outfit[], database: DatabaseSession): Promise<OutfitDetail[]> {
    if (!rows.length) return [];
    const ids = rows.map(row => row.id), creatorIDs = rows.flatMap(row => row.creatorId ? [row.creatorId] : []), brandIDs = rows.flatMap(row => row.brandId ? [row.brandId] : []);
    const items = await database.db.select().from(outfitItems).where(inArray(outfitItems.outfitId, ids)).orderBy(outfitItems.position, outfitItems.id);
    const images = await database.db.select().from(outfitImages).where(inArray(outfitImages.outfitId, ids)).orderBy(outfitImages.position, outfitImages.id);
    const pins = await database.db.select().from(outfitPins).where(inArray(outfitPins.outfitId, ids)).orderBy(outfitPins.imageId, outfitPins.itemId);
    const creators = creatorIDs.length ? await database.db.select({id: creatorProfiles.id, name: creatorProfiles.displayName, avatarUrl: creatorProfiles.avatarUrl, status: creatorProfiles.status, userStatus: users.status})
      .from(creatorProfiles).innerJoin(users, eq(creatorProfiles.userId, users.id))
      .where(inArray(creatorProfiles.id, creatorIDs)) : [];
    const brands = brandIDs.length ? await database.db.select({id: brandProfiles.id, name: brandProfiles.brandName, avatarUrl: brandProfiles.logoUrl, status: brandProfiles.status}).from(brandProfiles)
      .where(inArray(brandProfiles.id, brandIDs)) : [];
    const tagRows = await database.db.select({outfitId: outfitTags.outfitId, id: tags.id, type: tags.type, slug: tags.slug, label: tags.label})
      .from(outfitTags).innerJoin(tags, eq(tags.id, outfitTags.tagId)).where(inArray(outfitTags.outfitId, ids)).orderBy(tags.type, tags.label, tags.id);
    const authorByCreator = new Map<string, OutfitAuthor>(creators.filter(row => row.status === PUBLIC_PROFILE.status && row.userStatus === PUBLIC_PROFILE.userStatus)
      .map(row => [row.id, {id: row.id, name: row.name, avatarUrl: row.avatarUrl, kind: PUBLIC_PROFILE.kind.creator}]));
    const authorByBrand = new Map<string, OutfitAuthor>(brands.filter(row => row.status === PUBLIC_PROFILE.status)
      .map(row => [row.id, {id: row.id, name: row.name, kind: PUBLIC_PROFILE.kind.brand, avatarUrl: row.avatarUrl}]));
    const ownersByCreator = new Map<string, OutfitOwnerInfo>(creators.map(row => [row.id, {id: row.id, name: row.name, status: row.status, kind: PUBLIC_PROFILE.kind.creator}]));
    const ownersByBrand = new Map<string, OutfitOwnerInfo>(brands.map(row => [row.id, {id: row.id, name: row.name, status: row.status, kind: PUBLIC_PROFILE.kind.brand}]));
    return rows.map(outfit => ({outfit, pins: pins.filter(pin => pin.outfitId === outfit.id).map(({outfitId: _, ...pin}) => pin), items: items.filter(row => row.outfitId === outfit.id), images: images.filter(row => row.outfitId === outfit.id),
      tags: tagRows.filter(row => row.outfitId === outfit.id).map(({outfitId: _, ...tag}) => tag),
      owner: outfit.creatorId ? ownersByCreator.get(outfit.creatorId) ?? null : outfit.brandId ? ownersByBrand.get(outfit.brandId) ?? null : null,
      author: outfit.creatorId ? authorByCreator.get(outfit.creatorId) ?? null : outfit.brandId ? authorByBrand.get(outfit.brandId) ?? null : null}));
  }

  async updateStatus(
    outfitId: string,
    status: OutfitStatus,
    visibility: OutfitVisibility
  ): Promise<Outfit> {
    const [row] = await this.database.db
      .update(outfits)
      .set({
        status,
        visibility,
        version: sql`${outfits.version} + ${OUTFIT_EDITING.versionStep}`,
        scheduledFor: null, publicationTimeZone: null,
        publishedAt: status === OUTFIT_STATUS.published ? new Date() : null,
        updatedAt: new Date()
      })
      .where(eq(outfits.id, outfitId))
      .returning();
    return row;
  }

  async updateTotals(outfitId: string, totalPriceMin: number, totalPriceMax: number): Promise<Outfit> {
    const [row] = await this.database.db
      .update(outfits)
      .set({ totalPriceMin, totalPriceMax, updatedAt: new Date() })
      .where(eq(outfits.id, outfitId))
      .returning();
    return row;
  }

  async findPublishedPage(input: PublicOutfitPage): Promise<OutfitDetail[]> {
    return this.database.db.transaction(async tx => {
      const rows = await tx.select().from(outfits).where(and(publicOutfitVisibility({db: tx}), publicOutfitDiscovery({db: tx}, input),
        input.creatorId ? eq(outfits.creatorId, input.creatorId) : undefined, input.brandId ? eq(outfits.brandId, input.brandId) : undefined,
        input.productBrandId ? exists(tx.select({id: outfitItems.id}).from(outfitItems)
          .innerJoin(products, eq(products.id, outfitItems.productId))
          .where(and(eq(outfitItems.outfitId, outfits.id), eq(products.brandId, input.productBrandId)))) : undefined,
        input.cursor ? lt(outfits.id, input.cursor) : undefined)).orderBy(desc(outfits.id)).limit(input.limit);
      return this.loadDetails(rows, {db: tx});
    }, READ_SNAPSHOT);
  }

  async findBrandIntegrationPieces(brandId: string, outfitIds: string[]) {
    if (!outfitIds.length) return [];
    return this.database.db.select({outfitId: outfitItems.outfitId, itemId: outfitItems.id,
      productId: products.id, name: products.name, productStatus: products.status})
      .from(outfitItems).innerJoin(products, eq(products.id, outfitItems.productId))
      .where(and(eq(products.brandId, brandId), inArray(outfitItems.outfitId, outfitIds)))
      .orderBy(outfitItems.outfitId, outfitItems.position, outfitItems.id);
  }
}

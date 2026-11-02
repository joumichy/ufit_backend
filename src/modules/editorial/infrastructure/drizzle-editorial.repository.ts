import {createHash} from 'node:crypto';
import {BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException} from '@nestjs/common';
import {and, desc, eq, exists, gt, inArray, isNotNull, lt, or, sql} from 'drizzle-orm';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT, type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {brandProfiles, editorialCollectionChanges, editorialCollectionItems as items, editorialCollections as collections,
  outfits, productImages, products, userRoles, users} from '../../../shared/infrastructure/database/schema';
import {publicOutfitVisibility} from '../../outfits/infrastructure/public-outfit-visibility';
import {z} from 'zod';
import {EDITORIAL as E, editorialCursorSchema, editorialListCursorSchema, type EditorialListCursor, type EditorialCursor, type EditorialItemsPage, type EditorialManagedPage,
  type EditorialPage} from '../domain/editorial.contract';
import type {EditorialCollection, EditorialCollectionDetail, EditorialCollectionItem, EditorialCommand, EditorialPublicCollection,
  EditorialPublicItem, EditorialReceipt, EditorialRepository} from '../domain/editorial.types';
const L = E.limits;

@Injectable()
export class DrizzleEditorialRepository implements EditorialRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  write(command: EditorialCommand): Promise<EditorialReceipt> {
    const fingerprint = createHash(E.digest.algorithm).update(JSON.stringify({kind: command.kind, collectionId: command.collectionId,
      expectedVersion: command.expectedVersion, fields: command.fields ?? null})).digest(E.digest.encoding);
    return this.database.db.transaction(async db => {
      const database = {db};
      await requireAdmin(database, command.actorId, true);
      // A request identity serializes creation as well as replay across collections.
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${command.requestId}, ${L.zero}))`);
      const [prior] = await db.select().from(editorialCollectionChanges).where(eq(editorialCollectionChanges.requestId, command.requestId)).limit(L.one);
      if (prior) {
        if (prior.actorId !== command.actorId || prior.fingerprint !== fingerprint) throw new ConflictException(E.failure.request);
        return receipt(prior);
      }
      const now = new Date();
      let saved: EditorialCollection;
      if (command.kind === E.command.create) {
        if (command.collectionId !== null || command.expectedVersion !== L.zero || !command.fields) throw new BadRequestException(E.failure.input);
        await requireReferences(database, command.fields.items);
        const {items: entries, ...fields} = command.fields;
        [saved] = await db.insert(collections).values({...fields, createdBy: command.actorId, version: L.one,
          status: E.status.draft, publishedAt: null, createdAt: now, updatedAt: now}).returning();
        await replaceItems(database, saved.id, entries);
      } else {
        if (command.collectionId === null) throw new BadRequestException(E.failure.input);
        const previous = await collection(database, command.collectionId, true);
        if (previous.version !== command.expectedVersion || previous.version >= L.versionMax) throw new ConflictException(E.failure.changed);
        let nextStatus = previous.status;
        if (command.kind === E.command.edit) {
          if (previous.status === E.status.archived || !command.fields) throw new ConflictException(E.failure.state);
          await requireReferences(database, command.fields.items);
          const {items: entries, ...fields} = command.fields;
          await db.update(collections).set(fields).where(eq(collections.id, previous.id));
          await replaceItems(database, previous.id, entries);
          nextStatus = E.status.draft;
        } else if (command.kind === E.command.publish) {
          if (previous.status !== E.status.draft) throw new ConflictException(E.failure.state);
          const entries = await readItems(database, previous.id, false);
          if (!entries.length || entries.some(item => !item.available)) throw new BadRequestException(E.failure.publish);
          nextStatus = E.status.published;
        } else if (command.kind === E.command.archive) {
          if (previous.status === E.status.archived) throw new ConflictException(E.failure.state);
          nextStatus = E.status.archived;
        } else if (command.kind === E.command.restore) {
          if (previous.status !== E.status.archived) throw new ConflictException(E.failure.state);
          nextStatus = E.status.draft;
        } else throw new BadRequestException(E.failure.input);
        [saved] = await db.update(collections).set({status: nextStatus, version: previous.version + L.one, updatedAt: now,
          publishedAt: command.kind === E.command.publish ? now : previous.publishedAt}).where(eq(collections.id, previous.id)).returning();
      }
      const result = {requestId: command.requestId, collectionId: saved.id, version: saved.version, status: saved.status};
      await db.insert(editorialCollectionChanges).values({...result, actorId: command.actorId, fingerprint,
        kind: command.kind, expectedVersion: command.expectedVersion, createdAt: now});
      return result;
    });
  }
  change(actorId: string, requestId: string) {
    return this.database.db.transaction(async db => {
      const database = {db}; await requireAdmin(database, actorId, false);
      const [row] = await db.select().from(editorialCollectionChanges)
        .where(and(eq(editorialCollectionChanges.actorId, actorId), eq(editorialCollectionChanges.requestId, requestId))).limit(L.one);
      return {receipt: row ? receipt(row) : null, current: row ? await managedDetail(database, row.collectionId) : null};
    }, READ_SNAPSHOT);
  }
  managed(actorId: string, collectionId: string) {
    return this.database.db.transaction(async db => {
      const database = {db}; await requireAdmin(database, actorId, false); return managedDetail(database, collectionId);
    }, READ_SNAPSHOT);
  }
  managedPage(actorId: string, input: EditorialManagedPage) {
    return this.database.db.transaction(async db => {
      await requireAdmin({db}, actorId, false);
      const rows = await db.select().from(collections).where(and(input.status ? eq(collections.status, input.status) : undefined,
        input.cursor ? lt(collections.id, input.cursor) : undefined)).orderBy(desc(collections.id)).limit(input.limit + L.one);
      return page(rows, input.limit);
    }, READ_SNAPSHOT);
  }
  publicPage(input: EditorialPage) {
    const cursor = input.cursor ? decodeCursor(editorialListCursorSchema, input.cursor) : null;
    return this.database.db.transaction(async db => {
      const database = {db};
      const rows = await db.select({collection: collections, publishedAtKey: sql<string>`to_char(${collections.publishedAt} at time zone ${E.timestamp.zone}, ${E.timestamp.format})`}).from(collections).where(and(publicCollection(database), cursor
        ? or(lt(collections.publishedAt, sql`${cursor.publishedAt}::timestamptz`),
          and(eq(collections.publishedAt, sql`${cursor.publishedAt}::timestamptz`), lt(collections.id, cursor.id))) : undefined))
        .orderBy(desc(collections.publishedAt), desc(collections.id)).limit(input.limit + L.one);
      const selected = rows.slice(L.zero, input.limit), last = selected.at(-L.one), projected: EditorialPublicCollection[] = [];
      for (const row of selected) projected.push(await publicSummary(database, row.collection));
      return {items: projected, nextCursor: rows.length > input.limit && last
        ? encodeCursor({publishedAt: last.publishedAtKey, id: last.collection.id}) : null};
    }, READ_SNAPSHOT);
  }
  publicDetail(collectionId: string) {
    return this.database.db.transaction(async db => publicDetail({db}, collectionId), READ_SNAPSHOT);
  }
  publicItems(collectionId: string, input: EditorialItemsPage) {
    const cursor = input.cursor ? decodeCursor(editorialCursorSchema, input.cursor) : null;
    if (cursor && (cursor.collectionId !== collectionId || cursor.version !== input.version)) throw new BadRequestException(E.failure.page);
    return this.database.db.transaction(async db => {
      const database = {db}, detail = await publicDetail(database, collectionId);
      if (detail.version !== input.version) throw new ConflictException(E.failure.changed);
      const rows = await readItems(database, collectionId, true, {limit: input.limit + L.one, cursor});
      const selected = rows.slice(L.zero, input.limit), last = selected.at(-L.one);
      return {items: selected.map(publicItem), nextCursor: rows.length > input.limit && last
        ? encodeCursor({collectionId, version: detail.version, position: last.position, id: last.id}) : null};
    }, READ_SNAPSHOT);
  }
}
function receipt(row: EditorialReceipt): EditorialReceipt {
  return {requestId: row.requestId, collectionId: row.collectionId, version: row.version, status: row.status};
}
function page<T extends {id: string}>(rows: T[], limit: number) {
  const selected = rows.slice(L.zero, limit), last = selected.at(-L.one);
  return {items: selected, nextCursor: rows.length > limit && last ? last.id : null};
}
async function requireAdmin(database: DatabaseSession, id: string, lock: boolean) {
  const query = database.db.select().from(users).where(eq(users.id, id)).limit(L.one);
  const [actor] = lock ? await query.for(E.lock.read) : await query;
  if (actor?.status !== E.active) throw new ForbiddenException(E.failure.forbidden);
  const roles = await database.db.select().from(userRoles).where(and(eq(userRoles.userId, id), inArray(userRoles.role, [...E.roles])));
  if (!roles.length) throw new ForbiddenException(E.failure.forbidden);
}
async function collection(database: DatabaseSession, id: string, lock = false): Promise<EditorialCollection> {
  const query = database.db.select().from(collections).where(eq(collections.id, id)).limit(L.one);
  const [row] = lock ? await query.for(E.lock.write) : await query;
  if (!row) throw new NotFoundException(E.failure.missing);
  return row;
}
async function managedDetail(database: DatabaseSession, id: string): Promise<EditorialCollectionDetail> {
  return {collection: await collection(database, id), items: await readItems(database, id, false)};
}
function publicItemCondition(database: DatabaseSession) {
  const outfit = database.db.select({id: outfits.id}).from(outfits).where(and(eq(outfits.id, items.outfitId), publicOutfitVisibility(database)));
  const product = database.db.select({id: products.id}).from(products).innerJoin(brandProfiles, eq(brandProfiles.id, products.brandId))
    .where(and(eq(products.id, items.productId), eq(products.status, E.active), eq(brandProfiles.status, E.active)));
  return or(and(eq(items.itemType, E.item.outfit), exists(outfit)), and(eq(items.itemType, E.item.product), exists(product)))!;
}
function publicCollection(database: DatabaseSession) {
  const visible = database.db.select({id: items.id}).from(items).where(and(eq(items.collectionId, collections.id), publicItemCondition(database)));
  return and(eq(collections.status, E.status.published), isNotNull(collections.publishedAt), exists(visible));
}
async function publicDetail(database: DatabaseSession, id: string) {
  const [row] = await database.db.select().from(collections).where(and(eq(collections.id, id), publicCollection(database))).limit(L.one);
  if (!row) throw new NotFoundException(E.failure.missing);
  return publicSummary(database, row);
}
async function publicSummary(database: DatabaseSession, row: EditorialCollection): Promise<EditorialPublicCollection> {
  const [count] = await database.db.select({value: sql<number>`count(*)::int`}).from(items)
    .where(and(eq(items.collectionId, row.id), publicItemCondition(database)));
  // With no explicit cover, use only the first currently public reference.
  const first = row.coverImageUrl === null ? (await readItems(database, row.id, true, {limit: L.one, cursor: null})).at(L.zero) : null;
  return {id: row.id, version: row.version, title: row.title, subtitle: row.subtitle, description: row.description,
    coverImageUrl: row.coverImageUrl === null ? first?.imageUrl ?? null : row.coverImageUrl, itemCount: count.value};
}
async function readItems(database: DatabaseSession, id: string, publicOnly: boolean, paging?: {limit: number; cursor: EditorialCursor | null}): Promise<EditorialCollectionItem[]> {
  const cursor = paging?.cursor;
  const productImage = database.db.select({url: productImages.url}).from(productImages).where(eq(productImages.productId, items.productId))
    .orderBy(productImages.position, productImages.id).limit(L.one);
  const query = database.db.select({id: items.id, collectionId: items.collectionId, itemType: items.itemType,
    outfitId: items.outfitId, productId: items.productId, position: items.position,
    title: sql<string>`case when ${items.itemType}=${E.item.outfit} then ${outfits.title} else ${products.name} end`,
    imageUrl: sql<string | null>`case when ${items.itemType}=${E.item.outfit} then ${outfits.coverImageUrl} else (${productImage}) end`,
    available: sql<boolean>`${publicItemCondition(database)}`,
  }).from(items).leftJoin(outfits, eq(outfits.id, items.outfitId)).leftJoin(products, eq(products.id, items.productId))
    .where(and(eq(items.collectionId, id), publicOnly ? publicItemCondition(database) : undefined,
      cursor ? or(gt(items.position, cursor.position), and(eq(items.position, cursor.position), gt(items.id, cursor.id))) : undefined))
    .orderBy(items.position, items.id);
  return paging ? query.limit(paging.limit) : query;
}
function publicItem(item: EditorialCollectionItem): EditorialPublicItem {
  const contentId = item.itemType === E.item.outfit ? item.outfitId : item.productId;
  if (contentId === null) throw new BadRequestException(E.failure.references);
  return {id: item.id, itemType: item.itemType, contentId, position: item.position, title: item.title, imageUrl: item.imageUrl};
}
async function requireReferences(database: DatabaseSession, entries: NonNullable<EditorialCommand['fields']>['items']) {
  const outfitIds = entries.flatMap(item => item.itemType === E.item.outfit ? [item.outfitId] : []);
  const productIds = entries.flatMap(item => item.itemType === E.item.product ? [item.productId] : []);
  const outfitRows = outfitIds.length ? await database.db.select({id: outfits.id}).from(outfits).where(inArray(outfits.id, outfitIds)).for(E.lock.read) : [];
  const productRows = productIds.length ? await database.db.select({id: products.id}).from(products).where(inArray(products.id, productIds)).for(E.lock.read) : [];
  if (outfitRows.length !== outfitIds.length || productRows.length !== productIds.length) throw new BadRequestException(E.failure.references);
}
async function replaceItems(database: DatabaseSession, collectionId: string, entries: NonNullable<EditorialCommand['fields']>['items']) {
  await database.db.delete(items).where(eq(items.collectionId, collectionId));
  if (entries.length) await database.db.insert(items).values(entries.map(item => ({collectionId, position: item.position, itemType: item.itemType,
    outfitId: item.itemType === E.item.outfit ? item.outfitId : null, productId: item.itemType === E.item.product ? item.productId : null})));
}
function encodeCursor(cursor: EditorialCursor | EditorialListCursor) {
  return Buffer.from(JSON.stringify(cursor), E.cursor.payloadEncoding).toString(E.cursor.encoding);
}
function decodeCursor<T extends z.ZodType<EditorialCursor | EditorialListCursor>>(schema: T, raw: string): z.infer<T> {
  try {
    const decoded = schema.parse(JSON.parse(Buffer.from(raw, E.cursor.encoding).toString(E.cursor.payloadEncoding)));
    if (encodeCursor(decoded) !== raw) throw new BadRequestException(E.failure.page);
    return decoded;
  } catch { throw new BadRequestException(E.failure.page); }
}

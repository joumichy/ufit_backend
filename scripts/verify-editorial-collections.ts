import 'reflect-metadata';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {and, eq, sql} from 'drizzle-orm';
import {HttpException} from '@nestjs/common';
import {getEnv} from '../src/config/env';
import {buildPgSslConfig} from '../src/shared/infrastructure/database/pg-ssl';
import {quoteIdentifier} from '../src/shared/infrastructure/database/quote-identifier';
import * as schema from '../src/shared/infrastructure/database/schema';
import {EDITORIAL as E, type EditorialFields} from '../src/modules/editorial/domain/editorial.contract';
import {EditorialService} from '../src/modules/editorial/application/editorial.service';
import {DrizzleEditorialRepository} from '../src/modules/editorial/infrastructure/drizzle-editorial.repository';
const P = {
  profile: {node: 'development', port: 4014, schema: 'ufit', stripe: 'sk_test_'},
  rows: 21, totalItems: 23, first: 0, second: 1, third: 2, page: 20, remainder: 3,
  timestamp: {base: '2026-01-01T00:00:00.123000Z', step: '1 microsecond'},
  domain: '@example.invalid', title: 'Editorial rollback qualification', image: 'https://cdn.example.invalid/editorial.jpg',
  description: 'Silhouettes pour vérifier les frontières publiques.', category: 'top', currency: 'CHF', price: 9000,
  role: 'customer', private: 'private', public: 'public', published: 'published', draft: 'draft', paused: 'paused', suspended: 'suspended',
  product: 'product', outfit: 'outfit',
  code: {invalid: 400, forbidden: 403, missing: 404, conflict: 409},
  cases: {draft: 'draft_is_private_and_creation_atomic', publish: 'publication_receipt_and_mixed_references',
    firstPage: 'first_page_of_20', secondPage: 'remaining_3', pages: 'ordered_20_plus_3_and_scoped_cursor', anchor: 'deleted_anchor_does_not_break_paging',
    hidden: 'draft_private_and_inactive_product_filtered_before_paging', author: 'suspended_creator_hidden',
    brand: 'paused_brand_products_hidden', all: 'entirely_hidden_collection_is_not_public',
    unready: 'publication_rejects_unavailable_references', archive: 'archive_and_restore_are_reversible',
    edit: 'editing_published_returns_to_draft_with_order_preserved', stale: 'stale_collection_version_conflicts',
    replay: 'old_receipt_remains_immutable_after_later_commands', reuse: 'request_reuse_and_actor_replay_conflict',
    missing: 'missing_request_has_no_invented_current_document', role: 'unprivileged_and_suspended_admin_refused',
    invalid: 'invalid_references_do_not_create_partial_collection', list: 'public_and_managed_pagination_20_plus_remainder',
    cursor: 'stale_version_cursor_rejected', constraints: 'database_reference_position_and_receipt_constraints'},
  sql: {tables: "select table_name from information_schema.tables where table_schema=$1 and table_type='BASE TABLE' order by table_name",
    digest: "select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) digest from ", alias: ' t', dot: '.'},
  diagnostics: '/tmp/ufit-editorial-verification-diagnostic.json', failure: 'Editorial verification failed; transaction rolled back.',
} as const;
const checks: string[] = [];
class Rollback extends Error {}
async function verify() {
  const env = getEnv();
  assert(env.NODE_ENV === P.profile.node && env.API_PORT === P.profile.port && env.UFIT_DB_SCHEMA === P.profile.schema &&
    env.STRIPE_SECRET_KEY?.startsWith(P.profile.stripe) && !env.NOTIFICATION_PUSH_ENABLED && !env.NOTIFICATION_EMAIL_ENABLED);
  const pool = new Pool({connectionString: env.SUPABASE_DIRECT_CONNECTION_DB_URL, ssl: buildPgSslConfig(env), max: E.limits.one});
  const client = await pool.connect(), database = drizzle(client, {schema});
  const tables = (await client.query<{table_name: string}>(P.sql.tables, [env.UFIT_DB_SCHEMA])).rows.map(row => row.table_name);
  const fingerprint = async (table: string) => (await client.query(P.sql.digest + quoteIdentifier(env.UFIT_DB_SCHEMA) + P.sql.dot + quoteIdentifier(table) + P.sql.alias)).rows[P.first].digest;
  const before = new Map<string, string>();
  try {
    for (const table of tables) before.set(table, await fingerprint(table));
    try {
      await database.transaction(async db => {
        const actors = await db.insert(schema.users).values(Array.from({length: P.remainder}, () => ({supabaseUserId: randomUUID(),
          email: randomUUID() + P.domain, status: E.active}))).returning();
        const [actor, other, customer] = actors;
        await db.insert(schema.userRoles).values([{userId: actor.id, role: E.roles[P.first]}, {userId: other.id, role: E.roles[P.second]}, {userId: customer.id, role: P.role}]);
        const [brand] = await db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.status, E.active)).limit(E.limits.one);
        const [creator] = await db.select({id: schema.creatorProfiles.id, userId: schema.creatorProfiles.userId}).from(schema.creatorProfiles)
          .innerJoin(schema.users, eq(schema.users.id, schema.creatorProfiles.userId)).where(and(eq(schema.creatorProfiles.status, E.active), eq(schema.users.status, E.active))).limit(E.limits.one);
        assert(brand && creator);
        const outfits = await db.insert(schema.outfits).values(Array.from({length: P.rows}, () => ({creatorId: creator.id,
          title: P.title, description: P.description, coverImageUrl: P.image, status: P.published, visibility: P.public}))).returning();
        const products = await db.insert(schema.products).values(Array.from({length: P.third}, () => ({brandId: brand.id, name: P.title,
          slug: randomUUID(), description: P.description, category: P.category, basePrice: P.price, currency: P.currency, status: E.active}))).returning();
        await db.insert(schema.productImages).values(products.map(product => ({productId: product.id, url: P.image, position: P.first, kind: P.product})));
        const fields: EditorialFields = {title: P.title, subtitle: null, description: P.description, coverImageUrl: null,
          items: [...outfits.map((outfit, position) => ({itemType: E.item.outfit, outfitId: outfit.id, position})),
            ...products.map((product, index) => ({itemType: E.item.product, productId: product.id, position: outfits.length + index}))]};
        const repository = new DrizzleEditorialRepository({db}), service = new EditorialService(repository);
        const create = {requestId: randomUUID(), expectedVersion: E.limits.zero, fields};
        const created = await service.createCollection(actor.id, create), id = created.collectionId;
        assert.equal(created.version, E.limits.one); assert.equal(created.status, E.status.draft);
        assert.equal((await service.managed(actor.id, id)).items.length, P.totalItems);
        await rejected(() => service.getPublicDetail(id), P.code.missing); checks.push(P.cases.draft);
        const publish = {requestId: randomUUID(), expectedVersion: created.version};
        const published = await service.transition(actor.id, id, E.command.publish, publish);
        const summary = await service.getPublicDetail(id);
        assert.equal(summary.itemCount, P.totalItems); assert.equal(summary.coverImageUrl, P.image);
        assert.deepEqual(Object.keys(summary).sort(), K.publicKeys); checks.push(P.cases.publish);
        const first = await service.getPublicItems(id, {version: summary.version, limit: P.page});
        assert.equal(first.items.length, P.page); assert(first.nextCursor); checks.push(P.cases.firstPage);
        assert.deepEqual(first.items.map(item => item.position), Array.from({length: P.page}, (_, index) => index));
        const second = await service.getPublicItems(id, {version: summary.version, limit: P.page, cursor: first.nextCursor});
        assert.equal(second.items.length, P.remainder); assert.equal(second.nextCursor, null); checks.push(P.cases.secondPage);
        assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, P.totalItems);
        await rejected(() => service.getPublicItems(randomUUID(), {version: summary.version, cursor: first.nextCursor}), P.code.invalid);
        await rejected(() => service.getPublicItems(id, {version: summary.version, cursor: K.malformedCursor}), P.code.invalid); checks.push(P.cases.pages);
        await db.delete(schema.outfits).where(eq(schema.outfits.id, outfits[P.page - E.limits.one].id));
        assert.deepEqual((await service.getPublicItems(id, {version: summary.version, limit: P.page, cursor: first.nextCursor})).items, second.items); checks.push(P.cases.anchor);
        await db.update(schema.outfits).set({status: P.draft}).where(eq(schema.outfits.id, outfits[P.first].id));
        await db.update(schema.outfits).set({visibility: P.private}).where(eq(schema.outfits.id, outfits[P.second].id));
        await db.update(schema.products).set({status: P.draft}).where(eq(schema.products.id, products[P.second].id));
        const visible = await service.getPublicItems(id, {version: summary.version});
        assert.equal(visible.items.length, P.totalItems - P.remainder - E.limits.one);
        assert(!visible.items.some(item => [outfits[P.first].id, outfits[P.second].id, products[P.second].id].includes(item.contentId)));
        assert(visible.items.some(item => item.contentId === products[P.first].id)); checks.push(P.cases.hidden);
        await db.update(schema.users).set({status: P.suspended}).where(eq(schema.users.id, creator.userId));
        assert.equal((await service.getPublicDetail(id)).itemCount, E.limits.one); checks.push(P.cases.author);
        await db.update(schema.brandProfiles).set({status: P.paused}).where(eq(schema.brandProfiles.id, brand.id));
        await rejected(() => service.getPublicDetail(id), P.code.missing); checks.push(P.cases.all);
        await db.update(schema.users).set({status: E.active}).where(eq(schema.users.id, creator.userId));
        const brandHidden = await service.getPublicItems(id, {version: summary.version});
        assert(!brandHidden.items.some(item => item.itemType === E.item.product)); checks.push(P.cases.brand);
        await db.update(schema.brandProfiles).set({status: E.active}).where(eq(schema.brandProfiles.id, brand.id));
        const archived = await service.transition(actor.id, id, E.command.archive, {requestId: randomUUID(), expectedVersion: published.version});
        await rejected(() => service.getPublicDetail(id), P.code.missing);
        const restored = await service.transition(actor.id, id, E.command.restore, {requestId: randomUUID(), expectedVersion: archived.version});
        assert.equal(restored.status, E.status.draft); checks.push(P.cases.archive);
        await rejected(() => service.transition(actor.id, id, E.command.publish, {requestId: randomUUID(), expectedVersion: restored.version}), P.code.invalid); checks.push(P.cases.unready);
        const validFields: EditorialFields = {...fields, items: [{itemType: E.item.product, productId: products[P.first].id, position: P.first},
          {itemType: E.item.outfit, outfitId: outfits[P.third].id, position: P.second}]};
        const edited = await service.editCollection(actor.id, id, {requestId: randomUUID(), expectedVersion: restored.version, fields: validFields});
        const republished = await service.transition(actor.id, id, E.command.publish, {requestId: randomUUID(), expectedVersion: edited.version});
        const final = await service.editCollection(actor.id, id, {requestId: randomUUID(), expectedVersion: republished.version, fields: validFields});
        assert.equal(final.status, E.status.draft); await rejected(() => service.getPublicDetail(id), P.code.missing);
        assert.deepEqual((await service.managed(actor.id, id)).items.map(item => item.position), [P.first, P.second]); checks.push(P.cases.edit);
        await rejected(() => service.editCollection(actor.id, id, {requestId: randomUUID(), expectedVersion: restored.version, fields: validFields}), P.code.conflict); checks.push(P.cases.stale);
        assert.deepEqual(await service.createCollection(actor.id, create), created);
        assert.deepEqual(await service.transition(actor.id, id, E.command.publish, publish), published);
        const recovered = await service.change(actor.id, publish.requestId); assert.deepEqual(recovered.receipt, published);
        assert.equal(recovered.current?.collection.version, final.version); checks.push(P.cases.replay);
        await rejected(() => service.createCollection(actor.id, {...create, fields: validFields}), P.code.conflict);
        await rejected(() => service.createCollection(other.id, create), P.code.conflict); checks.push(P.cases.reuse);
        assert.deepEqual(await service.change(actor.id, randomUUID()), {receipt: null, current: null});
        assert.deepEqual(await service.change(other.id, publish.requestId), {receipt: null, current: null}); checks.push(P.cases.missing);
        await rejected(() => service.managed(customer.id, id), P.code.forbidden);
        await db.update(schema.users).set({status: P.suspended}).where(eq(schema.users.id, actor.id));
        await rejected(() => service.createCollection(actor.id, create), P.code.forbidden);
        await rejected(() => service.change(actor.id, publish.requestId), P.code.forbidden);
        await db.update(schema.users).set({status: E.active}).where(eq(schema.users.id, actor.id)); checks.push(P.cases.role);
        const countBefore = (await db.select({count: sql<number>`count(*)::int`}).from(schema.editorialCollections))[P.first].count;
        await rejected(() => service.createCollection(actor.id, {...create, requestId: randomUUID(), fields: {...fields, items: [{itemType: E.item.outfit, outfitId: randomUUID(), position: P.first}]}}), P.code.invalid);
        const countAfter = (await db.select({count: sql<number>`count(*)::int`}).from(schema.editorialCollections))[P.first].count;
        assert.equal(countBefore, countAfter); checks.push(P.cases.invalid);
        const list = await db.insert(schema.editorialCollections).values(Array.from({length: P.rows}, (_, index) => ({title: P.title, description: P.description,
          status: E.status.published, createdBy: actor.id, publishedAt: sql`${P.timestamp.base}::timestamptz + ${index} * ${P.timestamp.step}::interval`}))).returning();
        await db.insert(schema.editorialCollectionItems).values(list.map(row => ({collectionId: row.id, itemType: E.item.product, productId: products[P.first].id, position: P.first})));
        const pageOne = await service.getPublicCollections({limit: P.page}); assert.equal(pageOne.items.length, P.page); assert(pageOne.nextCursor);
        const pageTwo = await service.getPublicCollections({limit: P.page, cursor: pageOne.nextCursor}); assert.equal(pageTwo.items.length, E.limits.one); assert.equal(pageTwo.nextCursor, null);
        assert.deepEqual([...pageOne.items, ...pageTwo.items].map(row => row.id), [...list].reverse().map(row => row.id));
        const managed = await service.managedPage(actor.id, {limit: P.page}); assert.equal(managed.items.length, P.page); assert(managed.nextCursor);
        assert.equal((await service.managedPage(actor.id, {limit: P.page, cursor: managed.nextCursor})).items.length, countBefore + P.rows - P.page); checks.push(P.cases.list);
        const changedVersion = await service.transition(actor.id, id, E.command.publish, {requestId: randomUUID(), expectedVersion: final.version});
        await rejected(() => service.getPublicItems(id, {version: summary.version}), P.code.conflict);
        await rejected(() => service.getPublicItems(id, {version: changedVersion.version, cursor: first.nextCursor}), P.code.invalid); checks.push(P.cases.cursor);
        const entry = {collectionId: id, itemType: E.item.outfit, outfitId: outfits[P.third].id, position: P.third};
        await assert.rejects(() => db.transaction(async child => child.insert(schema.editorialCollectionItems).values({...entry, productId: products[P.first].id})));
        await assert.rejects(() => db.transaction(async child => child.insert(schema.editorialCollectionItems).values({...entry, position: -E.limits.one})));
        await assert.rejects(() => db.transaction(async child => child.insert(schema.editorialCollectionItems).values({...entry, outfitId: outfits[P.first].id, position: P.first})));
        await assert.rejects(() => db.transaction(async child => child.insert(schema.editorialCollectionItems).values(entry)));
        await assert.rejects(() => db.transaction(async child => child.insert(schema.editorialCollectionChanges).values({requestId: randomUUID(), collectionId: id, actorId: actor.id,
          kind: E.command.edit, fingerprint: createHash(E.digest.algorithm).update(P.title).digest(E.digest.encoding), expectedVersion: E.limits.one, version: E.limits.one,
          status: E.status.draft, createdAt: new Date()})));
        checks.push(P.cases.constraints);
        throw new Rollback();
      });
    } catch (error) { if (!(error instanceof Rollback)) throw error; }
    for (const table of tables) assert.equal(await fingerprint(table), before.get(table), table);
    console.log(JSON.stringify({checks, passed: checks.length, tablesPreserved: tables.length, persistedQualificationRows: E.limits.zero}));
  } finally {client.release(); await pool.end();}
}
async function rejected(work: () => Promise<unknown>, status: number) {
  await assert.rejects(async () => work(), error => error instanceof HttpException && error.getStatus() === status);
}
const K = {publicKeys: ['coverImageUrl', 'description', 'id', 'itemCount', 'subtitle', 'title', 'version'].sort(), malformedCursor: 'invalid'} as const;
verify().catch(async error => {
  await writeFile(P.diagnostics, JSON.stringify({checks, name: error.name, message: error.message, code: error.code,
    cause: error.cause ? {name: error.cause.name, code: error.cause.code, message: error.cause.message} : null}), {mode: 0o600});
  console.error(P.failure); process.exitCode = E.limits.one;
});

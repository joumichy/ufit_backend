import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {eq, sql} from 'drizzle-orm';
import {HttpException} from '@nestjs/common';
import {getEnv} from '../src/config/env';
import {buildPgSslConfig} from '../src/shared/infrastructure/database/pg-ssl';
import {quoteIdentifier} from '../src/shared/infrastructure/database/quote-identifier';
import * as schema from '../src/shared/infrastructure/database/schema';
import {SavedService} from '../src/modules/saved/application/saved.service';
import {DrizzleSavedRepository} from '../src/modules/saved/infrastructure/drizzle-saved.repository';
import {SAVED_OUTFITS as S} from '../src/modules/saved/domain/saved-outfits.contract';
import {DrizzleOutfitRepository} from '../src/modules/outfits/infrastructure/drizzle-outfit.repository';
import {OUTFIT_STATUS, OUTFIT_VISIBILITY} from '../src/modules/outfits/domain/outfit-editing.contract';
import {PROFILE_STATUS} from '../src/shared/domain/profile-editing.contract';
import {USER_ADMINISTRATION} from '../src/modules/identity/domain/user-administration.contract';

const P = {
  profile: {node: 'development', port: 4014, schema: 'ufit', stripe: 'sk_test_'},
  one: 1, two: 2, three: 3, zero: 0, count: 55, maximumPublicRead: 100, missing: 404,
  time: '2026-05-20T11:00:00.123456Z', nextTime: '2026-05-20T11:00:00.123457Z',
  domain: '@example.invalid', copy: 'Saved outfit rollback qualification', image: 'https://example.invalid/qualification.jpg',
  site: 'https://example.invalid',
  failed: 'Saved outfit verification failed; transaction rolled back.',
  diagnostic: '/tmp/ufit-saved-verification.txt',
  checks: {
    pages: 'three_pages_55_distinct_references', precision: 'microseconds_and_tied_timestamps_stable',
    anchor: 'removed_anchor_does_not_break_next_page', replay: 'save_replay_preserves_timestamp',
    removed: 'unsaved_state_is_false', restored: 'save_restores_state', scoped: 'other_account_has_no_references_or_states',
    hidden: 'hidden_profiles_and_private_or_draft_outfits_excluded', refused: 'save_hidden_outfit_refused',
    feed: 'feed_and_saved_visibility_agree', owner: 'creator_user_suspension_hides_saved_outfit',
    resumed: 'reactivated_profile_restores_existing_saved_reference',
  },
  sql: {
    tables: "select table_name from information_schema.tables where table_schema=$1 and table_type='BASE TABLE' order by table_name",
    digest: "select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) digest from ",
    alias: ' t',
    separator: '.',
  },
} as const;
class Rollback extends Error {}

async function verify() {
  const env = getEnv();
  assert(env.NODE_ENV === P.profile.node && env.API_PORT === P.profile.port && env.UFIT_DB_SCHEMA === P.profile.schema &&
    env.STRIPE_SECRET_KEY?.startsWith(P.profile.stripe) && !env.NOTIFICATION_PUSH_ENABLED && !env.NOTIFICATION_EMAIL_ENABLED);
  const pool = new Pool({connectionString: env.SUPABASE_DIRECT_CONNECTION_DB_URL, ssl: buildPgSslConfig(env), max: P.one});
  const client = await pool.connect(), database = drizzle(client, {schema}), cases = new Set<string>();
  const tables = (await client.query<{table_name: string}>(P.sql.tables, [env.UFIT_DB_SCHEMA])).rows.map(row => row.table_name);
  const before = new Map<string, string>();
  async function fingerprint(table: string) {
    return (await client.query(P.sql.digest + quoteIdentifier(env.UFIT_DB_SCHEMA) + P.sql.separator + quoteIdentifier(table) + P.sql.alias)).rows[P.zero].digest as string;
  }
  try {
    for (const table of tables) before.set(table, await fingerprint(table));
    try {
      await database.transaction(async db => {
        const [actor, other, author] = await db.insert(schema.users).values(Array.from({length: P.three}, () => ({
          supabaseUserId: randomUUID(), email: randomUUID() + P.domain, status: USER_ADMINISTRATION.status.active,
        }))).returning(); assert(actor && other && author);
        const [publicApplication] = await db.insert(schema.creatorApplications).values({userId: author.id, email: author.email, displayName: P.copy, motivation: P.copy}).returning();
        const [publicCreator] = await db.insert(schema.creatorProfiles).values({userId: author.id, applicationId: publicApplication.id,
          displayName: P.copy, slug: randomUUID(), status: PROFILE_STATUS.active}).returning();
        const [creatorApplication] = await db.insert(schema.creatorApplications).values({userId: actor.id, email: actor.email, displayName: P.copy, motivation: P.copy}).returning();
        const [brandApplication] = await db.insert(schema.brandApplications).values({userId: actor.id, email: actor.email,
          brandName: P.copy, websiteUrl: P.site, productCategory: P.copy, positioning: P.copy}).returning();
        const [creator] = await db.insert(schema.creatorProfiles).values({userId: actor.id, applicationId: creatorApplication.id,
          displayName: P.copy, slug: randomUUID(), status: PROFILE_STATUS.paused}).returning();
        const [brand] = await db.insert(schema.brandProfiles).values({ownerUserId: actor.id, applicationId: brandApplication.id,
          brandName: P.copy, slug: randomUUID(), status: PROFILE_STATUS.paused}).returning();
        const publicReferences = Array.from({length: P.count}, (_, position) => ({id: randomUUID(), savedAt: position % P.two === P.zero ? P.time : P.nextTime}));
        const hidden = [
          {id: randomUUID(), status: OUTFIT_STATUS.published, visibility: OUTFIT_VISIBILITY.private, creatorId: publicCreator.id},
          {id: randomUUID(), status: OUTFIT_STATUS.draft, visibility: OUTFIT_VISIBILITY.public, creatorId: publicCreator.id},
          {id: randomUUID(), status: OUTFIT_STATUS.published, visibility: OUTFIT_VISIBILITY.public, creatorId: creator.id},
          {id: randomUUID(), status: OUTFIT_STATUS.published, visibility: OUTFIT_VISIBILITY.featured, brandId: brand.id},
        ];
        await db.insert(schema.outfits).values([
          ...publicReferences.map(reference => ({id: reference.id, creatorId: publicCreator.id, title: P.copy, description: P.copy, coverImageUrl: P.image,
            status: OUTFIT_STATUS.published, visibility: OUTFIT_VISIBILITY.public})),
          ...hidden.map(outfit => ({...outfit, title: P.copy, description: P.copy, coverImageUrl: P.image})),
        ]);
        await db.insert(schema.savedOutfits).values([
          ...publicReferences.map(reference => ({userId: actor.id, outfitId: reference.id, createdAt: sql`${reference.savedAt}::timestamptz`})),
          ...hidden.map(outfit => ({userId: actor.id, outfitId: outfit.id, createdAt: sql`${P.time}::timestamptz`})),
        ]);
        const repository = new DrizzleSavedRepository({db}), service = new SavedService(repository);
        const expected = [...publicReferences].sort((left, right) => right.savedAt.localeCompare(left.savedAt) || right.id.localeCompare(left.id));
        const first = await service.listSavedOutfits(actor.id, {}), second = await service.listSavedOutfits(actor.id, {cursor: first.nextCursor}),
          third = await service.listSavedOutfits(actor.id, {cursor: second.nextCursor});
        const all = [...first.items, ...second.items, ...third.items];
        assert.deepEqual(all, expected); assert.equal(new Set(all.map(row => row.id)).size, P.count); assert.equal(third.nextCursor, null);
        cases.add(P.checks.pages); cases.add(P.checks.precision); cases.add(P.checks.hidden);
        const ids = [...hidden.map(row => row.id), first.items[P.zero].id];
        const states = await service.savedOutfitStates(actor.id, {ids: ids.join(S.query.separator)});
        assert.deepEqual(states.items.map(item => item.saved), [...hidden.map(() => false), true]);
        await service.saveOutfit(actor.id, first.items[P.zero].id);
        assert.deepEqual(await service.listSavedOutfits(actor.id, {}), first); cases.add(P.checks.replay);
        const anchor = first.items.at(S.page.last)!;
        await service.unsaveOutfit(actor.id, anchor.id);
        assert.deepEqual(await service.listSavedOutfits(actor.id, {cursor: first.nextCursor}), second); cases.add(P.checks.anchor);
        assert.deepEqual(await service.savedOutfitStates(actor.id, {ids: anchor.id}), {items: [{id: anchor.id, saved: false}]}); cases.add(P.checks.removed);
        await service.saveOutfit(actor.id, anchor.id);
        assert.deepEqual(await service.savedOutfitStates(actor.id, {ids: anchor.id}), {items: [{id: anchor.id, saved: true}]}); cases.add(P.checks.restored);
        assert.deepEqual(await service.listSavedOutfits(other.id, {}), {items: [], nextCursor: null});
        assert((await service.savedOutfitStates(other.id, {ids: ids.join(S.query.separator)})).items.every(item => !item.saved)); cases.add(P.checks.scoped);
        for (const outfit of hidden) await assert.rejects(() => service.saveOutfit(actor.id, outfit.id), error => error instanceof HttpException && error.getStatus() === P.missing);
        cases.add(P.checks.refused);
        const published = await new DrizzleOutfitRepository({db}).findPublishedPage({limit: P.maximumPublicRead});
        assert(hidden.every(outfit => !published.some(row => row.outfit.id === outfit.id)));
        assert(publicReferences.every(reference => published.some(row => row.outfit.id === reference.id))); cases.add(P.checks.feed);
        await db.update(schema.creatorProfiles).set({status: PROFILE_STATUS.active}).where(eq(schema.creatorProfiles.id, creator.id));
        const creatorOutfit = hidden.find(outfit => outfit.creatorId === creator.id)!;
        assert.deepEqual(await service.savedOutfitStates(actor.id, {ids: creatorOutfit.id}), {items: [{id: creatorOutfit.id, saved: true}]}); cases.add(P.checks.resumed);
        await db.update(schema.users).set({status: USER_ADMINISTRATION.status.suspended}).where(eq(schema.users.id, actor.id));
        assert.deepEqual(await repository.findSavedOutfitIDs(other.id, [creatorOutfit.id]), []);
        assert(!(await service.listSavedOutfits(actor.id, {limit: S.page.maximum})).items.some(row => row.id === creatorOutfit.id)); cases.add(P.checks.owner);
        throw new Rollback();
      });
    } catch (error) { if (!(error instanceof Rollback)) throw error; }
    for (const table of tables) assert.equal(await fingerprint(table), before.get(table));
    console.log(JSON.stringify({scenarios: cases.size, cases: [...cases], rolledBack: true, unchangedTables: tables.length, publicReferences: P.count, providerCalls: P.zero}));
  } finally {client.release(); await pool.end();}
}
verify().catch(async error => {
  await writeFile(P.diagnostic, String(error) + String(error?.cause), {mode: 0o600});
  console.error(P.failed); process.exitCode = P.one;
});

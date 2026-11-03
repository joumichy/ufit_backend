import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {eq, inArray} from 'drizzle-orm';
import {BadRequestException, ConflictException, ForbiddenException, NotFoundException} from '@nestjs/common';
import {getEnv} from '../src/config/env';
import {buildPgSslConfig} from '../src/shared/infrastructure/database/pg-ssl';
import * as schema from '../src/shared/infrastructure/database/schema';
import {DrizzleOutfitRepository} from '../src/modules/outfits/infrastructure/drizzle-outfit.repository';
import {DrizzleProductRepository} from '../src/modules/products/infrastructure/drizzle-product.repository';
import {OutfitsService} from '../src/modules/outfits/application/outfits.service';
import {OUTFIT_STATUS as S, OUTFIT_VISIBILITY as V, OUTFIT_EDITING as E} from '../src/modules/outfits/domain/outfit-editing.contract';
import {PROFILE_STATUS} from '../src/shared/domain/profile-editing.contract';
import {USER_ADMINISTRATION as U} from '../src/modules/identity/domain/user-administration.contract';
import type {OutfitActor} from '../src/modules/outfits/domain/outfit.types';
import type {OutfitMediaReader} from '../src/modules/media/domain/outfit-media.types';

const F = {
  profile: {node: 'development', port: 4014, schema: 'ufit', stripe: 'sk_test_'},
  count: 23, page: 20, first: 0, next: 1, remainder: 3, zero: 0, one: 1,
  domain: '@example.invalid', name: 'Publication rollback ', title: 'Publication ', description: 'Calendar transaction qualification',
  site: 'https://example.invalid', memberRole: 'owner', memberRemoved: 'removed',
  image: 'https://example.invalid/publication.jpg', item: 'top', label: 'Inspiration',
  future: '2099-03-29T08:00:00.000Z', later: '2099-03-30T08:00:00.000Z', past: '2000-01-01T00:00:00.000Z',
  from: '2099-03-01T00:00:00.000Z', until: '2099-04-01T00:00:00.000Z', zone: 'Europe/Zurich',
  error: 'Publication SQL verification failed; transaction rolled back.', diagnostic: '/tmp/ufit-publication-sql-error.txt',
  sql: {violation: '23514', constraint: 'outfits_scheduled_private'},
  check: {
    archive: 'archive_restore_does_not_reuse_date',
    brand: 'brand_calendar_uses_current_ownership', revokedMember: 'revoked_brand_member_denied',
    pagination: 'calendar_20_plus_3_and_distinct_ids', scoped: 'calendar_owner_isolation', version: 'schedule_version_conflict',
    review: 'planned_requires_admin_review', private: 'approved_future_stays_private', early: 'no_early_publication',
    due: 'due_publishes_once_with_review_preserved', cancel: 'cancel_returns_private_draft', reschedule: 'reschedule_preserves_approval',
    suspended: 'suspended_author_stays_private', restored: 'reactivated_author_rechecked', edit: 'editing_clears_date_and_approval',
    constraint: 'database_rejects_scheduled_public', rollback: 'qualification_rows_absent_after_rollback',
  },
} as const;
class Rollback extends Error {}
async function verify() {
  const env = getEnv();
  assert(env.NODE_ENV === F.profile.node && env.API_PORT === F.profile.port && env.UFIT_DB_SCHEMA === F.profile.schema &&
    env.STRIPE_SECRET_KEY?.startsWith(F.profile.stripe) && !env.NOTIFICATION_PUSH_ENABLED && !env.NOTIFICATION_EMAIL_ENABLED);
  const pool = new Pool({connectionString: env.SUPABASE_DIRECT_CONNECTION_DB_URL, ssl: buildPgSslConfig(env), max: F.one});
  const client = await pool.connect(), database = drizzle(client, {schema}), checks: string[] = [], ids: string[] = [];
  try {
    try {
      await database.transaction(async db => {
        const key = randomUUID();
        const [user] = await db.insert(schema.users).values({supabaseUserId: randomUUID(), email: key + F.domain, status: U.status.active}).returning();
        await db.insert(schema.userRoles).values({userId: user.id, role: E.roles.creator});
        const [application] = await db.insert(schema.creatorApplications).values({userId: user.id, email: user.email, displayName: F.name + key, motivation: F.description}).returning();
        const [creator] = await db.insert(schema.creatorProfiles).values({userId: user.id, applicationId: application.id,
          displayName: F.name + key, slug: key, status: PROFILE_STATUS.active}).returning();
        const repository = new DrizzleOutfitRepository({db}), products = new DrizzleProductRepository({db});
        const media: OutfitMediaReader = {assetIDs: () => [], resolveImages: async sources => new Map(sources.map(source => [source.url, source.url]))};
        const service = new OutfitsService(repository, products, media);
        const actor: OutfitActor = {id: user.id, roles: [E.roles.creator]}, admin: OutfitActor = {id: user.id, roles: [U.role.admin]};
        const rows = [];
        for (let index = F.zero; index < F.count; index += F.one) {
          const created = await service.createOutfit(actor, {requestId: randomUUID(), creatorId: creator.id,
            title: F.title + index, description: F.description, tagIds: [], images: [{url: F.image, position: F.zero}],
            items: [{itemType: F.item, externalLabel: F.label, position: F.zero, isShoppable: false, isRequired: true}]});
          ids.push(created.id);
          rows.push(await service.planPublication(actor, created.id, {expectedVersion: created.version, scheduledFor: F.future, timeZone: F.zone}));
        }
        const query = {creatorId: creator.id, from: F.from, until: F.until, limit: F.page};
        const first = await service.getPublicationCalendar(actor, query), next = await service.getPublicationCalendar(actor, {...query, cursor: first.nextCursor});
        assert.equal(first.items.length, F.page); assert.equal(next.items.length, F.remainder);
        assert.equal(new Set([...first.items, ...next.items].map(row => row.id)).size, F.count); assert.equal(next.nextCursor, null);
        checks.push(F.check.pagination);
        await assert.rejects(service.getPublicationCalendar({...actor, id: randomUUID()}, query), ForbiddenException); checks.push(F.check.scoped);
        let row = rows[F.first];
        assert.equal(row.status, S.underReview);
        assert.equal(await service.publishScheduledOutfit(row.id, new Date(F.later)), false); checks.push(F.check.review);
        await assert.rejects(service.planPublication(actor, row.id, {expectedVersion: E.versionInitial, scheduledFor: F.later, timeZone: F.zone}), ConflictException);
        checks.push(F.check.version);
        row = await service.reviewOutfit(admin, row.id, {expectedVersion: row.version, decision: S.published});
        assert.equal(row.status, S.scheduled); assert.equal(row.visibility, V.private); assert.equal(row.publishedAt, null);
        await assert.rejects(service.getPublicDetail(row.id), NotFoundException); checks.push(F.check.private);
        const review = row.reviewedAt;
        row = await service.planPublication(actor, row.id, {expectedVersion: row.version, scheduledFor: F.later, timeZone: F.zone});
        assert.equal(row.reviewedAt, review); assert.equal(row.status, S.scheduled); checks.push(F.check.reschedule);
        assert.equal(await service.publishScheduledOutfit(row.id, new Date(F.future)), false); checks.push(F.check.early);
        assert.equal(await service.publishScheduledOutfit(row.id, new Date(F.later)), true);
        const published = await service.getManagedOutfit(actor, row.id);
        assert.equal(published.reviewedAt, review); assert.equal(published.publishedAt, F.later);
        assert.equal(await service.publishScheduledOutfit(row.id, new Date(F.later)), false); checks.push(F.check.due);
        row = rows[F.next];
        row = await service.reviewOutfit(admin, row.id, {expectedVersion: row.version, decision: S.published});
        const cancelled = await service.planPublication(actor, row.id, {expectedVersion: row.version, scheduledFor: null, timeZone: null});
        assert.equal(cancelled.status, S.draft); assert.equal(cancelled.scheduledFor, null); assert.equal(cancelled.reviewedAt, null); checks.push(F.check.cancel);
        row = rows[F.remainder];
        row = await service.reviewOutfit(admin, row.id, {expectedVersion: row.version, decision: S.published});
        await db.update(schema.creatorProfiles).set({status: PROFILE_STATUS.suspended}).where(eq(schema.creatorProfiles.id, creator.id));
        await assert.rejects(service.publishScheduledOutfit(row.id, new Date(F.later)), BadRequestException);
        assert.equal((await repository.findById(row.id))!.outfit.status, S.scheduled); checks.push(F.check.suspended);
        await db.update(schema.creatorProfiles).set({status: PROFILE_STATUS.active}).where(eq(schema.creatorProfiles.id, creator.id));
        assert.equal(await service.publishScheduledOutfit(row.id, new Date(F.later)), true); checks.push(F.check.restored);
        row = rows[F.page];
        row = await service.reviewOutfit(admin, row.id, {expectedVersion: row.version, decision: S.published});
        await assert.rejects(db.transaction(async tx => {
          await tx.update(schema.outfits).set({visibility: V.public}).where(eq(schema.outfits.id, row.id));
        }), error => {
          const cause = (error as {cause?: {code?: string; constraint?: string}}).cause;
          return cause?.code === F.sql.violation && cause.constraint === F.sql.constraint;
        }); checks.push(F.check.constraint);
        const edited = await service.updateOutfit(actor, row.id, {expectedVersion: row.version, title: row.title, description: row.description,
          images: row.images, items: row.items, tagIds: []});
        assert.equal(edited.status, S.draft); assert.equal(edited.scheduledFor, null); assert.equal(edited.reviewedAt, null); checks.push(F.check.edit);
        row = rows[F.page + F.one];
        row = await service.reviewOutfit(admin, row.id, {expectedVersion: row.version, decision: S.published});
        const archived = await service.archiveOutfit(actor, row.id, {expectedVersion: row.version});
        assert.equal(archived.scheduledFor, null); assert.equal(archived.publicationTimeZone, null);
        const restored = await service.restoreOutfit(actor, row.id, {expectedVersion: archived.version});
        assert.equal(restored.scheduledFor, null); assert.equal(restored.status, S.draft);
        const resubmitted = await service.submitOutfit(actor, row.id, {expectedVersion: restored.version});
        const republished = await service.reviewOutfit(admin, row.id, {expectedVersion: resubmitted.version, decision: S.published});
        assert.equal(republished.status, S.published); assert.equal(republished.scheduledFor, null); checks.push(F.check.archive);
        const [brandApplication] = await db.insert(schema.brandApplications).values({userId: user.id, email: user.email,
          brandName: F.name + key, websiteUrl: F.site, productCategory: F.description, positioning: F.description}).returning();
        const [brand] = await db.insert(schema.brandProfiles).values({ownerUserId: user.id, applicationId: brandApplication.id,
          brandName: F.name + key, slug: randomUUID(), status: PROFILE_STATUS.active}).returning();
        const [member] = await db.insert(schema.brandMembers).values({brandProfileId: brand.id, userId: user.id, role: F.memberRole}).returning();
        const brandActor: OutfitActor = {id: user.id, roles: [E.roles.brandOwner]};
        const brandDraft = await service.createOutfit(brandActor, {requestId: randomUUID(), brandId: brand.id, title: F.title + key,
          description: F.description, tagIds: [], images: [{url: F.image, position: F.zero}],
          items: [{itemType: F.item, externalLabel: F.label, position: F.zero, isShoppable: false, isRequired: true}]});
        ids.push(brandDraft.id);
        const brandScheduled = await service.planPublication(brandActor, brandDraft.id, {expectedVersion: brandDraft.version, scheduledFor: F.future, timeZone: F.zone});
        const brandCalendar = await service.getPublicationCalendar(brandActor, {brandId: brand.id, from: F.from, until: F.until});
        assert.deepEqual(brandCalendar.items.map(value => value.id), [brandScheduled.id]); checks.push(F.check.brand);
        await db.update(schema.brandMembers).set({status: F.memberRemoved}).where(eq(schema.brandMembers.id, member.id));
        await assert.rejects(service.getPublicationCalendar(brandActor, {brandId: brand.id, from: F.from, until: F.until}), ForbiddenException);
        checks.push(F.check.revokedMember);
        throw new Rollback();
      });
    } catch (error) { if (!(error instanceof Rollback)) throw error; }
    const remaining = await database.select({id: schema.outfits.id}).from(schema.outfits).where(inArray(schema.outfits.id, ids));
    assert.equal(remaining.length, F.zero); checks.push(F.check.rollback);
    console.log(JSON.stringify({scenarios: checks.length, checks, rolledBack: true, providerCalls: F.zero}));
  } finally { client.release(); await pool.end(); }
}
verify().catch(async error => {
  await writeFile(F.diagnostic, String(error) + String(error?.cause), {mode: 0o600});
  console.error(F.error); process.exitCode = F.one;
});

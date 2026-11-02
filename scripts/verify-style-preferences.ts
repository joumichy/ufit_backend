import 'reflect-metadata';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {eq} from 'drizzle-orm';
import {HttpException} from '@nestjs/common';
import {getEnv} from '../src/config/env';
import {buildPgSslConfig} from '../src/shared/infrastructure/database/pg-ssl';
import {quoteIdentifier} from '../src/shared/infrastructure/database/quote-identifier';
import * as schema from '../src/shared/infrastructure/database/schema';
import {STYLE_PREFERENCES as S} from '../src/modules/identity/domain/style-preferences.contract';
import {DrizzleStylePreferencesRepository} from '../src/modules/identity/infrastructure/persistence/drizzle-style-preferences.repository';
import {DrizzleAccountDeletionRepository} from '../src/modules/identity/infrastructure/persistence/drizzle-account-deletion.repository';
import {ACCOUNT_DELETION as D} from '../src/modules/identity/domain/account-deletion.contract';
import {USER_ADMINISTRATION as U} from '../src/modules/identity/domain/user-administration.contract';
const P = {
  profile: {node: 'development', port: 4014, schema: 'ufit', stripe: 'sk_test_'},
  one: 1, two: 2, domain: '@example.invalid', label: 'Style preference rollback qualification', occasion: 'occasion',
  status: {invalid: 400, forbidden: 403, conflict: 409}, sqlCode: {check: '23514', foreign: '23503', duplicate: '23505'},
  failed: 'Style preference verification failed; transaction rolled back.', diagnostic: '/tmp/ufit-style-verification.txt',
  cases: {empty: 'absent_is_explicit_empty', missing: 'missing_receipt_with_consistent_document', write: 'write_and_receipt',
    replay: 'replay_is_immutable_after_later_change', changed: 'stale_version_rejected', reused: 'request_payload_reuse_rejected',
    invalid: 'unknown_or_occasion_tag_rejected', isolated: 'accounts_and_request_ids_are_isolated',
    suspended: 'suspended_account_cannot_read_write_or_replay', foreign: 'foreign_tag_kind_fenced', kind: 'non_style_kind_fenced',
    duplicate: 'duplicate_selection_fenced', deletion: 'deletion_removes_document_choices_and_receipts',
    late: 'deleted_account_late_insert_fenced'},
  sql: {tables: "select table_name from information_schema.tables where table_schema=$1 and table_type='BASE TABLE' order by table_name",
    digest: "select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) digest from ", alias: ' t', separator: '.'},
} as const;
class Rollback extends Error {}
async function verify() {
  const env = getEnv();
  assert(env.NODE_ENV === P.profile.node && env.API_PORT === P.profile.port && env.UFIT_DB_SCHEMA === P.profile.schema &&
    env.STRIPE_SECRET_KEY?.startsWith(P.profile.stripe) && !env.NOTIFICATION_PUSH_ENABLED && !env.NOTIFICATION_EMAIL_ENABLED);
  const pool = new Pool({connectionString: env.SUPABASE_DIRECT_CONNECTION_DB_URL, ssl: buildPgSslConfig(env), max: P.one});
  const client = await pool.connect(), database = drizzle(client, {schema}), checks: string[] = [];
  const tables = (await client.query<{table_name: string}>(P.sql.tables, [env.UFIT_DB_SCHEMA])).rows.map(row => row.table_name);
  const fingerprint = async (table: string) => (await client.query(P.sql.digest + quoteIdentifier(env.UFIT_DB_SCHEMA) + P.sql.separator + quoteIdentifier(table) + P.sql.alias)).rows[S.version.absent].digest;
  const before = new Map<string, string>();
  try {
    for (const table of tables) before.set(table, await fingerprint(table));
    try {
      await database.transaction(async db => {
        const [actor, other] = await db.insert(schema.users).values(Array.from({length: P.two}, () => ({supabaseUserId: randomUUID(), email: randomUUID() + P.domain, status: U.status.active}))).returning();
        const [first, second, occasion] = await db.insert(schema.tags).values([S.tagType, S.tagType, P.occasion].map(type => ({type, slug: randomUUID(), label: P.label}))).returning();
        const repository = new DrizzleStylePreferencesRepository({db});
        const initial = {userId: actor.id, version: S.version.absent, styleIds: [], updatedAt: null};
        assert.deepEqual(await repository.read(actor.id), initial); checks.push(P.cases.empty);
        assert.deepEqual(await repository.change(actor.id, randomUUID()), {receipt: null, preferences: initial}); checks.push(P.cases.missing);
        const command = {requestId: randomUUID(), expectedVersion: S.version.absent, styleIds: [first.id, second.id].sort()};
        const receipt = await repository.write(actor.id, command); assert.deepEqual(receipt, {requestId: command.requestId, version: S.version.initial});
        const current = await repository.read(actor.id); assert.deepEqual(current.styleIds, command.styleIds); assert(current.updatedAt);
        assert.deepEqual(await repository.change(actor.id, command.requestId), {receipt, preferences: current}); checks.push(P.cases.write);
        const clear = {requestId: randomUUID(), expectedVersion: receipt.version, styleIds: []};
        await repository.write(actor.id, clear);
        assert.deepEqual(await repository.write(actor.id, {...command, styleIds: [...command.styleIds].reverse().map(id => id.toUpperCase())}), receipt);
        const cleared = await repository.read(actor.id); assert.deepEqual(cleared.styleIds, []); assert.equal(cleared.version, P.two);
        assert.deepEqual(await repository.change(actor.id, command.requestId), {receipt, preferences: cleared}); checks.push(P.cases.replay);
        const rejected = async (operation: () => Promise<unknown>, status: number, code: string) => assert.rejects(operation,
          error => error instanceof HttpException && error.getStatus() === status && (error.getResponse() as {code: string}).code === code);
        await rejected(() => repository.write(actor.id, {...command, requestId: randomUUID()}), P.status.conflict, S.failure.changed.code); checks.push(P.cases.changed);
        await rejected(() => repository.write(actor.id, {...command, styleIds: []}), P.status.conflict, S.failure.request.code); checks.push(P.cases.reused);
        for (const tagId of [occasion.id, randomUUID()]) await rejected(() => repository.write(actor.id,
          {requestId: randomUUID(), expectedVersion: cleared.version, styleIds: [tagId]}), P.status.invalid, S.failure.tags.code);
        checks.push(P.cases.invalid);
        assert.deepEqual(await repository.change(other.id, command.requestId), {receipt: null, preferences: {...initial, userId: other.id}});
        assert.deepEqual(await repository.write(other.id, {...command, styleIds: [first.id]}), receipt);
        assert.deepEqual(await repository.read(actor.id), cleared); checks.push(P.cases.isolated);
        await db.update(schema.users).set({status: U.status.suspended}).where(eq(schema.users.id, actor.id));
        for (const operation of [() => repository.read(actor.id), () => repository.write(actor.id, command), () => repository.change(actor.id, command.requestId)]) {
          await rejected(operation, P.status.forbidden, S.failure.unavailable.code);
        }
        checks.push(P.cases.suspended);
        await db.update(schema.users).set({status: U.status.active}).where(eq(schema.users.id, actor.id));
        const constraint = async (name: string, operation: (tx: typeof db) => Promise<unknown>, code: string) => {
          await assert.rejects(() => db.transaction(operation), error => (error as {cause?: {code?: string}}).cause?.code === code); checks.push(name);
        };
        await constraint(P.cases.foreign, tx => tx.insert(schema.preferredStyles).values({userId: actor.id, tagId: occasion.id, tagType: S.tagType}), P.sqlCode.foreign);
        await constraint(P.cases.kind, tx => tx.insert(schema.preferredStyles).values({userId: actor.id, tagId: occasion.id, tagType: P.occasion}), P.sqlCode.check);
        await constraint(P.cases.duplicate, tx => tx.insert(schema.preferredStyles).values({userId: other.id, tagId: first.id, tagType: S.tagType}), P.sqlCode.duplicate);
        await repository.write(actor.id, {requestId: randomUUID(), expectedVersion: cleared.version, styleIds: [second.id]});
        await new DrizzleAccountDeletionRepository({db}).accept(actor.supabaseUserId, randomUUID(), createHash(D.crypto.algorithm).update(randomUUID()).digest(D.crypto.encoding));
        for (const table of [schema.stylePreferences, schema.preferredStyles, schema.stylePreferenceChanges]) {
          assert.equal((await db.select().from(table).where(eq(table.userId, actor.id))).length, S.version.absent);
        }
        checks.push(P.cases.deletion);
        await constraint(P.cases.late, tx => tx.insert(schema.stylePreferences).values({userId: actor.id, version: S.version.initial, updatedAt: new Date()}), P.sqlCode.check);
        throw new Rollback();
      });
    } catch (error) { if (!(error instanceof Rollback)) throw error; }
    for (const table of tables) assert.equal(await fingerprint(table), before.get(table));
    console.log(JSON.stringify({scenarios: checks.length, checks, rolledBack: true, unchangedTables: tables.length, providerCalls: S.version.absent}));
  } finally {client.release(); await pool.end();}
}
verify().catch(async error => {
  await writeFile(P.diagnostic, String(error) + String(error?.cause), {mode: 0o600}); console.error(P.failed); process.exitCode = P.one;
});

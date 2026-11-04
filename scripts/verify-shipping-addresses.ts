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
import {SHIPPING_ADDRESSES as S, type ShippingAddressChange} from '../src/modules/identity/domain/shipping-addresses.contract';
import {ShippingAddressesService} from '../src/modules/identity/application/shipping-addresses.service';
import {DrizzleShippingAddressesRepository} from '../src/modules/identity/infrastructure/persistence/drizzle-shipping-addresses.repository';
import {DrizzleAccountDeletionRepository} from '../src/modules/identity/infrastructure/persistence/drizzle-account-deletion.repository';
import {ACCOUNT_DELETION as D} from '../src/modules/identity/domain/account-deletion.contract';
import {USER_ADMINISTRATION as U} from '../src/modules/identity/domain/user-administration.contract';
const P = {
  profile: {node: 'development', port: 4014, schema: 'ufit', stripe: 'sk_test_'},
  migration: '0051_shipping_address_books.sql', one: 1, two: 2, three: 3, pageCount: 23,
  fullName: 'Adresse de qualification', line: 'Rue de qualification', postal: '1000', city: 'Lausanne', country: 'CH',
  otherCity: 'Genève', domain: '@example.invalid', invalidCountry: 'ZZ', time: '2026-11-04T00:00:00.000Z',
  status: {invalid: 400, forbidden: 403, missing: 404, conflict: 409}, sqlCode: {check: '23514', duplicate: '23505'},
  diagnostic: '/tmp/ufit-shipping-addresses-verification.txt', failed: 'Shipping address verification failed; transaction rolled back.',
  sql: {tables: "select table_name from information_schema.tables where table_schema=$1 and table_type='BASE TABLE' order by table_name",
    digest: "select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) digest from ", alias: ' t', separator: '.'},
} as const;
class Rollback extends Error {}
async function verify() {
  const env = getEnv();
  assert(env.NODE_ENV === P.profile.node && env.API_PORT === P.profile.port && env.UFIT_DB_SCHEMA === P.profile.schema
    && env.STRIPE_SECRET_KEY?.startsWith(P.profile.stripe) && !env.NOTIFICATION_PUSH_ENABLED && !env.NOTIFICATION_EMAIL_ENABLED);
  const pool = new Pool({connectionString: env.SUPABASE_DIRECT_CONNECTION_DB_URL, ssl: buildPgSslConfig(env), max: P.one});
  const client = await pool.connect(), database = drizzle(client, {schema}), checks: string[] = [];
  const tables = (await client.query<{table_name: string}>(P.sql.tables, [env.UFIT_DB_SCHEMA])).rows.map(row => row.table_name);
  const fingerprint = async (table: string) => (await client.query(P.sql.digest + quoteIdentifier(env.UFIT_DB_SCHEMA) + P.sql.separator + quoteIdentifier(table) + P.sql.alias)).rows[S.version.absent].digest;
  const before = new Map<string, string>();
  try {
    const migration = await client.query('select id from ufit.schema_migrations where id=$1', [P.migration]);
    assert.equal(migration.rowCount, P.one, 'Apply the owned additive migration through the project runner first');
    for (const table of tables) before.set(table, await fingerprint(table));
    try {
      await database.transaction(async db => {
        const [actor, other] = await db.insert(schema.users).values(Array.from({length: P.two}, () => ({supabaseUserId: randomUUID(), email: randomUUID() + P.domain, status: U.status.active}))).returning();
        const repository = new DrizzleShippingAddressesRepository({db}), service = new ShippingAddressesService(repository);
        const first = randomUUID(), second = randomUUID(), third = randomUUID();
        const shippingAddress = {fullName: P.fullName, line1: P.line, postalCode: P.postal, city: P.city, country: P.country};
        const initial = {userId: actor.id, version: S.version.absent, defaultAddressId: null, items: [], nextCursor: null};
        const read = (userId = actor.id, query: unknown = {}) => service.list(userId, userId, query);
        const apply = (command: ShippingAddressChange, requestId = randomUUID(), userId = actor.id) => service.apply(userId, userId, requestId, command);
        const rejected = async (operation: () => Promise<unknown>, status: number, code: string) => assert.rejects(async () => operation(),
          error => error instanceof HttpException && error.getStatus() === status && (error.getResponse() as {code: string}).code === code);
        const constraint = async (name: string, operation: (tx: typeof db) => Promise<unknown>, code: string) => {
          await assert.rejects(() => db.transaction(operation), error => (error as {cause?: {code?: string}}).cause?.code === code); checks.push(name);
        };
        assert.deepEqual(await read(), initial); checks.push('empty_book_is_explicit_and_creates_no_default');
        assert.deepEqual(await service.change(actor.id, actor.id, randomUUID()), {receipt: null}); checks.push('missing_receipt_is_explicit');
        const requestId = randomUUID(), command = {action: S.action.save, expectedVersion: S.version.absent, addressId: first, shippingAddress, makeDefault: false} as const;
        const saved = await apply(command, requestId);
        assert.deepEqual(saved, {requestId, action: S.action.save, version: S.version.initial, addressId: first});
        const created = (await read()).items[S.version.absent];
        assert.equal((await read()).defaultAddressId, null); assert.deepEqual(created.shippingAddress, shippingAddress); checks.push('save_without_explicit_default_and_private_projection');
        await apply({action: S.action.save, expectedVersion: saved.version, addressId: second, shippingAddress, makeDefault: true});
        assert.equal((await read()).defaultAddressId, second); checks.push('explicit_default_is_chosen');
        await apply({action: S.action.save, expectedVersion: P.two, addressId: third, shippingAddress, makeDefault: false});
        assert.equal((await read()).defaultAddressId, second); checks.push('later_save_does_not_replace_default');
        assert.deepEqual(await apply(command, requestId), saved);
        assert.deepEqual(await service.change(actor.id, actor.id, requestId), {receipt: saved}); checks.push('lost_response_replays_immutable_receipt_before_cas');
        await rejected(() => apply({...command, makeDefault: true}, requestId), P.status.conflict, S.failure.reused.code); checks.push('same_request_different_payload_rejected');
        await rejected(() => apply(command), P.status.conflict, S.failure.changed.code); checks.push('stale_book_version_rejected');
        const edit = await apply({action: S.action.save, expectedVersion: P.three, addressId: first,
          shippingAddress: {...shippingAddress, line2: P.line, phone: P.line, city: P.otherCity}, makeDefault: false});
        const updated = await service.find(actor.id, actor.id, first);
        assert.equal(updated.createdAt, created.createdAt); assert.equal(updated.shippingAddress.city, P.otherCity); checks.push('edit_preserves_identity_and_creation_time');
        const clear = await apply({action: S.action.setDefault, expectedVersion: edit.version, addressId: null});
        assert.equal(clear.addressId, null); assert.equal((await read()).defaultAddressId, null); checks.push('explicit_clear_default');
        const chosen = await apply({action: S.action.setDefault, expectedVersion: clear.version, addressId: first});
        assert.equal((await read()).defaultAddressId, first); checks.push('choose_existing_address_as_default');
        const deleted = await apply({action: S.action.delete, expectedVersion: chosen.version, addressId: first});
        assert.equal((await read()).defaultAddressId, null);
        await rejected(() => service.find(actor.id, actor.id, first), P.status.missing, S.failure.missing.code); checks.push('deleting_default_leaves_no_implicit_replacement');
        await rejected(() => apply({action: S.action.setDefault, expectedVersion: deleted.version, addressId: randomUUID()}), P.status.missing, S.failure.missing.code);
        assert.equal((await read()).version, deleted.version); checks.push('invalid_target_rolls_back_version_and_default');
        await rejected(() => service.apply(actor.id, actor.id, randomUUID(), {...command, expectedVersion: deleted.version,
          shippingAddress: {...shippingAddress, country: P.invalidCountry}}), P.status.invalid, S.failure.invalid.code); checks.push('canonical_country_rejected_without_writes');
        assert.deepEqual(await service.change(other.id, other.id, requestId), {receipt: null});
        const isolated = await apply(command, requestId, other.id); assert.equal(isolated.version, S.version.initial);
        assert.deepEqual((await read(other.id)).items[S.version.absent].shippingAddress, shippingAddress); checks.push('address_and_request_ids_are_scoped_to_owner');
        await rejected(() => Promise.resolve(service.list(actor.id, other.id, {})), P.status.missing, S.failure.unavailable.code); checks.push('foreign_owner_route_is_hidden');
        const pageFirst = await read(actor.id, {limit: S.persistence.one}); assert(pageFirst.nextCursor);
        const pageSecond = await read(actor.id, {limit: S.persistence.one, cursor: pageFirst.nextCursor});
        assert.notEqual(pageFirst.items[S.version.absent].id, pageSecond.items[S.version.absent].id); checks.push('opaque_cursor_reads_next_uuid_once');
        let version = (await read()).version;
        const pageIds = Array.from({length: P.pageCount}, () => randomUUID());
        for (const addressId of pageIds) version = (await apply({action: S.action.save, expectedVersion: version, addressId, shippingAddress, makeDefault: false})).version;
        await rejected(() => read(actor.id, {cursor: pageFirst.nextCursor}), P.status.conflict, S.failure.changed.code); checks.push('mutation_invalidates_old_page_cursor');
        const firstPage = await read(), nextPage = await read(actor.id, {cursor: firstPage.nextCursor});
        assert.equal(firstPage.items.length, S.pagination.default); assert.equal(nextPage.items.length, P.pageCount + P.two - S.pagination.default);
        assert.equal(new Set([...firstPage.items, ...nextPage.items].map(item => item.id)).size, P.pageCount + P.two); checks.push('more_than_twenty_addresses_have_no_missing_or_duplicate_rows');
        version = (await apply({action: S.action.setDefault, expectedVersion: version, addressId: second})).version;
        await constraint('database_fences_two_defaults_for_one_owner', tx => tx.update(schema.shippingAddresses).set({isDefault: true})
          .where(eq(schema.shippingAddresses.id, third)), P.sqlCode.duplicate);
        const storedReceipt = (await db.select().from(schema.shippingAddressChanges).where(eq(schema.shippingAddressChanges.requestId, requestId)))
          .find(row => row.userId === actor.id);
        assert(storedReceipt); assert.equal(Object.hasOwn(storedReceipt, 'shippingAddress'), false); checks.push('receipts_retain_no_address_content');
        await db.update(schema.users).set({status: U.status.suspended}).where(eq(schema.users.id, actor.id));
        for (const run of [() => read(), () => service.find(actor.id, actor.id, second), () => service.change(actor.id, actor.id, requestId), () => apply(command, requestId)])
          await rejected(run, P.status.forbidden, S.failure.unavailable.code);
        checks.push('suspended_account_cannot_read_write_or_replay');
        await db.update(schema.users).set({status: U.status.active}).where(eq(schema.users.id, actor.id));
        await new DrizzleAccountDeletionRepository({db}).accept(actor.supabaseUserId, randomUUID(), createHash(D.crypto.algorithm).update(randomUUID()).digest(D.crypto.encoding));
        for (const table of [schema.shippingAddressBooks, schema.shippingAddresses, schema.shippingAddressChanges])
          assert.equal((await db.select().from(table).where(eq(table.userId, actor.id))).length, S.version.absent);
        assert.equal((await read(other.id)).items.length, P.one); checks.push('real_account_anonymization_erases_book_addresses_and_receipts_only_for_owner');
        await constraint('deleted_account_cannot_recreate_private_address_book', tx => tx.insert(schema.shippingAddressBooks)
          .values({userId: actor.id, version: S.version.initial, updatedAt: new Date(P.time)}), P.sqlCode.check);
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

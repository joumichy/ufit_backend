import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { HttpException } from '@nestjs/common';
import { getEnv } from '../src/config/env';
import { buildPgSslConfig } from '../src/shared/infrastructure/database/pg-ssl';
import * as schema from '../src/shared/infrastructure/database/schema';
import { UserAdministrationService } from '../src/modules/identity/application/user-administration.service';
import { DrizzleUserAdministrationRepository } from '../src/modules/identity/infrastructure/persistence/drizzle-user-administration.repository';
import { IdentityService } from '../src/modules/identity/application/identity.service';
import { DrizzleIdentityRepository } from '../src/modules/identity/infrastructure/persistence/drizzle-identity.repository';
import { CreatorGradesService } from '../src/modules/creators/grades/creator-grades.service';
import { DrizzleCreatorGradesRepository } from '../src/modules/creators/grades/drizzle-creator-grades.repository';
const proof = {
    node: 'development', port: 4014, schema: 'ufit', stripePrefix: 'sk_test_',
    registry: homedir() + '/.codex/private/ufit/qualification.credentials.json',
    migration: resolve(__dirname, '../src/shared/infrastructure/database/migrations/0023_user_access_administration.sql'), flag: '--with-migration',
    tables: ['users', 'user_roles', 'creator_profiles', 'brand_profiles', 'brand_members', 'orders', 'order_items', 'payments', 'commissions', 'creator_grades', 'creator_grade_history', 'schema_migrations'], changesTable: 'user_access_changes',
    reason: 'Qualification de la gestion des comptes en transaction annulée.', label: 'Compte de qualification ', role: 'customer', admin: 'admin', superAdmin: 'super_admin',
    active: 'active', suspended: 'suspended', deleted: 'deleted', zero: 0, one: 1, two: 2, bad: 400, denied: 403, unauthorized: 401, conflict: 409,
} as const;
class VerificationRollback extends Error {
}
let scenarios = proof.zero as number;
async function verify() {
    const env = getEnv();
    assert(env.NODE_ENV === proof.node && env.API_PORT === proof.port && env.UFIT_DB_SCHEMA === proof.schema && env.STRIPE_SECRET_KEY?.startsWith(proof.stripePrefix));
    const registry = JSON.parse(await readFile(proof.registry, 'utf8'));
    const pool = new Pool({ connectionString: env.SUPABASE_DIRECT_CONNECTION_DB_URL, ssl: buildPgSslConfig(env), max: proof.one });
    const client = await pool.connect(), database = drizzle(client, { schema });
    const withMigration = process.argv.includes(proof.flag), tables = withMigration ? proof.tables : [...proof.tables, proof.changesTable], before = new Map<string, string>();
    async function digest(table: string) { const result = await client.query('select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,\'[]\')) as digest from ufit.' + table + ' t'); return result.rows[proof.zero].digest as string; }
    async function rejected(operation: () => Promise<unknown>, status: number) { await assert.rejects(async () => operation(), error => error instanceof HttpException && error.getStatus() === status); scenarios++; }
    try {
        for (const table of tables)
            before.set(table, await digest(table));
        try {
            await database.transaction(async (db) => {
                if (withMigration)
                    await db.execute(sql.raw(await readFile(proof.migration, 'utf8')));
                const service = new UserAdministrationService(new DrizzleUserAdministrationRepository({ db }));
                const grades = new CreatorGradesService(new DrizzleCreatorGradesRepository({ db }));
                const identity = new IdentityService(new DrizzleIdentityRepository({ db }));
                const [admin] = await db.select().from(schema.users).where(eq(schema.users.email, registry.admin.email));
                assert(admin);
                const administrator = await service.current(admin.id, admin.id);
                assert(administrator.roles.includes(proof.superAdmin));
                scenarios++;
                for (const role of ['customer', 'creator', 'brand']) {
                    const [actor] = await db.select().from(schema.users).where(eq(schema.users.email, registry[role].email));
                    assert(actor);
                    await rejected(() => service.list(actor.id, {}), proof.denied);
                }
                const targetId = randomUUID(), ordinaryId = randomUUID(), siblingId = randomUUID(), providerId = randomUUID(), needle = randomUUID();
                await db.insert(schema.users).values([
                    { id: targetId, supabaseUserId: providerId, email: targetId + '@example.invalid', displayName: proof.label + needle + '%', status: proof.active },
                    { id: ordinaryId, supabaseUserId: randomUUID(), email: ordinaryId + '@example.invalid', displayName: proof.label + ordinaryId, status: proof.active },
                    { id: siblingId, supabaseUserId: randomUUID(), email: siblingId + '@example.invalid', displayName: proof.label + needle + '-extra', status: proof.active },
                ]);
                await db.insert(schema.userRoles).values([{ userId: targetId, role: proof.role }, { userId: ordinaryId, role: proof.role }, { userId: ordinaryId, role: proof.admin }, { userId: siblingId, role: proof.role }]);
                let current = await service.current(admin.id, targetId);
                assert.equal(current.version, proof.one);
                assert.deepEqual(current.roles, [proof.role]);
                assert(current.actions.suspend && current.actions.grantAdmin);
                scenarios++;
                const initialHistory = await service.history(admin.id, targetId, {});
                assert.equal(initialHistory.items.length, proof.zero);
                scenarios++;
                const literal = await service.list(admin.id, { search: needle + '%' });
                assert.equal(literal.items.length, proof.one);
                assert.equal(literal.items[proof.zero].id, targetId);
                scenarios++;
                const first = await service.list(admin.id, { limit: proof.one });
                assert(first.nextCursor);
                const next = await service.list(admin.id, { limit: proof.one, cursor: first.nextCursor });
                assert.notEqual(first.items[proof.zero].id, next.items[proof.zero].id);
                scenarios++;
                await rejected(() => service.changeStatus(admin.id, admin.id.toUpperCase(), { expectedVersion: administrator.version, status: proof.suspended, reason: proof.reason }), proof.conflict);
                await rejected(() => service.changeAdminAccess(ordinaryId, targetId, { expectedVersion: current.version, enabled: true, reason: proof.reason }), proof.denied);
                await rejected(() => service.changeStatus(ordinaryId, admin.id, { expectedVersion: administrator.version, status: proof.suspended, reason: proof.reason }), proof.denied);
                await rejected(() => service.changeAdminAccess(admin.id, targetId, { expectedVersion: current.version, enabled: true, reason: proof.reason, role: proof.superAdmin }), proof.bad);
                await rejected(() => service.changeStatus(admin.id, targetId, { expectedVersion: current.version, status: proof.deleted, reason: proof.reason }), proof.bad);
                const beforeSuspend = current;
                current = await service.changeStatus(ordinaryId, targetId, { expectedVersion: current.version, status: proof.suspended, reason: proof.reason });
                assert.equal(current.version, beforeSuspend.version + proof.one);
                assert.equal(current.status, proof.suspended);
                scenarios++;
                await rejected(() => identity.resolveCurrentUser({ sub: providerId }), proof.unauthorized);
                await rejected(() => service.changeStatus(admin.id, targetId, { expectedVersion: beforeSuspend.version, status: proof.active, reason: proof.reason }), proof.conflict);
                const suspended = await service.list(admin.id, { status: proof.suspended, search: needle });
                assert.equal(suspended.items[proof.zero].id, targetId);
                scenarios++;
                current = await service.changeStatus(ordinaryId, targetId, { expectedVersion: current.version, status: proof.active, reason: proof.reason });
                assert.equal((await identity.resolveCurrentUser({ sub: providerId })).status, proof.active);
                scenarios++;
                const beforeGrant = current;
                current = await service.changeAdminAccess(admin.id, targetId, { expectedVersion: current.version, enabled: true, reason: proof.reason });
                assert.equal(current.version, beforeGrant.version + proof.one);
                assert(current.roles.includes(proof.role) && current.roles.includes(proof.admin));
                scenarios++;
                assert((await grades.list(targetId, {})).items.length >= proof.one);
                scenarios++;
                await rejected(() => service.changeStatus(ordinaryId, targetId, { expectedVersion: current.version, status: proof.suspended, reason: proof.reason }), proof.denied);
                await rejected(() => service.changeAdminAccess(admin.id, targetId, { expectedVersion: beforeGrant.version, enabled: false, reason: proof.reason }), proof.conflict);
                const filtered = await service.list(admin.id, { role: proof.admin, search: needle });
                assert.equal(filtered.items[proof.zero].id, targetId);
                scenarios++;
                const beforeRevoke = current;
                current = await service.changeAdminAccess(admin.id, targetId, { expectedVersion: current.version, enabled: false, reason: proof.reason });
                assert.equal(current.version, beforeRevoke.version + proof.one);
                assert.deepEqual(current.roles, [proof.role]);
                scenarios++;
                await rejected(() => grades.list(targetId, {}), proof.denied);
                const history = await service.history(admin.id, targetId, { limit: proof.one });
                assert.equal(history.items[proof.zero].version, current.version);
                assert(history.nextCursor);
                scenarios++;
                const prior = await service.history(admin.id, targetId, { limit: proof.one, cursor: history.nextCursor });
                assert.equal(prior.items[proof.zero].version, current.version - proof.one);
                assert.equal(prior.items[proof.zero].decidedByUserId, admin.id);
                scenarios++;
                await rejected(() => service.history(admin.id, siblingId, { cursor: history.nextCursor }), proof.bad);
                const [last] = await db.select().from(schema.userAccessChanges).where(eq(schema.userAccessChanges.id, history.items[proof.zero].id));
                assert(last);
                assert.equal(last.reason, proof.reason);
                assert.equal(last.adminBefore, true);
                assert.equal(last.adminAfter, false);
                scenarios++;
                await db.update(schema.users).set({ status: proof.deleted }).where(eq(schema.users.id, siblingId));
                const deleted = await service.current(admin.id, siblingId);
                assert.deepEqual(deleted.actions, { suspend: false, activate: false, grantAdmin: false, revokeAdmin: false });
                scenarios++;
                await rejected(() => service.changeStatus(admin.id, siblingId, { expectedVersion: deleted.version, status: proof.active, reason: proof.reason }), proof.conflict);
                await db.update(schema.users).set({ status: proof.suspended }).where(eq(schema.users.id, ordinaryId));
                await rejected(() => service.list(ordinaryId, {}), proof.denied);
                throw new VerificationRollback();
            });
        }
        catch (error) {
            if (!(error instanceof VerificationRollback))
                throw error;
        }
        for (const table of tables)
            assert.equal(await digest(table), before.get(table), 'Rollback changed table ' + table);
        console.log(JSON.stringify({ scenarios, rolledBack: true, unchangedTables: tables.length, providerCalls: proof.zero }));
    }
    finally {
        client.release();
        await pool.end();
    }
}
verify().catch(error => { console.error('User administration verification failed at scenario ' + scenarios); if (error instanceof HttpException)
    console.error('HTTP ' + error.getStatus() + ': ' + error.message);
else
    console.error('Failure class ' + (error instanceof Error ? error.name : typeof error)); if (error instanceof Error && error.cause && typeof error.cause === 'object' && 'code' in error.cause)
    console.error('SQL state ' + String(error.cause.code)); process.exitCode = 1; });

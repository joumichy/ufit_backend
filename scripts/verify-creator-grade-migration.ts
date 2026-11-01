import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {Pool, type PoolClient} from 'pg';
import {getEnv} from '../src/config/env';
import {buildPgSslConfig} from '../src/shared/infrastructure/database/pg-ssl';

const proof = {
  profile: {node: 'development', port: 4014, schema: 'ufit', stripePrefix: 'sk_test_'},
  registry: homedir() + '/.codex/private/ufit/qualification.credentials.json',
  migration: '../src/shared/infrastructure/database/migrations/0022_creator_grade_administration.sql',
  migrationFlag: '--with-migration',
  tables: ['creator_grades', 'creator_profiles', 'creator_grade_history', 'creator_score_snapshots', 'commission_rules', 'order_items', 'orders', 'commissions', 'users', 'user_roles', 'schema_migrations'],
  codePrefix: 'qualification-grade-', label: 'Grade de qualification', revised: 'Grade de qualification révisé',
  reason: 'Qualification du grade en transaction annulée.',
  db: {check: '23514', foreignKey: '23503', unique: '23505'},
  zero: 0, one: 1, two: 2, three: 3, rank: 20, nextRank: 21,
} as const;

async function digest(client: PoolClient, table: string) {
  const result = await client.query<{digest: string}>(
    'select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,\'[]\')) as digest from ufit.' + table + ' t');
  assert.equal(result.rows.length, proof.one);
  return result.rows[proof.zero].digest;
}

async function verify() {
  const env = getEnv();
  assert(env.NODE_ENV === proof.profile.node && env.API_PORT === proof.profile.port &&
    env.UFIT_DB_SCHEMA === proof.profile.schema && env.STRIPE_SECRET_KEY?.startsWith(proof.profile.stripePrefix),
  'Grade verification requires the selected development4014 / Stripe TEST profile');
  const registry = JSON.parse(await readFile(proof.registry, 'utf8'));
  const pool = new Pool({connectionString: env.SUPABASE_DIRECT_CONNECTION_DB_URL, ssl: buildPgSslConfig(env), max: proof.one});
  const client = await pool.connect(), before = new Map<string, string>();
  let scenarios = proof.zero as number;
  async function flush() { await client.query('set constraints all immediate'); await client.query('set constraints all deferred'); }
  async function rejected(operation: () => Promise<unknown>, accepted: readonly string[] = [proof.db.check]) {
    await client.query('savepoint creator_grade_case');
    let failure: unknown;
    try { await operation(); await flush(); } catch (error) { failure = error; }
    await client.query('rollback to savepoint creator_grade_case'); await client.query('release savepoint creator_grade_case');
    assert(failure && typeof failure === 'object' && 'code' in failure && accepted.includes(String(failure.code)), 'Expected grade persistence constraint rejection');
    scenarios++;
  }
  async function create(code: string, actorId: string) {
    await client.query('insert into ufit.creator_grades(code,label,rank,created_at,updated_at) values($1,$2,$3,now(),now())', [code, proof.label, proof.rank]);
    const result = await client.query<{id: string}>('insert into ufit.creator_grade_revisions(code,version,label,rank,assignable,changed_by_user_id,reason) values($1,1,$2,$3,true,$4,$5) returning id', [code, proof.label, proof.rank, actorId, proof.reason]);
    await flush(); assert.equal(result.rows.length, proof.one); return result.rows[proof.zero].id;
  }
  try {
    for (const table of proof.tables) before.set(table, await digest(client, table));
    await client.query('begin');
    try {
      if (process.argv.includes(proof.migrationFlag)) await client.query(await readFile(resolve(__dirname, proof.migration), 'utf8'));
      const admin = await client.query<{id: string}>('select distinct u.id from ufit.users u join ufit.user_roles r on r.user_id=u.id where u.email=$1 and u.status=\'active\' and r.role in (\'admin\',\'super_admin\')', [registry.admin.email]);
      const creator = await client.query<{id: string; grade_code: string; label: string; history_id: string}>(
        'select c.id,c.grade_code,g.label,(select h.id from ufit.creator_grade_history h where h.creator_profile_id=c.id order by h.created_at,h.id limit 1) as history_id from ufit.creator_profiles c join ufit.users u on u.id=c.user_id join ufit.creator_grades g on g.code=c.grade_code where u.email=$1', [registry.creator.email]);
      assert.equal(admin.rows.length, proof.one); assert.equal(creator.rows.length, proof.one);
      const actorId = admin.rows[proof.zero].id, owner = creator.rows[proof.zero]; assert(owner.history_id);
      const baseline = await client.query('select g.version,g.assignable,g.updated_at,r.changed_by_user_id,r.reason from ufit.creator_grades g join ufit.creator_grade_revisions r on r.code=g.code and r.version=g.version where g.code=$1', [owner.grade_code]);
      assert.equal(baseline.rows.length, proof.one); assert(baseline.rows[proof.zero].version >= proof.one);
      if (process.argv.includes(proof.migrationFlag)) {
        assert.equal(baseline.rows[proof.zero].version, proof.one);
        assert.equal(baseline.rows[proof.zero].updated_at, null); assert.equal(baseline.rows[proof.zero].changed_by_user_id, null);
      }
      scenarios++;

      const code = proof.codePrefix + randomUUID(), otherCode = proof.codePrefix + randomUUID();
      const revisionId = await create(code, actorId), otherRevisionId = await create(otherCode, actorId);
      const grade = await client.query('select commission_bps,version from ufit.creator_grades where code=$1', [code]);
      assert.equal(grade.rows[proof.zero].commission_bps, null); assert.equal(grade.rows[proof.zero].version, proof.one); scenarios++;
      await rejected(() => client.query('insert into ufit.creator_grades(code,label,rank) values($1,$2,$3)', [code, proof.label, proof.rank]), [proof.db.unique]);
      await rejected(() => client.query('insert into ufit.creator_grades(code,label,rank) values($1,$2,$3)', [proof.codePrefix + randomUUID(), proof.label, proof.rank]), [proof.db.foreignKey, proof.db.check]);
      await rejected(() => client.query('update ufit.creator_grades set label=$1 where code=$2', [proof.revised, code]));
      await rejected(() => client.query('update ufit.creator_grades set version=2,updated_at=now(),assignable=false where code=$1', [owner.grade_code]));
      await rejected(() => client.query('update ufit.creator_grades set version=2,updated_at=now(),label=$1 where code=$2', [proof.revised, code]), [proof.db.foreignKey, proof.db.check]);
      await rejected(() => client.query('insert into ufit.creator_grade_revisions(code,version,previous_revision_id,label,rank,assignable,changed_by_user_id,reason) values($1,2,$2,$3,$4,true,$5,$6)', [code, revisionId, proof.revised, proof.rank, actorId, proof.reason]));
      await rejected(() => client.query('insert into ufit.creator_grade_revisions(code,version,previous_revision_id,label,rank,assignable,changed_by_user_id,reason) values($1,2,$2,$3,$4,true,$5,$6)', [code, otherRevisionId, proof.revised, proof.rank, actorId, proof.reason]));
      await rejected(() => client.query('update ufit.creator_grade_revisions set reason=$1 where id=$2', [proof.revised, revisionId]));
      await rejected(() => client.query('delete from ufit.creator_grade_revisions where id=$1', [revisionId]));

      await client.query('update ufit.creator_grades set version=2,updated_at=now(),label=$1 where code=$2', [proof.revised, code]);
      await client.query('insert into ufit.creator_grade_revisions(code,version,previous_revision_id,label,rank,assignable,changed_by_user_id,reason) values($1,2,$2,$3,$4,true,$5,$6)', [code, revisionId, proof.revised, proof.rank, actorId, proof.reason]);
      await flush(); scenarios++;

      await rejected(() => client.query('update ufit.creator_profiles set grade_code=$1 where id=$2', [code, owner.id]));
      await rejected(() => client.query('update ufit.creator_profiles set grade_version=2 where id=$1', [owner.id]));
      await rejected(() => client.query('update ufit.creator_profiles set grade_code=$1,grade_version=2 where id=$2', [code, owner.id]));
      await rejected(() => client.query('insert into ufit.creator_grade_history(creator_profile_id,to_grade_code,reason) values($1,$2,$3)', [owner.id, owner.grade_code, proof.reason]));
      await rejected(() => client.query('insert into ufit.creator_grade_history(creator_profile_id,to_grade_code,to_grade_label,source,changed_by_user_id,reason) values($1,$2,$3,\'administration\',$4,$5)', [owner.id, owner.grade_code, owner.label, actorId, proof.reason]));
      await rejected(async () => {
        await client.query('update ufit.creator_profiles set grade_code=$1,grade_version=2 where id=$2', [code, owner.id]);
        await client.query('insert into ufit.creator_grade_history(creator_profile_id,version,source,from_grade_code,from_grade_label,to_grade_code,to_grade_label,changed_by_user_id,reason) values($1,2,\'administration\',$2,$3,$4,$5,$6,$7)', [owner.id, otherCode, proof.label, code, proof.revised, actorId, proof.reason]);
      });

      await client.query('update ufit.creator_profiles set grade_code=$1,grade_version=2,updated_at=now() where id=$2', [code, owner.id]);
      const change = await client.query<{id: string}>('insert into ufit.creator_grade_history(creator_profile_id,version,source,from_grade_code,from_grade_label,to_grade_code,to_grade_label,changed_by_user_id,reason) values($1,2,\'administration\',$2,$3,$4,$5,$6,$7) returning id', [owner.id, owner.grade_code, owner.label, code, proof.revised, actorId, proof.reason]);
      await flush(); assert.equal(change.rows.length, proof.one); scenarios++;
      await rejected(() => client.query('insert into ufit.creator_grade_history(creator_profile_id,version,source,from_grade_code,from_grade_label,to_grade_code,to_grade_label,changed_by_user_id,reason) values($1,2,\'administration\',$2,$3,$4,$5,$6,$7)', [owner.id, owner.grade_code, owner.label, code, proof.revised, actorId, proof.reason]), [proof.db.unique]);
      await rejected(() => client.query('update ufit.creator_grade_history set reason=$1 where id=$2', [proof.revised, owner.history_id]));
      await rejected(() => client.query('delete from ufit.creator_grade_history where id=$1', [owner.history_id]));
      await rejected(() => client.query('update ufit.creator_grade_history set to_grade_label=$1 where id=$2', [proof.label, change.rows[proof.zero].id]));
      await flush();
    } finally { await client.query('rollback'); }
    for (const table of proof.tables) assert.equal(await digest(client, table), before.get(table), 'Rollback changed table ' + table);
    console.log(JSON.stringify({scenarios,rolledBack: true,unchangedTables: proof.tables.length,providerCalls: proof.zero}));
  } finally { client.release(); await pool.end(); }
}

verify().catch(error => { console.error(error instanceof Error ? error.message : 'Grade migration verification failed'); process.exitCode = 1; });

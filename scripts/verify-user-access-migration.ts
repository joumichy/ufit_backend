import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {Pool} from 'pg';
import {getEnv} from '../src/config/env';
import {buildPgSslConfig} from '../src/shared/infrastructure/database/pg-ssl';

const proof = {
  node: 'development', port: 4014, schema: 'ufit', stripePrefix: 'sk_test_',
  registry: homedir() + '/.codex/private/ufit/qualification.credentials.json',
  migration: '../src/shared/infrastructure/database/migrations/0023_user_access_administration.sql', flag: '--with-migration',
  tables: ['users','user_roles','creator_profiles','brand_profiles','brand_members','orders','order_items','payments','commissions','creator_grades','creator_grade_history','schema_migrations'],
  changesTable: 'user_access_changes',
  reason: 'Qualification des décisions d’accès en transaction annulée.',
  zero: 0, one: 1, two: 2, check: '23514', unique: '23505',
} as const;
let scenarios = proof.zero as number;

async function verify() {
  const env = getEnv();
  assert(env.NODE_ENV === proof.node && env.API_PORT === proof.port && env.UFIT_DB_SCHEMA === proof.schema && env.STRIPE_SECRET_KEY?.startsWith(proof.stripePrefix));
  const registry = JSON.parse(await readFile(proof.registry,'utf8'));
  const pool = new Pool({connectionString:env.SUPABASE_DIRECT_CONNECTION_DB_URL,ssl:buildPgSslConfig(env),max:proof.one});
  const client = await pool.connect(), before = new Map<string,string>();
  const tables = process.argv.includes(proof.flag) ? proof.tables : [...proof.tables,proof.changesTable];
  async function digest(table: string) {
    const result = await client.query('select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,\'[]\')) as digest from ufit.'+table+' t');
    return result.rows[proof.zero].digest as string;
  }
  async function rejected(operation:()=>Promise<unknown>, codes:readonly string[]=[proof.check]) {
    await client.query('savepoint user_access_case');
    let failure:unknown;
    try {await operation();} catch(error) {failure=error;}
    await client.query('rollback to savepoint user_access_case');await client.query('release savepoint user_access_case');
    assert(failure && typeof failure==='object' && 'code' in failure && codes.includes(String(failure.code)));scenarios++;
  }
  try {
    for(const table of tables) before.set(table,await digest(table));
    await client.query('begin');
    try {
      if(process.argv.includes(proof.flag)) await client.query(await readFile(resolve(__dirname,proof.migration),'utf8'));
      const admin = await client.query('select u.id from ufit.users u join ufit.user_roles r on r.user_id=u.id where u.email=$1 and u.status=\'active\' and r.role=\'super_admin\'',[registry.admin.email]);
      assert.equal(admin.rows.length,proof.one);const actorId=admin.rows[proof.zero].id;
      const userId=randomUUID();
      await client.query('insert into ufit.users(id,supabase_user_id,email,status) values($1,$2,$3,\'active\')',[userId,randomUUID(),userId+'@example.invalid']);
      await client.query('insert into ufit.user_roles(user_id,role) values($1,\'customer\')',[userId]);
      let version=proof.one as number; const recordedVersions:number[]=[];
      async function currentVersion() {
        const result=await client.query('select access_version from ufit.users where id=$1',[userId]);
        return result.rows[proof.zero].access_version as number;
      }
      async function record(kind:string,from:string,to:string,adminBefore:boolean,adminAfter:boolean) {
        const result=await client.query('insert into ufit.user_access_changes(user_id,version,kind,from_status,to_status,admin_before,admin_after,decided_by_user_id,reason) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id',
          [userId,version,kind,from,to,adminBefore,adminAfter,actorId,proof.reason]);
        assert.equal(result.rows.length,proof.one);recordedVersions.push(version);scenarios++;return result.rows[proof.zero].id as string;
      }
      assert.equal(await currentVersion(),version);scenarios++;
      const empty=await client.query('select id from ufit.user_access_changes where user_id=$1',[userId]);assert.equal(empty.rows.length,proof.zero);scenarios++;
      await client.query('update ufit.users set updated_at=clock_timestamp() where id=$1',[userId]);assert.equal(await currentVersion(),version);scenarios++;
      await client.query('update ufit.users set status=\'suspended\' where id=$1',[userId]);version+=proof.one;assert.equal(await currentVersion(),version);scenarios++;
      await rejected(()=>client.query('insert into ufit.user_access_changes(user_id,version,kind,from_status,to_status,admin_before,admin_after,decided_by_user_id,reason) values($1,$2,\'admin_access\',\'active\',\'suspended\',false,false,$3,$4)',[userId,version,actorId,proof.reason]));
      await rejected(()=>client.query('insert into ufit.user_access_changes(user_id,version,kind,from_status,to_status,admin_before,admin_after,decided_by_user_id,reason) values($1,$2,\'status\',\'active\',\'suspended\',true,true,$3,$4)',[userId,version,actorId,proof.reason]));
      const decision=await record('status','active','suspended',false,false);
      await client.query('update ufit.users set status=\'suspended\' where id=$1',[userId]);assert.equal(await currentVersion(),version);scenarios++;
      await rejected(()=>client.query('update ufit.users set access_version=$1 where id=$2',[version-proof.one,userId]));
      await rejected(()=>client.query('update ufit.users set access_version=$1 where id=$2',[version+proof.two,userId]));
      await rejected(()=>client.query('insert into ufit.user_access_changes(user_id,version,kind,from_status,to_status,admin_before,admin_after,decided_by_user_id,reason) values($1,$2,\'status\',\'active\',\'suspended\',false,false,$3,$4)',[userId,version,actorId,proof.reason]),[proof.unique]);
      await rejected(()=>client.query('insert into ufit.user_access_changes(user_id,version,kind,from_status,to_status,admin_before,admin_after,decided_by_user_id,reason) values($1,$2,\'status\',\'active\',\'suspended\',false,false,$3,$4)',[userId,version+proof.one,actorId,proof.reason]));
      await rejected(()=>client.query('insert into ufit.user_access_changes(user_id,version,kind,from_status,to_status,admin_before,admin_after,decided_by_user_id,reason) values($1,$2,\'status\',\'suspended\',\'active\',false,false,$3,$4)',[userId,version,actorId,proof.reason]));
      await rejected(()=>client.query('update ufit.user_access_changes set reason=$1 where id=$2',[proof.reason,decision]));
      await rejected(()=>client.query('delete from ufit.user_access_changes where id=$1',[decision]));
      await client.query('update ufit.users set status=\'active\' where id=$1',[userId]);version+=proof.one;assert.equal(await currentVersion(),version);scenarios++;
      await record('status','suspended','active',false,false);
      await client.query('insert into ufit.user_roles(user_id,role) values($1,\'admin\')',[userId]);version+=proof.one;assert.equal(await currentVersion(),version);scenarios++;
      await record('admin_access','active','active',false,true);
      await client.query('insert into ufit.user_roles(user_id,role) values($1,\'admin\') on conflict(user_id,role) do nothing',[userId]);assert.equal(await currentVersion(),version);scenarios++;
      await client.query('delete from ufit.user_roles where user_id=$1 and role=\'admin\'',[userId]);version+=proof.one;assert.equal(await currentVersion(),version);scenarios++;
      await record('admin_access','active','active',true,false);
      await client.query('insert into ufit.user_roles(user_id,role) values($1,\'creator\')',[userId]);assert.equal(await currentVersion(),version);scenarios++;
      await client.query('insert into ufit.user_roles(user_id,role) values($1,\'admin\')',[userId]);version+=proof.one;
      await client.query('update ufit.user_roles set role=\'super_admin\' where user_id=$1 and role=\'admin\'',[userId]);version+=proof.one;assert.equal(await currentVersion(),version);scenarios++;
      await client.query('delete from ufit.user_roles where user_id=$1 and role=\'super_admin\'',[userId]);version+=proof.one;assert.equal(await currentVersion(),version);scenarios++;
      const history=await client.query('select version from ufit.user_access_changes where user_id=$1 order by version desc',[userId]);
      assert.deepEqual(history.rows.map(row=>row.version),[...recordedVersions].reverse());scenarios++;
    } finally {await client.query('rollback');}
    for(const table of tables) assert.equal(await digest(table),before.get(table),'Rollback changed table '+table);
    console.log(JSON.stringify({scenarios,rolledBack:true,unchangedTables:tables.length,providerCalls:proof.zero}));
  } finally {client.release();await pool.end();}
}
verify().catch(()=>{console.error('User access migration verification failed at scenario '+scenarios);process.exitCode=1;});

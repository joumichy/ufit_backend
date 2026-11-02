import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {eq,sql} from 'drizzle-orm';
import {HttpException} from '@nestjs/common';
import {getEnv} from '../src/config/env';
import {buildPgSslConfig} from '../src/shared/infrastructure/database/pg-ssl';
import * as schema from '../src/shared/infrastructure/database/schema';
import {DrizzleNotificationInstallationsRepository} from '../src/modules/notifications/infrastructure/drizzle-notification-installations.repository';
import {INSTALLATION as I} from '../src/modules/notifications/domain/notification-installation';
import {PUSH_DELIVERY as P} from '../src/modules/notifications/domain/push-delivery';

const PROOF={profile:{node:'development',port:4014,schema:'ufit',stripe:'sk_test_'},zero:0,one:1,two:2,secretBytes:32,tokenBytes:8,
  domain:'@example.invalid',withMigration:'--with-migration',table:'notification_installation_detachments',
  migration:'../src/shared/infrastructure/database/migrations/0028_notification_installation_detachments.sql',diagnostic:'/tmp/ufit-detachment-sql-diagnostic.txt',
  status:{conflict:409,unauthorized:401},code:{check:'23514',foreign:'23503'},
  constraints:'set constraints ufit.notification_installation_relation,ufit.notification_association_relation,ufit.notification_detachment_relation ',
  immediate:'immediate',deferred:'deferred',
  tablesQuery:"select table_name from information_schema.tables where table_schema='ufit' and table_type='BASE TABLE' order by table_name",
} as const;
class Rollback extends Error{}
async function verify(){
 const env=getEnv();assert(env.NODE_ENV===PROOF.profile.node&&env.API_PORT===PROOF.profile.port&&env.UFIT_DB_SCHEMA===PROOF.profile.schema&&env.STRIPE_SECRET_KEY?.startsWith(PROOF.profile.stripe)&&!env.NOTIFICATION_EMAIL_ENABLED&&!env.NOTIFICATION_PUSH_ENABLED);
 const pool=new Pool({connectionString:env.SUPABASE_DIRECT_CONNECTION_DB_URL,ssl:buildPgSslConfig(env),max:PROOF.one}),client=await pool.connect(),database=drizzle(client,{schema});
 const withMigration=process.argv.includes(PROOF.withMigration),tables=(await client.query<{table_name:string}>(PROOF.tablesQuery)).rows.map(row=>row.table_name),cases:string[]=[];assert.equal(tables.includes(PROOF.table),!withMigration);
 async function fingerprint(table:string){assert(/^[a-z_]+$/.test(table));return (await client.query("select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) digest from ufit."+table+' t')).rows[PROOF.zero].digest;}
 const before=new Map<string,string>();
 try{
  for(const table of tables)before.set(table,await fingerprint(table));
  try{await database.transaction(async db=>{
   if(withMigration)await db.execute(sql.raw(await readFile(resolve(__dirname,PROOF.migration),'utf8')));
   const registry=new DrizzleNotificationInstallationsRepository({db});
   const [actor]=await db.insert(schema.users).values({supabaseUserId:randomUUID(),email:randomUUID()+PROOF.domain}).returning();assert(actor);
   const [other]=await db.insert(schema.users).values({supabaseUserId:randomUUID(),email:randomUUID()+PROOF.domain}).returning();assert(other);
   async function reject(operation:()=>Promise<unknown>,status:number){await assert.rejects(operation,e=>e instanceof HttpException&&e.getStatus()===status);}
   async function relations(){await client.query(PROOF.constraints+PROOF.immediate);await client.query(PROOF.constraints+PROOF.deferred);}
   function registration(expectedVersion:number,associationId:string){return {expectedVersion,associationId,registrationId:randomUUID(),deviceToken:randomBytes(PROOF.tokenBytes).toString(I.crypto.encoding),environment:P.environment.development};}
   for(const exists of [false,true]){
    const id=randomUUID(),key=randomBytes(PROOF.secretBytes).toString(I.crypto.encoding),oldTarget=randomUUID();let version=I.revision.absent as number;
    if(exists){const first=await registry.register(actor.id,id,key,registration(version,randomUUID()));version=first.version;}
    const late=registration(version,oldTarget),beforeDetach=await registry.read(actor.id,id,key);
    await registry.detach(id,oldTarget,key,{});await relations();const detached=await registry.read(actor.id,id,key);
    if(exists)assert.deepEqual(detached,beforeDetach);else{assert.equal(detached.state,I.state.detached);assert.equal(detached.version,I.revision.initial);assert.equal(detached.isCurrentAccount,false);}
    cases.push(exists?'unknown_target_preserves_current_binding':'early_detach_creates_unbound_private_identity');
    await reject(()=>registry.register(actor.id,id,key,late),PROOF.status.conflict);cases.push(exists?'late_registration_rejected_existing_installation':'late_registration_rejected_initial_installation');
    await reject(()=>registry.register(actor.id,id,key,{...late,expectedVersion:detached.version}),PROOF.status.conflict);cases.push('revoked_target_cannot_use_refreshed_version');
    const [marker]=await db.select().from(schema.notificationInstallationDetachments).where(eq(schema.notificationInstallationDetachments.installationId,id));assert(marker);assert.equal(marker.associationId,oldTarget);cases.push('target_consumed');
    await registry.detach(id,oldTarget,key,{});assert.deepEqual(await registry.read(actor.id,id,key),detached);cases.push('detach_replay_preserves_version_and_binding');
    const good=registration(detached.version,randomUUID()),current=await registry.register(other.id,id,key,good);assert.equal(current.isCurrentAccount,true);cases.push('new_account_session_can_register');
    await registry.detach(id,oldTarget,key,{});assert.deepEqual(await registry.read(other.id,id,key),current);cases.push('old_detach_cannot_change_next_session');
    const wrong=randomBytes(PROOF.secretBytes).toString(I.crypto.encoding),blockedTarget=randomUUID();
    await reject(()=>registry.detach(id,blockedTarget,wrong,{}),PROOF.status.unauthorized);
    assert.equal((await db.select().from(schema.notificationInstallationDetachments).where(eq(schema.notificationInstallationDetachments.associationId,blockedTarget))).length,PROOF.zero);cases.push('wrong_proof_cannot_consume_a_target');
    await reject(()=>registry.register(actor.id,id,key,{...late,expectedVersion:current.version}),PROOF.status.conflict);assert.deepEqual(await registry.read(other.id,id,key),current);cases.push('old_owner_cannot_register_consumed_target');
    await registry.detach(id,good.associationId,key,{});await relations();const final=await registry.read(other.id,id,key);assert.equal(final.state,I.state.detached);cases.push('registered_target_closed_and_consumed');
    await reject(()=>registry.register(other.id,id,key,{...good,expectedVersion:final.version,registrationId:randomUUID()}),PROOF.status.conflict);cases.push('registered_target_cannot_reopen');
    async function storageReject(query:string,values:unknown[],code:string=PROOF.code.check){await assert.rejects(()=>db.transaction(async()=>{await client.query(query,values);await client.query(PROOF.constraints+PROOF.immediate);}),e=>(e as {code?:string}).code===code);await client.query(PROOF.constraints+PROOF.deferred);}
    await storageReject('update ufit.notification_installation_detachments set association_id=$1 where installation_id=$2 and association_id=$3',[randomUUID(),id,oldTarget]);cases.push('consumed_target_immutable');
    await storageReject('delete from ufit.notification_installation_detachments where installation_id=$1 and association_id=$2',[id,oldTarget]);cases.push('consumed_target_cannot_be_forgotten');
    await storageReject('insert into ufit.notification_device_associations(id,installation_id,user_id,opened_at) values($1,$2,$3,now())',[oldTarget,id,actor.id]);cases.push('sql_insert_cannot_reopen_unknown_detached_target');
    const next=await registry.register(actor.id,id,key,registration(final.version,randomUUID()));assert(next.associationId);
    await storageReject('insert into ufit.notification_installation_detachments(installation_id,association_id) values($1,$2)',[id,next.associationId]);cases.push('sql_detachment_cannot_leave_open_association');
   }
   await relations();throw new Rollback();
  });}catch(error){if(!(error instanceof Rollback))throw error;}
  for(const table of tables)assert.equal(await fingerprint(table),before.get(table),'Original table unchanged: '+table);
  assert.equal((await client.query("select to_regclass('ufit.notification_installation_detachments') is not null present")).rows[PROOF.zero].present,!withMigration);
  console.log(JSON.stringify({cases:cases.length,scenarios:cases,tablesUnchanged:tables.length,migrationRolledBack:withMigration,providerCalls:PROOF.zero}));
 }finally{client.release();await pool.end();}
}
verify().catch(async error=>{await writeFile(PROOF.diagnostic,String(error.stack),{mode:0o600});console.error('Detachment ordering SQL proof failed; private diagnostic saved');process.exitCode=1;});

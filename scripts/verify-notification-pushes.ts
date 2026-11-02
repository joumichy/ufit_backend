import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {eq,sql} from 'drizzle-orm';
import {getTableConfig} from 'drizzle-orm/pg-core';
import {getEnv} from '../src/config/env';
import {buildPgSslConfig} from '../src/shared/infrastructure/database/pg-ssl';
import * as schema from '../src/shared/infrastructure/database/schema';
import type {DatabaseSession} from '../src/shared/infrastructure/database/database-session';
import {DrizzleNotificationPushesRepository} from '../src/modules/notifications/infrastructure/drizzle-notification-pushes.repository';
import {DrizzleNotificationInstallationsRepository} from '../src/modules/notifications/infrastructure/drizzle-notification-installations.repository';
import {DrizzleNotificationPreferencesRepository} from '../src/modules/notifications/infrastructure/drizzle-notification-preferences.repository';
import {DrizzleNotificationsRepository} from '../src/modules/notifications/infrastructure/drizzle-notifications.repository';
import {NOTIFICATION as MESSAGE} from '../src/modules/notifications/domain/notification.contract';
import {NOTIFICATION_PUSH as N,type StartedNotificationPush} from '../src/modules/notifications/domain/notification-push.contract';
import {PUSH_DELIVERY as P} from '../src/modules/notifications/domain/push-delivery';
import {INSTALLATION as I} from '../src/modules/notifications/domain/notification-installation';

const PROOF={profile:{node:'development',port:4014,schema:'ufit',stripe:'sk_test_'},zero:0,one:1,two:2,secretBytes:32,tokenBytes:8,offsetMs:1_000,
  domain:'@example.invalid',copy:'Qualification push annulée sans fournisseur',suspended:'suspended',active:'active',
  migration:'../src/shared/infrastructure/database/migrations/0027_notification_push_deliveries.sql',withMigration:'--with-migration',
  table:'notification_push_deliveries',diagnostic:'/tmp/ufit-push-sql-diagnostic.txt',
  query:{tables:"select table_name from information_schema.tables where table_schema='ufit' and table_type='BASE TABLE' order by table_name",
    hashPrefix:"select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) digest from ufit.",hashSuffix:' t',
    exists:"select to_regclass('ufit.notification_push_deliveries') is not null present"},
} as const;
class Rollback extends Error {}
async function verify(){
 const env=getEnv();assert(env.NODE_ENV===PROOF.profile.node&&env.API_PORT===PROOF.profile.port&&env.UFIT_DB_SCHEMA===PROOF.profile.schema&&env.STRIPE_SECRET_KEY?.startsWith(PROOF.profile.stripe)&&!env.NOTIFICATION_EMAIL_ENABLED&&!env.NOTIFICATION_PUSH_ENABLED);
 const pool=new Pool({connectionString:env.SUPABASE_DIRECT_CONNECTION_DB_URL,ssl:buildPgSslConfig(env),max:PROOF.one}),client=await pool.connect(),db=drizzle(client,{schema});
 const withMigration=process.argv.includes(PROOF.withMigration),tables=(await client.query<{table_name:string}>(PROOF.query.tables)).rows.map(row=>row.table_name),cases:string[]=[];
 assert.equal(tables.includes(PROOF.table),!withMigration);
 async function fingerprint(table:string){assert(/^[a-z_]+$/.test(table));return (await client.query(PROOF.query.hashPrefix+table+PROOF.query.hashSuffix)).rows[PROOF.zero].digest;}
 const before=new Map<string,string>();
 try{
  for(const table of tables)before.set(table,await fingerprint(table));
  try{await db.transaction(async tx=>{
   if(withMigration)await tx.execute(sql.raw(await readFile(resolve(__dirname,PROOF.migration),'utf8')));
   const metadata=getTableConfig(schema.notificationPushDeliveries),checks=(await client.query<{conname:string}>("select conname from pg_constraint where conrelid='ufit.notification_push_deliveries'::regclass and contype='c'")).rows.map(row=>row.conname).sort();
   assert.deepEqual(checks,metadata.checks.map(check=>check.name).sort());cases.push('drizzle_sql_checks_identical');
   const startedAt=Date.now()+PROOF.offsetMs;
   async function fixture(database:DatabaseSession){
    const connection=database.db,pushes=new DrizzleNotificationPushesRepository(database),registry=new DrizzleNotificationInstallationsRepository(database),preferences=new DrizzleNotificationPreferencesRepository(database),writer=new DrizzleNotificationsRepository(database);
    const [actor]=await connection.insert(schema.users).values({supabaseUserId:randomUUID(),email:randomUUID()+PROOF.domain}).returning();assert(actor);
    const [other]=await connection.insert(schema.users).values({supabaseUserId:randomUUID(),email:randomUUID()+PROOF.domain}).returning();assert(other);
    const [application]=await connection.insert(schema.creatorApplications).values({userId:actor.id,email:actor.email,displayName:PROOF.copy,motivation:PROOF.copy}).returning();assert(application);
    let time=startedAt;const now=()=>new Date(time);const advance=(ms:number)=>{time+=ms;return now();};
    const installationId=randomUUID(),associationId=randomUUID(),key=randomBytes(PROOF.secretBytes).toString(I.crypto.encoding),deviceToken=randomBytes(PROOF.tokenBytes).toString(I.crypto.encoding);
    let registered=await registry.register(actor.id,installationId,key,{expectedVersion:I.revision.absent,associationId,registrationId:randomUUID(),deviceToken,environment:P.environment.development},now());
    const intent={eventKey:randomUUID(),recipientUserId:actor.id,resourceType:MESSAGE.resource.creatorApplication,resourceId:application.id,audience:MESSAGE.audience.applicant,brandId:null,subject:PROOF.copy,text:PROOF.copy};
    async function event(){const id=await writer.record({...intent,eventKey:randomUUID()});assert(id);return id;}
    async function rows(){const values=await connection.select({delivery:schema.notificationPushDeliveries}).from(schema.notificationPushDeliveries)
      .innerJoin(schema.notifications,eq(schema.notifications.id,schema.notificationPushDeliveries.notificationId)).where(eq(schema.notifications.recipientUserId,actor.id));return values.map(value=>value.delivery);}
    async function row(id:string){const [value]=await connection.select().from(schema.notificationPushDeliveries).where(eq(schema.notificationPushDeliveries.id,id));assert(value);return value;}
    async function reserve(){const [value]=await pushes.claim(P.environment.development,now());assert(value);return value;}
    async function start(){const value=await pushes.start(await reserve(),now());assert(value);return value;}
    async function rotate(){registered=await registry.register(actor.id,installationId,key,{expectedVersion:registered.version,associationId,registrationId:randomUUID(),deviceToken:randomBytes(PROOF.tokenBytes).toString(I.crypto.encoding),environment:P.environment.development},advance(PROOF.one));return registered;}
    async function preference(pushEnabled:boolean){const previous=await preferences.read(actor.id);return preferences.write(actor.id,{expectedVersion:previous.version,emailEnabled:true,pushEnabled});}
    return {connection,pushes,registry,preferences,writer,actor,other,application,installationId,associationId,key,deviceToken,intent,event,rows,row,reserve,start,rotate,preference,now,advance,registered};
   }
   type Fixture=Awaited<ReturnType<typeof fixture>>;
   async function scenario(name:string,body:(f:Fixture)=>Promise<void>){try{await tx.transaction(async connection=>{await body(await fixture({db:connection}));throw new Rollback();});}catch(error){if(!(error instanceof Rollback))throw error;}cases.push(name);}
   const accepted=(attempt:StartedNotificationPush)=>({outcome:P.outcome.accepted,providerMessageId:attempt.id} as const);
   const retry={outcome:P.outcome.retry,reason:P.failure.unavailable,retryAfterMs:N.limits.firstRetryMs} as const;
   const invalidDevice={outcome:P.outcome.invalidDevice,reason:P.failure.device,invalidatedAt:null} as const;
   await scenario('fanout_and_replay_without_duplicate',async f=>{const id=await f.writer.record(f.intent);assert(id);assert.equal((await f.rows()).length,PROOF.one);assert.equal(await f.writer.record(f.intent),id);assert.equal((await f.rows()).length,PROOF.one);});
   await scenario('multiple_installations_and_environment_partition',async f=>{await f.registry.register(f.actor.id,randomUUID(),randomBytes(PROOF.secretBytes).toString(I.crypto.encoding),{expectedVersion:I.revision.absent,associationId:randomUUID(),registrationId:randomUUID(),deviceToken:f.deviceToken,environment:P.environment.production},f.now());await f.event();assert.equal((await f.rows()).length,PROOF.two);assert.equal((await f.pushes.claim(P.environment.production,f.now())).length,PROOF.one);assert.equal((await f.pushes.claim(P.environment.development,f.now())).length,PROOF.one);});
   await scenario('disabled_push_no_backfill_on_reenable',async f=>{await f.preference(false);await f.event();assert.equal((await f.rows()).length,PROOF.zero);await f.preference(true);assert.equal((await f.rows()).length,PROOF.zero);await f.event();assert.equal((await f.rows()).length,PROOF.one);});
   await scenario('registration_does_not_replay_old_notifications',async f=>{await f.registry.detach(f.installationId,f.associationId,f.key,{},f.now());await f.event();assert.equal((await f.rows()).length,PROOF.zero);await f.registry.register(f.actor.id,f.installationId,f.key,{expectedVersion:f.registered.version+PROOF.one,associationId:randomUUID(),registrationId:randomUUID(),deviceToken:f.deviceToken,environment:P.environment.development},f.now());assert.equal((await f.rows()).length,PROOF.zero);});
   await scenario('reservation_has_no_attempt_and_start_is_once',async f=>{await f.event();const reservation=await f.reserve();assert.equal((await f.row(reservation.id)).attempts,PROOF.zero);const attempt=await f.pushes.start(reservation,f.now());assert(attempt);assert.equal(attempt.attempts,PROOF.one);assert.equal(await f.pushes.start(reservation,f.now()),null);});
   await scenario('expired_reservation_reacquired_without_prior_send',async f=>{await f.event();const old=await f.reserve();f.advance(N.limits.leaseMs+PROOF.one);const newer=await f.reserve();assert.notEqual(newer.leaseToken,old.leaseToken);assert.equal(await f.pushes.start(old,f.now()),null);assert(await f.pushes.start(newer,f.now()));});
   await scenario('expired_started_lease_uncertain_without_repost',async f=>{await f.event();const attempt=await f.start();f.advance(N.limits.leaseMs+PROOF.one);assert.equal((await f.pushes.claim(P.environment.development,f.now())).length,PROOF.zero);assert.equal((await f.row(attempt.id)).status,N.status.uncertain);assert.equal(await f.pushes.finish(attempt,accepted(attempt),f.now()),false);});
   await scenario('token_rotation_before_first_attempt',async f=>{await f.event();const reservation=await f.reserve(),fresh=await f.rotate(),attempt=await f.pushes.start(reservation,f.now());assert(attempt);assert.equal(attempt.registrationId,fresh.registrationId);assert.notEqual(attempt.push.deviceToken,f.deviceToken);});
   await scenario('old_association_after_account_switch_cancelled',async f=>{await f.event();const reservation=await f.reserve();await f.registry.register(f.other.id,f.installationId,f.key,{expectedVersion:f.registered.version,associationId:randomUUID(),registrationId:randomUUID(),deviceToken:f.deviceToken,environment:P.environment.development},f.advance(PROOF.one));assert.equal(await f.pushes.start(reservation,f.now()),null);assert.equal((await f.row(reservation.id)).status,N.status.cancelled);});
   await scenario('suspended_account_cannot_start',async f=>{await f.event();const reservation=await f.reserve();await f.connection.update(schema.users).set({status:PROOF.suspended}).where(eq(schema.users.id,f.actor.id));assert.equal(await f.pushes.start(reservation,f.now()),null);});
   await scenario('resource_access_revoked_before_start',async f=>{await f.event();const reservation=await f.reserve();await f.connection.update(schema.creatorApplications).set({userId:f.other.id}).where(eq(schema.creatorApplications.id,f.application.id));assert.equal(await f.pushes.start(reservation,f.now()),null);});
   await scenario('disable_cancels_reservation_and_reenable_cannot_restore_it',async f=>{await f.event();const reservation=await f.reserve();await f.preference(false);await f.preference(true);assert.equal(await f.pushes.start(reservation,f.now()),null);assert.equal((await f.row(reservation.id)).status,N.status.cancelled);});
   await scenario('disable_inflight_stops_known_safe_retry_after_reenable',async f=>{await f.event();const attempt=await f.start();await f.preference(false);await f.preference(true);assert(await f.pushes.finish(attempt,retry,f.advance(PROOF.one)));assert.equal((await f.row(attempt.id)).status,N.status.cancelled);});
   await scenario('accepted_inflight_is_recorded_even_after_disable',async f=>{await f.event();const attempt=await f.start();await f.preference(false);assert(await f.pushes.finish(attempt,accepted(attempt),f.advance(PROOF.one)));assert.equal((await f.row(attempt.id)).status,N.status.accepted);assert.equal(await f.pushes.finish(attempt,accepted(attempt),f.now()),false);});
   await scenario('unknown_response_terminal_no_repost',async f=>{await f.event();const attempt=await f.start();assert(await f.pushes.finish(attempt,{outcome:P.outcome.unknown,reason:P.failure.transport},f.advance(PROOF.one)));assert.equal((await f.row(attempt.id)).status,N.status.uncertain);f.advance(N.limits.leaseMs);assert.equal((await f.pushes.claim(P.environment.development,f.now())).length,PROOF.zero);});
   await scenario('known_retry_respects_provider_minimum_and_updates_token',async f=>{await f.event();const attempt=await f.start(),delay=N.limits.leaseMs;assert(await f.pushes.finish(attempt,{...retry,retryAfterMs:delay},f.advance(PROOF.one)));assert.equal((await f.pushes.claim(P.environment.development,f.now())).length,PROOF.zero);await f.rotate();f.advance(delay);const newer=await f.start();assert.equal(newer.id,attempt.id);assert.equal(newer.attempts,PROOF.two);assert.notEqual(newer.push.deviceToken,attempt.push.deviceToken);assert.equal(await f.pushes.finish(attempt,accepted(attempt),f.now()),false);});
   await scenario('invalid_device_invalidates_only_current_registration',async f=>{await f.event();const attempt=await f.start();assert(await f.pushes.finish(attempt,invalidDevice,f.advance(PROOF.one)));assert.equal((await f.registry.read(f.actor.id,f.installationId,f.key)).state,I.state.invalidated);assert.equal((await f.row(attempt.id)).status,N.status.rejected);});
   await scenario('old_invalid_device_does_not_invalidate_rotated_registration',async f=>{await f.event();const attempt=await f.start(),fresh=await f.rotate();assert(await f.pushes.finish(attempt,invalidDevice,f.now()));assert.equal((await f.registry.read(f.actor.id,f.installationId,f.key)).registrationId,fresh.registrationId);assert.equal((await f.row(attempt.id)).status,N.status.retry);});
   await scenario('old_410_timestamp_does_not_invalidate_newer_os_registration',async f=>{await f.event();const attempt=await f.start();assert(await f.pushes.finish(attempt,{...invalidDevice,invalidatedAt:new Date(Date.parse(f.registered.registeredAt!)-PROOF.one)},f.now()));assert.equal((await f.registry.read(f.actor.id,f.installationId,f.key)).state,I.state.registered);assert.equal((await f.row(attempt.id)).status,N.status.retry);});
   await scenario('expired_event_never_attempted',async f=>{await f.event();f.advance(N.limits.lifetimeMs);assert.equal((await f.pushes.claim(P.environment.development,f.now())).length,PROOF.zero);const [row]=await f.rows();assert.equal(row.status,N.status.expired);assert.equal(row.attempts,PROOF.zero);});
   await scenario('retry_cannot_outlive_expiration',async f=>{await f.event();const attempt=await f.start();await f.pushes.finish(attempt,{...retry,retryAfterMs:N.limits.lifetimeMs},f.now());assert.equal((await f.row(attempt.id)).status,N.status.expired);});
   await scenario('foreign_or_forged_completion_cannot_acknowledge',async f=>{await f.event();const attempt=await f.start();assert.equal(await f.pushes.finish({...attempt,leaseToken:randomUUID()},accepted(attempt),f.now()),false);assert.equal(await f.pushes.finish({...attempt,push:{...attempt.push,notificationId:randomUUID()}},accepted(attempt),f.now()),false);assert.equal((await f.row(attempt.id)).status,N.status.sending);});
   await scenario('producer_failure_rolls_back_notification_email_and_push',async f=>{const beforeRows=(await f.connection.select().from(schema.notifications)).length;try{await f.connection.transaction(async tx=>{await new DrizzleNotificationsRepository({db:tx}).record(f.intent);throw new Rollback();});}catch(e){assert(e instanceof Rollback);}assert.equal((await f.connection.select().from(schema.notifications)).length,beforeRows);assert.equal((await f.rows()).length,PROOF.zero);});
   await scenario('disabling_push_is_scoped_to_its_recipient',async f=>{
    await f.event();const otherInstallation=randomUUID(),otherAssociation=randomUUID();
    await f.registry.register(f.other.id,otherInstallation,randomBytes(PROOF.secretBytes).toString(I.crypto.encoding),{expectedVersion:I.revision.absent,associationId:otherAssociation,registrationId:randomUUID(),deviceToken:randomBytes(PROOF.tokenBytes).toString(I.crypto.encoding),environment:P.environment.development},f.now());
    const [application]=await f.connection.insert(schema.creatorApplications).values({userId:f.other.id,email:f.other.email,displayName:PROOF.copy,motivation:PROOF.copy}).returning();assert(application);
    const otherMessage=await f.writer.record({...f.intent,eventKey:randomUUID(),recipientUserId:f.other.id,resourceId:application.id});assert(otherMessage);await f.preference(false);
    const own=await f.rows();assert.equal(own.length,PROOF.one);assert.equal(own[PROOF.zero].status,N.status.cancelled);
    const [other]=await f.connection.select().from(schema.notificationPushDeliveries).where(eq(schema.notificationPushDeliveries.notificationId,otherMessage));assert(other);assert.equal(other.status,N.status.pending);
   });
   await scenario('outbox_insert_failure_rolls_back_notification_and_email',async f=>{
    const notificationsBefore=(await f.connection.select().from(schema.notifications)).length,emailsBefore=(await f.connection.select().from(schema.notificationEmailDeliveries)).length;
    await f.connection.execute(sql.raw('alter table ufit.notification_push_deliveries add constraint qualification_reject_new_push check (false) not valid'));
    await assert.rejects(()=>f.writer.record(f.intent));
    assert.equal((await f.connection.select().from(schema.notifications)).length,notificationsBefore);assert.equal((await f.connection.select().from(schema.notificationEmailDeliveries)).length,emailsBefore);assert.equal((await f.rows()).length,PROOF.zero);
   });
   await scenario('changed_environment_cancels_old_queued_delivery',async f=>{
    await f.event();const reservation=await f.reserve();await f.registry.register(f.actor.id,f.installationId,f.key,{expectedVersion:f.registered.version,associationId:f.associationId,registrationId:randomUUID(),deviceToken:f.deviceToken,environment:P.environment.production},f.advance(PROOF.one));
    assert.equal(await f.pushes.start(reservation,f.now()),null);assert.equal((await f.row(reservation.id)).lastFailure,N.failure.environment);
   });
   await scenario('expired_after_reservation_cannot_start',async f=>{await f.event();const reservation=await f.reserve();f.advance(N.limits.lifetimeMs);assert.equal(await f.pushes.start(reservation,f.now()),null);assert.equal((await f.row(reservation.id)).attempts,PROOF.zero);});
   await scenario('old_device_rejection_preserves_new_account',async f=>{
    await f.event();const attempt=await f.start(),fresh=await f.registry.register(f.other.id,f.installationId,f.key,{expectedVersion:f.registered.version,associationId:randomUUID(),registrationId:randomUUID(),deviceToken:f.deviceToken,environment:P.environment.development},f.advance(PROOF.one));
    assert(await f.pushes.finish(attempt,invalidDevice,f.now()));assert.equal((await f.registry.read(f.other.id,f.installationId,f.key)).associationId,fresh.associationId);assert.equal((await f.row(attempt.id)).status,N.status.rejected);
   });
   await scenario('lease_expired_rejection_cannot_invalidate_device',async f=>{await f.event();const attempt=await f.start();f.advance(N.limits.leaseMs+PROOF.one);assert.equal(await f.pushes.finish(attempt,invalidDevice,f.now()),false);assert.equal((await f.registry.read(f.actor.id,f.installationId,f.key)).state,I.state.registered);});
   await scenario('credential_rejection_can_resume_after_configuration_repair',async f=>{await f.event();const attempt=await f.start();assert(await f.pushes.finish(attempt,{outcome:P.outcome.rejected,reason:P.failure.credentials},f.now()));const row=await f.row(attempt.id);assert.equal(row.status,N.status.retry);assert.equal(row.nextAttemptAt.getTime()-f.now().getTime(),N.limits.credentialsRetryMs);});
   await scenario('rejected_provider_response_is_terminal',async f=>{await f.event();const attempt=await f.start();assert(await f.pushes.finish(attempt,{outcome:P.outcome.rejected,reason:P.failure.request},f.now()));assert.equal((await f.row(attempt.id)).status,N.status.rejected);assert.equal((await f.pushes.claim(P.environment.development,f.now())).length,PROOF.zero);});
   await scenario('wrong_provider_message_id_rejected_before_acknowledgment',async f=>{await f.event();const attempt=await f.start();await assert.rejects(()=>f.pushes.finish(attempt,{outcome:P.outcome.accepted,providerMessageId:randomUUID()},f.now()));assert.equal((await f.row(attempt.id)).status,N.status.sending);});
   await scenario('attempt_snapshot_cannot_change_while_sending',async f=>{await f.event();const attempt=await f.start();await assert.rejects(()=>f.connection.transaction(async()=>{await client.query('update ufit.notification_push_deliveries set device_token=$1 where id=$2',[randomBytes(PROOF.tokenBytes).toString(I.crypto.encoding),attempt.id]);}),e=>(e as {code?:string}).code==='23514');});
   async function storageScenario(name:string,query:string,parameters:(f:Fixture,row:typeof schema.notificationPushDeliveries.$inferSelect)=>unknown[]){await scenario(name,async f=>{await f.event();const [row]=await f.rows();await assert.rejects(()=>f.connection.transaction(async()=>{await client.query(query,parameters(f,row));}),e=>(e as {code?:string}).code==='23514');});}
   await storageScenario('immutable_delivery_identity','update ufit.notification_push_deliveries set id=$1 where id=$2',(_,row)=>[randomUUID(),row.id]);
   await storageScenario('immutable_notification_reference','update ufit.notification_push_deliveries set notification_id=$1 where id=$2',(_,row)=>[randomUUID(),row.id]);
   await storageScenario('immutable_environment','update ufit.notification_push_deliveries set environment=$1 where id=$2',(_,row)=>[P.environment.production,row.id]);
   await storageScenario('sending_requires_reservation_and_target','update ufit.notification_push_deliveries set status=$1 where id=$2',(_,row)=>[N.status.sending,row.id]);
   await storageScenario('invalid_status_rejected','update ufit.notification_push_deliveries set status=$1 where id=$2',(_,row)=>['invalid',row.id]);
   throw new Rollback();
  });}catch(error){if(!(error instanceof Rollback))throw error;}
  for(const table of tables)assert.equal(await fingerprint(table),before.get(table),'Original table unchanged: '+table);
  assert.equal((await client.query(PROOF.query.exists)).rows[PROOF.zero].present,!withMigration);
  console.log(JSON.stringify({cases:cases.length,scenarios:cases,tablesUnchanged:tables.length,migrationRolledBack:withMigration,providerCalls:PROOF.zero}));
 }finally{client.release();await pool.end();}
}
verify().catch(async error=>{await writeFile(PROOF.diagnostic,String(error.stack),{mode:0o600});console.error('Push SQL proof failed; private diagnostic saved');process.exitCode=1;});

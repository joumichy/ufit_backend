import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {and,eq,inArray,sql} from 'drizzle-orm';
import {getEnv} from '../src/config/env';
import {buildPgSslConfig} from '../src/shared/infrastructure/database/pg-ssl';
import * as schema from '../src/shared/infrastructure/database/schema';
import {DrizzleNotificationsRepository} from '../src/modules/notifications/infrastructure/drizzle-notifications.repository';
import {DrizzleNotificationPushesRepository} from '../src/modules/notifications/infrastructure/drizzle-notification-pushes.repository';
import {DrizzleNotificationInstallationsRepository} from '../src/modules/notifications/infrastructure/drizzle-notification-installations.repository';
import {NOTIFICATION as MESSAGE} from '../src/modules/notifications/domain/notification.contract';
import {NOTIFICATION_EMAIL as EMAIL} from '../src/modules/notifications/domain/notification-email.contract';
import {NOTIFICATION_PUSH as N,type ReservedNotificationPush} from '../src/modules/notifications/domain/notification-push.contract';
import {PUSH_DELIVERY as P} from '../src/modules/notifications/domain/push-delivery';
import {INSTALLATION as I} from '../src/modules/notifications/domain/notification-installation';

const PROOF={profile:{node:'development',port:4014,schema:'ufit',stripe:'sk_test_'},zero:0,one:1,two:2,three:3,four:4,secretBytes:32,tokenBytes:16,
  registry:homedir()+'/.codex/private/ufit/qualification.credentials.json',fixtures:homedir()+'/.codex/private/ufit/qualification.push-outbox.json',
  copy:'Qualification locale push — aucun envoi',keyPrefix:'qualification/push-concurrency/',timeoutMs:10_000,
  diagnostic:'/tmp/ufit-push-concurrency-diagnostic.txt',encoding:'utf8',fileMode:0o600,
} as const;
async function verify(){
 const env=getEnv();assert(env.NODE_ENV===PROOF.profile.node&&env.API_PORT===PROOF.profile.port&&env.UFIT_DB_SCHEMA===PROOF.profile.schema&&env.STRIPE_SECRET_KEY?.startsWith(PROOF.profile.stripe)&&!env.NOTIFICATION_EMAIL_ENABLED&&!env.NOTIFICATION_PUSH_ENABLED);
 const credentials=JSON.parse(await readFile(PROOF.registry,PROOF.encoding));
 let fixtures:Record<string,unknown>={};try{fixtures=JSON.parse(await readFile(PROOF.fixtures,PROOF.encoding));}catch(error){if((error as {code?:string}).code!=='ENOENT')throw error;}
 const runId=randomUUID();fixtures[runId]={installationId:randomUUID(),associationId:randomUUID(),registrationId:randomUUID(),key:randomBytes(PROOF.secretBytes).toString(I.crypto.encoding),token:randomBytes(PROOF.tokenBytes).toString(I.crypto.encoding),events:Array.from({length:PROOF.four},()=>randomUUID())};
 await writeFile(PROOF.fixtures,JSON.stringify(fixtures),{mode:PROOF.fileMode});
 // All installation credentials are consumed from their private owner after provisioning.
 const stored=JSON.parse(await readFile(PROOF.fixtures,PROOF.encoding))[runId] as {installationId:string;associationId:string;registrationId:string;key:string;token:string;events:string[]};
 const pool=new Pool({connectionString:env.SUPABASE_DIRECT_CONNECTION_DB_URL,ssl:buildPgSslConfig(env),max:PROOF.three,connectionTimeoutMillis:PROOF.timeoutMs});
 const db=drizzle(pool,{schema}),pushes=new DrizzleNotificationPushesRepository({db}),registry=new DrizzleNotificationInstallationsRepository({db});
 const ids:string[]=[];let actorId:string|undefined;
 let releaseFirst!:()=>void;const release=new Promise<void>(resolve=>{releaseFirst=resolve;});let firstDone:Promise<void>|undefined;
 try{
  const [actor]=await db.select().from(schema.users).where(eq(schema.users.email,credentials.creator.email));assert(actor);actorId=actor.id;
  const [application]=await db.select({id:schema.creatorApplications.id}).from(schema.creatorApplications).where(eq(schema.creatorApplications.userId,actor.id)).limit(PROOF.one);assert(application);
  const pending=await db.select({id:schema.notificationPushDeliveries.id}).from(schema.notificationPushDeliveries).where(inArray(schema.notificationPushDeliveries.status,[N.status.pending,N.status.reserved,N.status.retry,N.status.sending]));assert.equal(pending.length,PROOF.zero,'No unrelated active queue in this qualification plane');
  await db.transaction(async tx=>{
   await new DrizzleNotificationInstallationsRepository({db:tx}).register(actor.id,stored.installationId,stored.key,{expectedVersion:I.revision.absent,associationId:stored.associationId,
    registrationId:stored.registrationId,deviceToken:stored.token,environment:P.environment.development});
   const writer=new DrizzleNotificationsRepository({db:tx});
   for(const event of stored.events){const id=await writer.record({eventKey:PROOF.keyPrefix+event,recipientUserId:actor.id,resourceType:MESSAGE.resource.creatorApplication,
    resourceId:application.id,audience:MESSAGE.audience.applicant,brandId:null,subject:PROOF.copy,text:PROOF.copy});assert(id);ids.push(id);}
  });
  let first:ReservedNotificationPush[]=[];let firstPid:number|undefined,secondPid:number|undefined;
  let firstReserved!:()=>void;const firstReady=new Promise<void>(resolve=>{firstReserved=resolve;});
  firstDone=db.transaction(async tx=>{
   const pid=await tx.execute<{pid:number}>(sql`select pg_backend_pid() pid`);firstPid=pid.rows[PROOF.zero].pid;
   first=await new DrizzleNotificationPushesRepository({db:tx}).claim(P.environment.development);firstReserved();await release;
  });
  // A failure must settle the readiness gate too, so qualification cannot hang behind a lost transaction.
  void firstDone.catch(()=>firstReserved());await firstReady;
  const second=await db.transaction(async tx=>{const pid=await tx.execute<{pid:number}>(sql`select pg_backend_pid() pid`);secondPid=pid.rows[PROOF.zero].pid;return new DrizzleNotificationPushesRepository({db:tx}).claim(P.environment.development);});
  releaseFirst();await firstDone;
  assert.notEqual(firstPid,secondPid);assert.equal(first.length,N.limits.batch);assert.equal(second.length,N.limits.batch);
  const reservations=[...first,...second];assert.equal(new Set(reservations.map(row=>row.id)).size,PROOF.four);
  const rows=await db.select().from(schema.notificationPushDeliveries).where(inArray(schema.notificationPushDeliveries.notificationId,ids));
  assert.equal(rows.length,PROOF.four);assert.deepEqual(new Set(rows.map(row=>row.id)),new Set(reservations.map(row=>row.id)));
  assert(rows.every(row=>row.status===N.status.reserved&&row.attempts===PROOF.zero&&row.deviceToken===null));
  const starts=await Promise.all([pushes.start(reservations[PROOF.zero]),pushes.start(reservations[PROOF.zero])]);const started=starts.filter(value=>value!==null);
  assert.equal(started.length,PROOF.one);assert.equal(starts.filter(value=>value===null).length,PROOF.one);
  // No transport is invoked by this verifier. A known unsent attempt is released, then detached.
  assert(await pushes.finish(started[PROOF.zero],{outcome:P.outcome.retry,reason:P.failure.closed,retryAfterMs:N.limits.firstRetryMs}));
  await registry.detach(stored.installationId,stored.associationId,stored.key,{});
  for(const reservation of reservations.slice(PROOF.one)){assert.equal(await pushes.start(reservation),null);}
  console.log(JSON.stringify({workers:PROOF.two,distinctDatabaseConnections:firstPid!==secondPid,reserved:reservations.length,duplicateReservations:PROOF.zero,
    concurrentStarts:PROOF.two,successfulStarts:started.length,providerCalls:PROOF.zero,liveDeviceEnrollment:false}));
 }finally{
  try{
  releaseFirst();await firstDone?.catch(()=>undefined);
  await registry.detach(stored.installationId,stored.associationId,stored.key,{});
  if(ids.length){
   await db.update(schema.notificationPushDeliveries).set({status:N.status.cancelled,leaseToken:null,leaseUntil:null,lastFailure:N.failure.association,updatedAt:new Date()})
    .where(and(inArray(schema.notificationPushDeliveries.notificationId,ids),inArray(schema.notificationPushDeliveries.status,[N.status.pending,N.status.retry,N.status.reserved])));
   await db.update(schema.notificationEmailDeliveries).set({status:EMAIL.status.cancelled,updatedAt:new Date()})
    .where(and(inArray(schema.notificationEmailDeliveries.notificationId,ids),eq(schema.notificationEmailDeliveries.status,EMAIL.status.pending)));
  }
  if(actorId){const state=await registry.read(actorId,stored.installationId,stored.key);assert.equal(state.state,I.state.detached);}
  const finalRows=ids.length?await db.select().from(schema.notificationPushDeliveries).where(inArray(schema.notificationPushDeliveries.notificationId,ids)):[];
  assert(finalRows.every(row=>row.status===N.status.cancelled&&row.providerMessageId===null));
  }finally{await pool.end();}
 }
}
verify().catch(async error=>{await writeFile(PROOF.diagnostic,String(error.stack),{mode:PROOF.fileMode});console.error('Push concurrency proof failed; private diagnostic saved');process.exitCode=1;});

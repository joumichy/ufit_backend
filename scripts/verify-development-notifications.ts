import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {eq,sql} from 'drizzle-orm';
import {getTableConfig} from 'drizzle-orm/pg-core';
import {getEnv} from '../src/config/env';
import {buildPgSslConfig} from '../src/shared/infrastructure/database/pg-ssl';
import type {DatabaseSession} from '../src/shared/infrastructure/database/database-session';
import * as schema from '../src/shared/infrastructure/database/schema';
import {DrizzleNotificationEmailsRepository} from '../src/modules/notifications/infrastructure/drizzle-notification-emails.repository';
import {DrizzleNotificationPushesRepository} from '../src/modules/notifications/infrastructure/drizzle-notification-pushes.repository';
import {DrizzleNotificationInstallationsRepository} from '../src/modules/notifications/infrastructure/drizzle-notification-installations.repository';
import {DrizzleNotificationsRepository} from '../src/modules/notifications/infrastructure/drizzle-notifications.repository';
import {NOTIFICATION as MESSAGE} from '../src/modules/notifications/domain/notification.contract';
import {NOTIFICATION_EMAIL as EMAIL} from '../src/modules/notifications/domain/notification-email.contract';
import {EMAIL_DELIVERY as DELIVERY,EMAIL_PROVIDER,type EmailProvider} from '../src/modules/notifications/domain/email-delivery';
import {PUSH_DELIVERY as PUSH} from '../src/modules/notifications/domain/push-delivery';
import {NOTIFICATION_PUSH} from '../src/modules/notifications/domain/notification-push.contract';
import {INSTALLATION} from '../src/modules/notifications/domain/notification-installation';

const PROOF={environment:'development',port:4014,schema:'ufit',zero:0,one:1,offsetMs:1_000,secretBytes:32,tokenBytes:8,
  withMigration:'--with-migration',migration:'../src/shared/infrastructure/database/migrations/0053_development_notification_delivery.sql',
  domain:'@ufit.invalid',copy:'Qualification notifications annulée sans envoi',receipt:'mailpit-opaque-receipt',
  sender:{name:'Ufit',address:'no-reply@ufit.invalid'},badReceipt:'invalid receipt',checkViolation:'23514',
  tables:"select table_name from information_schema.tables where table_schema='ufit' and table_type='BASE TABLE' order by table_name",
  hashPrefix:"select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as digest from ufit.",hashSuffix:' t',
  providerColumn:"select data_type from information_schema.columns where table_schema='ufit' and table_name='notification_email_deliveries' and column_name='provider'",
  checks:"select conname from pg_constraint where conrelid='ufit.notification_email_deliveries'::regclass and contype='c'",
  receiptUpdate:"update ufit.notification_email_deliveries set status='accepted',provider_message_id=$1,accepted_at=$3,lease_token=null,lease_until=null,last_failure=null where id=$2",
  providerUpdate:'update ufit.notification_email_deliveries set provider=$1 where id=$2',
} as const;
class Rollback extends Error {}

async function verify(){
  const env=getEnv();
  assert(env.NODE_ENV===PROOF.environment&&env.API_PORT===PROOF.port&&env.UFIT_DB_SCHEMA===PROOF.schema,
    'Use only the selected Ufit development profile');
  assert(!env.NOTIFICATION_EMAIL_ENABLED&&!env.NOTIFICATION_PUSH_ENABLED&&!env.UFIT_DEVELOPMENT_NOTIFICATIONS_CONFIG,
    'Workers must remain disabled for the rollback proof');
  const pool=new Pool({connectionString:env.SUPABASE_DIRECT_CONNECTION_DB_URL,ssl:buildPgSslConfig(env),max:PROOF.one});
  const client=await pool.connect(),database=drizzle(client,{schema}),cases:string[]=[];
  const withMigration=process.argv.includes(PROOF.withMigration);
  const tables=(await client.query<{table_name:string}>(PROOF.tables)).rows.map(row=>row.table_name);
  async function fingerprint(table:string){assert(/^[a-z_]+$/.test(table));return (await client.query(PROOF.hashPrefix+table+PROOF.hashSuffix)).rows[PROOF.zero].digest;}
  const before=new Map<string,string>();
  try{
    const hadProvider=(await client.query(PROOF.providerColumn)).rows.length>PROOF.zero;
    assert.equal(hadProvider,!withMigration,'Migration option matches the actual schema');
    for(const table of tables)before.set(table,await fingerprint(table));
    try{await database.transaction(async transaction=>{
      if(withMigration)await transaction.execute(sql.raw(await readFile(resolve(__dirname,PROOF.migration),'utf8')));
      const metadata=getTableConfig(schema.notificationEmailDeliveries);
      assert.deepEqual((await client.query<{conname:string}>(PROOF.checks)).rows.map(row=>row.conname).sort(),metadata.checks.map(check=>check.name).sort());
      cases.push('schema_constraints_match');
      async function fixture(database:DatabaseSession){
        const db=database.db,emails=new DrizzleNotificationEmailsRepository(database),pushes=new DrizzleNotificationPushesRepository(database);
        const installations=new DrizzleNotificationInstallationsRepository(database),writer=new DrizzleNotificationsRepository(database);
        const [actor,other]=await db.insert(schema.users).values([PROOF.one,PROOF.zero].map(()=>({supabaseUserId:randomUUID(),email:randomUUID()+PROOF.domain}))).returning();
        assert(actor&&other);
        const [application]=await db.insert(schema.creatorApplications).values({userId:actor.id,email:actor.email,displayName:PROOF.copy,motivation:PROOF.copy}).returning();
        assert(application);
        const now=new Date(Date.now()+PROOF.offsetMs),startsAt=new Date(now.getTime()-PROOF.offsetMs);
        for(const actorId of [actor.id,other.id])await installations.register(actorId,randomUUID(),randomBytes(PROOF.secretBytes).toString(INSTALLATION.crypto.encoding),
          {expectedVersion:INSTALLATION.revision.absent,associationId:randomUUID(),registrationId:randomUUID(),
            deviceToken:randomBytes(PROOF.tokenBytes).toString(INSTALLATION.crypto.encoding),environment:PUSH.environment.development},startsAt);
        const scope={recipientUserId:actor.id,startsAt};
        const intent={recipientUserId:actor.id,resourceType:MESSAGE.resource.creatorApplication,resourceId:application.id,
          audience:MESSAGE.audience.applicant,brandId:null,subject:PROOF.copy,text:PROOF.copy};
        async function event(recipientUserId=actor.id,createdAt=startsAt){
          const {text,...notification}=intent;
          const [value]=await db.insert(schema.notifications).values({...notification,eventKey:randomUUID(),recipientUserId,bodyText:text,createdAt}).returning();assert(value);
          await emails.enqueue(value.id);await pushes.enqueue(value.id);return value.id;
        }
        async function row(id:string){const [value]=await db.select().from(schema.notificationEmailDeliveries).where(eq(schema.notificationEmailDeliveries.id,id));assert(value);return value;}
        async function claim(provider:EmailProvider=EMAIL_PROVIDER.mailpit){const values=await emails.claim(PROOF.sender,now,scope,provider);assert.equal(values.length,PROOF.one);return values[PROOF.zero];}
        return {db,actor,other,writer,emails,pushes,scope,now,event,row,claim,intent};
      }
      type Fixture=Awaited<ReturnType<typeof fixture>>;
      async function scenario(name:string,body:(fixture:Fixture)=>Promise<void>){
        try{await transaction.transaction(async db=>{await body(await fixture({db}));throw new Rollback();});}
        catch(error){if(!(error instanceof Rollback))throw error;}cases.push(name);
      }
      await scenario('email_and_push_exclude_history_and_other_recipients',async f=>{
        const old=await f.event(f.actor.id,new Date(f.scope.startsAt.getTime()-PROOF.one));
        const other=await f.event(f.other.id),fresh=await f.event();
        const email=await f.claim();assert.equal(email.email.text.endsWith(fresh),true);
        const reservations=await f.pushes.claim(PUSH.environment.development,f.now,f.scope);assert.equal(reservations.length,PROOF.one);
        const [push]=await f.db.select().from(schema.notificationPushDeliveries).where(eq(schema.notificationPushDeliveries.id,reservations[PROOF.zero].id));assert.equal(push.notificationId,fresh);
        for(const id of [old,other]){
          const [email]=await f.db.select().from(schema.notificationEmailDeliveries).where(eq(schema.notificationEmailDeliveries.notificationId,id));assert.equal(email.status,EMAIL.status.pending);
          const [push]=await f.db.select().from(schema.notificationPushDeliveries).where(eq(schema.notificationPushDeliveries.notificationId,id));assert.equal(push.status,NOTIFICATION_PUSH.status.pending);
        }
      });
      await scenario('opaque_receipt_persisted_exactly_and_accepted_not_reclaimed',async f=>{
        await f.event();const claim=await f.claim();
        assert(await f.emails.finish(claim,{outcome:DELIVERY.outcome.accepted,providerMessageId:PROOF.receipt},f.now));
        assert.equal((await f.row(claim.id)).providerMessageId,PROOF.receipt);
        assert.equal((await f.emails.claim(PROOF.sender,f.now,f.scope,EMAIL_PROVIDER.mailpit)).length,PROOF.zero);
      });
      await scenario('lost_mailpit_response_is_uncertain_without_resend',async f=>{
        await f.event();const claim=await f.claim();
        assert(await f.emails.finish(claim,{outcome:DELIVERY.outcome.unknown,reason:DELIVERY.failure.transport},f.now));
        assert.equal((await f.row(claim.id)).status,EMAIL.status.uncertain);
        assert.equal((await f.emails.claim(PROOF.sender,new Date(f.now.getTime()+EMAIL.limits.leaseMs),f.scope,EMAIL_PROVIDER.mailpit)).length,PROOF.zero);
      });
      await scenario('crashed_mailpit_lease_not_reposted_and_stale_receipt_refused',async f=>{
        await f.event();const claim=await f.claim(),later=new Date(f.now.getTime()+EMAIL.limits.leaseMs+PROOF.one);
        assert.equal((await f.emails.claim(PROOF.sender,later,f.scope,EMAIL_PROVIDER.mailpit)).length,PROOF.zero);
        assert.equal((await f.row(claim.id)).status,EMAIL.status.uncertain);
        assert.equal(await f.emails.finish(claim,{outcome:DELIVERY.outcome.accepted,providerMessageId:PROOF.receipt},later),false);
      });
      await scenario('resend_unknown_keeps_idempotent_retry_and_cannot_switch_provider',async f=>{
        await f.event();const claim=await f.claim(EMAIL_PROVIDER.resend);
        assert(await f.emails.finish(claim,{outcome:DELIVERY.outcome.unknown,reason:DELIVERY.failure.transport},f.now));
        const current=await f.row(claim.id);assert.equal(current.status,EMAIL.status.retry);
        assert.equal((await f.emails.claim(PROOF.sender,current.nextAttemptAt,f.scope,EMAIL_PROVIDER.mailpit)).length,PROOF.zero);
        const [retry]=await f.emails.claim(PROOF.sender,current.nextAttemptAt,f.scope,EMAIL_PROVIDER.resend);assert(retry);assert.deepEqual(retry.email,claim.email);
      });
      await scenario('database_rejects_provider_changes_and_invalid_receipts',async f=>{
        await f.event();const claim=await f.claim();
        for(const [query,parameters] of [[PROOF.providerUpdate,[EMAIL_PROVIDER.resend,claim.id]],[PROOF.receiptUpdate,[PROOF.badReceipt,claim.id,f.now]]] as const)
          await assert.rejects(()=>f.db.transaction(async()=>{await client.query(query,[...parameters]);}),error=>(error as {code?:string}).code===PROOF.checkViolation);
      });
      await scenario('canonical_recorder_replay_is_one_notification_and_two_outboxes',async f=>{
        const intent={...f.intent,eventKey:randomUUID()},id=await f.writer.record(intent);assert(id);assert.equal(await f.writer.record(intent),id);
        const [email]=await f.db.select().from(schema.notificationEmailDeliveries).where(eq(schema.notificationEmailDeliveries.notificationId,id));assert(email);
        const [push]=await f.db.select().from(schema.notificationPushDeliveries).where(eq(schema.notificationPushDeliveries.notificationId,id));assert(push);
      });
      throw new Rollback();
    });}catch(error){if(!(error instanceof Rollback))throw error;}
    for(const table of tables)assert.equal(await fingerprint(table),before.get(table),'Original table restored: '+table);
    assert.equal((await client.query(PROOF.providerColumn)).rows.length>PROOF.zero,hadProvider);
    console.log(JSON.stringify({cases,tablesUnchanged:tables.length,migrationRolledBack:withMigration,providerCalls:PROOF.zero}));
  }finally{client.release();await pool.end();}
}
verify().catch(()=>{console.error('Development notification rollback proof failed.');process.exitCode=PROOF.one;});

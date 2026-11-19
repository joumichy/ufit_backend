import {verifyNotificationProducers} from './notification-producer-proof';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {eq, sql} from 'drizzle-orm';
import {getTableConfig} from 'drizzle-orm/pg-core';
import {HttpException} from '@nestjs/common';
import {getEnv} from '../src/config/env';
import {buildPgSslConfig} from '../src/shared/infrastructure/database/pg-ssl';
import * as schema from '../src/shared/infrastructure/database/schema';
import {DrizzleNotificationEmailsRepository} from '../src/modules/notifications/infrastructure/drizzle-notification-emails.repository';
import {DrizzleNotificationsRepository} from '../src/modules/notifications/infrastructure/drizzle-notifications.repository';
import {NOTIFICATION,type NotificationIntent} from '../src/modules/notifications/domain/notification.contract';
import {NOTIFICATION_EMAIL as N} from '../src/modules/notifications/domain/notification-email.contract';
import {EMAIL_DELIVERY as E} from '../src/modules/notifications/domain/email-delivery';

const proof = {
  profile: {node:'development',port:4014,schema:'ufit',stripePrefix:'sk_test_'},
  registry:homedir()+'/.codex/private/ufit/qualification.credentials.json',
  migration:new URL('../src/shared/infrastructure/database/migrations/0024_notification_email_outbox.sql','file://'+__filename),
  table:'notification_email_deliveries', withMigration:'--with-migration',
  subject:'Qualification transactionnelle Ufit',text:'Intention de qualification annulée, aucun e-mail envoyé.',
  changed:'Contenu différent',eventPrefix:'qualification-notification/',sender:{name:'Ufit',address:'onboarding@resend.dev'},
  otherSender:{name:'Ufit nouveau',address:'changed@example.invalid'},
  first:0,zero:0,one:1,two:2,three:3,offsetMs:1000,afterLease:1,
  conflict:409,missing:404,checkViolation:'23514',badStatus:'not-a-status',
  diagnostic:'/tmp/ufit-notification-email-sql-diagnostic.txt',
} as const;
class VerificationRollback extends Error {}
async function verify() {
  const env=getEnv();
  assert(env.NODE_ENV===proof.profile.node&&env.API_PORT===proof.profile.port&&env.UFIT_DB_SCHEMA===proof.profile.schema&&env.STRIPE_SECRET_KEY?.startsWith(proof.profile.stripePrefix),'Selected development data plane');
  const registry=JSON.parse(await readFile(proof.registry,'utf8'));
  const pool=new Pool({connectionString:env.SUPABASE_DIRECT_CONNECTION_DB_URL,ssl:buildPgSslConfig(env),max:proof.one});
  const client=await pool.connect(),database=drizzle(client,{schema});
  const withMigration=process.argv.includes(proof.withMigration);
  const tables=(await client.query<{table_name:string}>("select table_name from information_schema.tables where table_schema='ufit' and table_type='BASE TABLE' order by table_name")).rows.map(row=>row.table_name);
  assert.equal(tables.includes(proof.table),!withMigration,'Migration flag matches actual table state');
  async function fingerprint(table:string) {
    assert(/^[a-z_]+$/.test(table));
    const result=await client.query("select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as digest from ufit."+table+' t');
    return result.rows[proof.first].digest as string;
  }
  const before=new Map<string,string>();let cases=proof.zero as number,producerCases=proof.zero as number;
  try {
    for(const table of tables)before.set(table,await fingerprint(table));
    try {
      await database.transaction(async db=>{
        if(withMigration)await db.execute(sql.raw(await readFile(proof.migration,'utf8')));
        const parentMetadata=getTableConfig(schema.notifications);
        const parentChecks=(await client.query<{conname:string}>("select conname from pg_constraint where conrelid='ufit.notifications'::regclass and contype='c' order by conname")).rows.map(row=>row.conname);
        assert.deepEqual(parentChecks,parentMetadata.checks.map(check=>check.name).sort());cases++;
        const metadata=getTableConfig(schema.notificationEmailDeliveries);
        const storedChecks=(await client.query<{conname:string}>("select conname from pg_constraint where conrelid='ufit.notification_email_deliveries'::regclass and contype='c' order by conname")).rows.map(row=>row.conname);
        assert.deepEqual(storedChecks,metadata.checks.map(check=>check.name).sort());cases++;
        const [recipient]=await db.select().from(schema.users).where(eq(schema.users.email,registry.customer.email));assert(recipient);
        const [order]=await db.select({id:schema.orders.id}).from(schema.orders).limit(proof.one);assert(order,'Existing order reference');
        const repository=new DrizzleNotificationEmailsRepository({db});
        const recorder=new DrizzleNotificationsRepository({db});
        const table=schema.notificationEmailDeliveries;
        const base={eventKey:proof.eventPrefix+randomUUID(),recipientUserId:recipient.id,resourceType:NOTIFICATION.resource.order,resourceId:order.id,subject:proof.subject,text:proof.text,audience:NOTIFICATION.audience.customer,brandId:null};
        async function enqueue(input:NotificationIntent){const id=await recorder.record(input);assert(id);const [email]=await db.select({id:table.id}).from(table).where(eq(table.notificationId,id));assert(email);return email.id;}
        async function row(id:string){const [value]=await db.select().from(table).where(eq(table.id,id));assert(value);return value;}
        async function storageReject(query:string,values:unknown[],code:string=proof.checkViolation){
          await assert.rejects(()=>db.transaction(async()=>{await client.query(query,values);}),error=>{
            const failure=error as {code?:string};return failure.code===code;
          });cases++;
        }
        const id=await enqueue(base);assert(id);assert.equal((await row(id)).status,N.status.pending);cases++;
        assert.equal(await enqueue(base),id);cases++;
        const envelope=await row(id);
        assert.equal(envelope.bodyText,base.text+NOTIFICATION.link.paragraph+NOTIFICATION.link.prefix+envelope.notificationId);cases++;
        await storageReject('update ufit.notifications set subject=$1 where id=$2',[proof.changed,envelope.notificationId]);
        await storageReject('update ufit.notifications set id=$1 where id=$2',[randomUUID(),envelope.notificationId]);
        await storageReject('insert into ufit.notifications(event_key,recipient_user_id,resource_type,resource_id,audience,subject,body_text) values($1,$2,$3,$4,$5,$6,$7)',
          [proof.eventPrefix+randomUUID(),recipient.id,NOTIFICATION.resource.order,order.id,NOTIFICATION.audience.applicant,proof.subject,proof.text]);
        const atomicKey=proof.eventPrefix+randomUUID();
        await assert.rejects(()=>db.transaction(async atomic=>{
          await new DrizzleNotificationsRepository({db:atomic}).record({...base,eventKey:atomicKey});
          throw new VerificationRollback();
        }),error=>error instanceof VerificationRollback);
        assert.equal((await db.select().from(schema.notifications).where(eq(schema.notifications.eventKey,atomicKey))).length,proof.zero);cases++;

        await assert.rejects(()=>enqueue({...base,text:proof.changed}),error=>error instanceof HttpException&&error.getStatus()===proof.conflict);cases++;
        await assert.rejects(()=>enqueue({...base,eventKey:proof.eventPrefix+randomUUID(),recipientUserId:randomUUID()}),error=>error instanceof HttpException&&error.getStatus()===proof.missing);cases++;
        await storageReject('update ufit.notification_email_deliveries set subject=$1 where id=$2',[proof.changed,id]);
        await storageReject('update ufit.notification_email_deliveries set id=$1 where id=$2',[randomUUID(),id]);
        await storageReject('update ufit.notification_email_deliveries set status=$1 where id=$2',[proof.badStatus,id]);
        await storageReject('update ufit.notification_email_deliveries set status=$1 where id=$2',[N.status.processing,id]);
        await storageReject('update ufit.notification_email_deliveries set provider_message_id=$1 where id=$2',[proof.changed,id]);
        const now=new Date(Date.now()+proof.offsetMs);
        const claimed=await repository.claim(proof.sender,now);assert.equal(claimed.length,proof.one);assert.equal(claimed[proof.first].id,id);assert.equal(claimed[proof.first].attempts,proof.one);cases++;
        assert.equal((await repository.claim(proof.sender,now)).length,proof.zero);cases++;
        const reacquired=await repository.claim(proof.otherSender,new Date(now.getTime()+N.limits.leaseMs+proof.afterLease));assert.equal(reacquired.length,proof.one);
        const latest=reacquired[proof.first];assert.equal(latest.attempts,proof.two);assert.deepEqual(latest.email,claimed[proof.first].email);cases++;
        assert.equal(await repository.finish(claimed[proof.first],{outcome:E.outcome.accepted,providerMessageId:randomUUID()},new Date(now.getTime()+N.limits.leaseMs)),false);cases++;
        const later=new Date(now.getTime()+N.limits.leaseMs+proof.two);
        assert.equal(await repository.finish(latest,{outcome:E.outcome.unknown,reason:E.failure.transport},later),true);assert.equal((await row(id)).status,N.status.retry);cases++;
        assert.equal((await repository.claim(proof.otherSender,later)).length,proof.zero);cases++;
        const retry=await repository.claim(proof.otherSender,(await row(id)).nextAttemptAt);assert.equal(retry.length,proof.one);assert.deepEqual(retry[proof.first].email,latest.email);assert.equal(retry[proof.first].attempts,proof.three);cases++;
        const providerId=randomUUID(),acceptedAt=new Date((await row(id)).nextAttemptAt.getTime()+proof.one);
        assert.equal(await repository.finish(retry[proof.first],{outcome:E.outcome.accepted,providerMessageId:providerId},acceptedAt),true);
        assert.equal((await row(id)).providerMessageId,providerId);assert.equal((await row(id)).status,N.status.accepted);cases++;
        assert.equal((await repository.claim(proof.sender,acceptedAt)).length,proof.zero);cases++;
        await storageReject('update ufit.notification_email_deliveries set first_attempt_at=$1 where id=$2',[acceptedAt,id]);
        await storageReject('update ufit.notification_email_deliveries set status=$1,provider_message_id=null,accepted_at=null where id=$2',[N.status.retry,id]);
        const expiredId=await enqueue({...base,eventKey:proof.eventPrefix+randomUUID()});assert(expiredId);
        const expireClaim=(await repository.claim(proof.sender,acceptedAt))[proof.first];assert.equal(expireClaim.id,expiredId);
        await repository.finish(expireClaim,{outcome:E.outcome.unknown,reason:E.failure.transport},acceptedAt);
        const expired=await repository.claim(proof.sender,new Date(acceptedAt.getTime()+E.limits.idempotencyWindowMs+proof.one));assert.equal(expired.length,proof.zero);assert.equal((await row(expiredId)).status,N.status.uncertain);cases++;
        const cancelledId=await enqueue({...base,eventKey:proof.eventPrefix+randomUUID()});assert(cancelledId);
        await db.update(schema.users).set({email:randomUUID()+'@example.invalid'}).where(eq(schema.users.id,recipient.id));
        assert.equal((await repository.claim(proof.sender,acceptedAt)).length,proof.zero);assert.equal((await row(cancelledId)).status,N.status.cancelled);cases++;
        producerCases=await verifyNotificationProducers({db});
        throw new VerificationRollback();
      });
    }catch(error){if(!(error instanceof VerificationRollback))throw error;}
    for(const table of tables)assert.equal(await fingerprint(table),before.get(table),'Original table restored: '+table);
    const present=(await client.query("select to_regclass('ufit.notification_email_deliveries') is not null as present")).rows[proof.first].present;
    assert.equal(present,!withMigration,'Migration did not persist during preflight');
    console.log(JSON.stringify({cases,producerCases,tablesUnchanged:tables.length,migrationRolledBack:withMigration,providerCalls:proof.zero}));
  }finally{client.release();await pool.end();}
}
verify().catch(async error=>{
  await writeFile(proof.diagnostic,String(error?.stack??error)+'\n'+String(error?.cause?.stack??''),{mode:0o600});
  console.error('Notification outbox SQL proof failed; private diagnostic saved.');process.exitCode=proof.one;
});

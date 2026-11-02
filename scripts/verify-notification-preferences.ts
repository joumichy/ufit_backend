import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {eq,sql} from 'drizzle-orm';
import {HttpException} from '@nestjs/common';
import {getEnv} from '../src/config/env';
import {buildPgSslConfig} from '../src/shared/infrastructure/database/pg-ssl';
import * as schema from '../src/shared/infrastructure/database/schema';
import {DrizzleNotificationPreferencesRepository} from '../src/modules/notifications/infrastructure/drizzle-notification-preferences.repository';
import {DrizzleNotificationsRepository} from '../src/modules/notifications/infrastructure/drizzle-notifications.repository';
import {DrizzleNotificationEmailsRepository} from '../src/modules/notifications/infrastructure/drizzle-notification-emails.repository';
import {NOTIFICATION_PREFERENCES as PREF,notificationPreferencesSchema} from '../src/modules/notifications/domain/notification-preferences';
import {NOTIFICATION_EMAIL as EMAIL} from '../src/modules/notifications/domain/notification-email.contract';
import {EMAIL_DELIVERY} from '../src/modules/notifications/domain/email-delivery';

const PROOF={profile:{node:'development',port:4014,schema:'ufit',stripe:'sk_test_'},one:1,zero:0,first:0,two:2,three:3,
  amount:100,currency:'CHF',domain:'@example.invalid',label:'Qualification des préférences',eventPrefix:'qualification-preferences/',
  withMigration:'--with-migration',table:'notification_preferences',migration:new URL('../src/shared/infrastructure/database/migrations/0025_notification_preferences.sql','file://'+__filename),
  diagnostic:'/tmp/ufit-notification-preferences-diagnostic.txt',sender:{name:'Ufit',address:'onboarding@resend.dev'},
  status:{conflict:409,bad:400,forbidden:403},sql:{check:'23514',foreign:'23503'},offset:1000,afterLease:1} as const;
class RollbackProof extends Error {}
async function verify(){
  const env=getEnv();assert(env.NODE_ENV===PROOF.profile.node&&env.API_PORT===PROOF.profile.port&&env.UFIT_DB_SCHEMA===PROOF.profile.schema&&env.STRIPE_SECRET_KEY?.startsWith(PROOF.profile.stripe));
  const pool=new Pool({connectionString:env.SUPABASE_DIRECT_CONNECTION_DB_URL,ssl:buildPgSslConfig(env),max:PROOF.one});const client=await pool.connect();
  const db=drizzle(client,{schema}),withMigration=process.argv.includes(PROOF.withMigration);
  const tables=(await client.query<{table_name:string}>("select table_name from information_schema.tables where table_schema='ufit' and table_type='BASE TABLE' order by table_name")).rows.map(row=>row.table_name);
  assert.equal(tables.includes(PROOF.table),!withMigration);
  async function hash(table:string){assert(/^[a-z_]+$/.test(table));return (await client.query("select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) digest from ufit."+table+' t')).rows[PROOF.first].digest as string;}
  const before=new Map<string,string>();let cases=PROOF.zero as number;
  try{
    for(const t of tables)before.set(t,await hash(t));
    try{await db.transaction(async tx=>{
      if(withMigration)await tx.execute(sql.raw(await readFile(PROOF.migration,'utf8')));
      const session={db:tx},preferences=new DrizzleNotificationPreferencesRepository(session),writer=new DrizzleNotificationsRepository(session),queue=new DrizzleNotificationEmailsRepository(session);
      async function actor(){const [user]=await tx.insert(schema.users).values({supabaseUserId:randomUUID(),email:randomUUID()+PROOF.domain}).returning();return user;}
      const a=await actor(),b=await actor();const [brand]=await tx.select({id:schema.brandProfiles.id}).from(schema.brandProfiles).limit(PROOF.one);assert(brand);
      async function order(userId:string){const [row]=await tx.insert(schema.orders).values({orderNumber:PROOF.eventPrefix+randomUUID(),customerId:userId,brandId:brand.id,
        subtotalAmount:PROOF.amount,totalAmount:PROOF.amount,currency:PROOF.currency,shippingAddress:{name:PROOF.label}}).returning({id:schema.orders.id});return row.id;}
      const aOrder=await order(a.id),bOrder=await order(b.id);
      async function message(userId:string,orderId:string){const id=await writer.record({eventKey:PROOF.eventPrefix+randomUUID(),recipientUserId:userId,resourceType:'order',resourceId:orderId,
        audience:'customer',brandId:null,subject:PROOF.label,text:PROOF.label});assert(id);const [email]=await tx.select().from(schema.notificationEmailDeliveries).where(eq(schema.notificationEmailDeliveries.notificationId,id));assert(email);return email.id;}
      async function email(id:string){const [row]=await tx.select().from(schema.notificationEmailDeliveries).where(eq(schema.notificationEmailDeliveries.id,id));assert(row);return row;}
      async function rejected(operation:()=>Promise<unknown>,status:number){await assert.rejects(operation,e=>e instanceof HttpException&&e.getStatus()===status);cases++;}
      const initial=await preferences.read(a.id);assert.deepEqual(initial,{userId:a.id,version:0,emailEnabled:true,pushEnabled:true,updatedAt:null});
      assert.equal((await tx.select().from(schema.notificationPreferences).where(eq(schema.notificationPreferences.userId,a.id))).length,0);cases++;
      const firstA=await message(a.id,aOrder),firstB=await message(b.id,bOrder);assert.equal((await email(firstA)).status,EMAIL.status.pending);cases++;
      const off=await preferences.write(a.id,{expectedVersion:0,emailEnabled:false,pushEnabled:false});assert.equal(off.version,1);assert.equal((await email(firstA)).status,EMAIL.status.cancelled);assert.equal((await email(firstA)).lastFailure,PREF.failure.disabled);cases++;
      assert.equal((await email(firstB)).status,EMAIL.status.pending);assert.equal((await preferences.read(b.id)).version,0);cases++;
      await rejected(()=>preferences.write(a.id,{expectedVersion:0,emailEnabled:true,pushEnabled:true}),PROOF.status.conflict);
      await rejected(()=>preferences.write(a.id,{expectedVersion:1,emailEnabled:true,pushEnabled:true,userId:b.id}),PROOF.status.bad);
      const disabled=await message(a.id,aOrder);assert.equal((await email(disabled)).status,EMAIL.status.cancelled);assert.equal((await email(disabled)).attempts,0);cases++;
      const now=new Date(Date.now()+PROOF.offset),claims=await queue.claim(PROOF.sender,now);assert.equal(claims.length,1);assert.equal(claims[0].id,firstB);cases++;
      await queue.finish(claims[0],{outcome:EMAIL_DELIVERY.outcome.unknown,reason:EMAIL_DELIVERY.failure.transport},now);
      await preferences.write(b.id,{expectedVersion:0,emailEnabled:false,pushEnabled:true});assert.equal((await email(firstB)).status,EMAIL.status.cancelled);cases++;
      const restored=await preferences.write(a.id,{expectedVersion:1,emailEnabled:true,pushEnabled:true});assert.equal(restored.version,2);assert.deepEqual(await preferences.read(a.id),restored);cases++;
      const acceptedId=await message(a.id,aOrder),acceptedNow=new Date(Date.now()+PROOF.offset),acceptedClaim=(await queue.claim(PROOF.sender,acceptedNow))[0];assert.equal(acceptedClaim.id,acceptedId);
      await queue.finish(acceptedClaim,{outcome:EMAIL_DELIVERY.outcome.accepted,providerMessageId:randomUUID()},acceptedNow);
      await preferences.write(a.id,{expectedVersion:2,emailEnabled:false,pushEnabled:true});assert.equal((await email(acceptedId)).status,EMAIL.status.accepted);cases++;
      assert.equal((await email(await message(a.id,aOrder))).status,EMAIL.status.cancelled);cases++;
      await preferences.write(a.id,{expectedVersion:3,emailEnabled:true,pushEnabled:false});const leasedId=await message(a.id,aOrder),leasedNow=new Date(Date.now()+PROOF.offset),leased=(await queue.claim(PROOF.sender,leasedNow))[0];assert.equal(leased.id,leasedId);
      await preferences.write(a.id,{expectedVersion:4,emailEnabled:false,pushEnabled:false});assert.equal((await email(leasedId)).status,EMAIL.status.processing);cases++;
      assert.equal((await queue.claim(PROOF.sender,new Date(leasedNow.getTime()+EMAIL.limits.leaseMs+PROOF.afterLease))).length,0);assert.equal((await email(leasedId)).status,EMAIL.status.cancelled);cases++;
      await tx.update(schema.users).set({status:'suspended'}).where(eq(schema.users.id,b.id));
      await rejected(()=>preferences.read(b.id),PROOF.status.forbidden);await rejected(()=>preferences.write(b.id,{expectedVersion:1,emailEnabled:true,pushEnabled:true}),PROOF.status.forbidden);
      await rejected(()=>preferences.write(a.id,{expectedVersion:PREF.revision.maximum,emailEnabled:true,pushEnabled:true}),PROOF.status.bad);
      const unchanged=await preferences.read(a.id);const replay=await preferences.write(a.id,{expectedVersion:unchanged.version,emailEnabled:unchanged.emailEnabled,pushEnabled:unchanged.pushEnabled});assert.deepEqual(replay,unchanged);cases++;
      async function storageReject(query:string,values:unknown[],code:string){await assert.rejects(()=>tx.transaction(async()=>{await client.query(query,values);}),e=>(e as {code?:string}).code===code);cases++;}
      await storageReject('insert into ufit.notification_preferences(user_id,version) values($1,$2)',[randomUUID(),1],PROOF.sql.foreign);
      const c=await actor();await storageReject('insert into ufit.notification_preferences(user_id,version) values($1,$2)',[c.id,0],PROOF.sql.check);
      assert.equal(notificationPreferencesSchema.safeParse({...initial,emailEnabled:false}).success,false);cases++;
      throw new RollbackProof();
    });}catch(e){if(!(e instanceof RollbackProof))throw e;}
    for(const t of tables)assert.equal(await hash(t),before.get(t),'Original table unchanged: '+t);
    assert.equal((await client.query("select to_regclass('ufit.notification_preferences') is not null as present")).rows[0].present,!withMigration);
    console.log(JSON.stringify({cases,tablesUnchanged:tables.length,migrationRolledBack:withMigration,providerCalls:0}));
  }finally{client.release();await pool.end();}
}
verify().catch(async error=>{await writeFile(PROOF.diagnostic,String(error.stack)+'\n'+String(error.cause?.stack??''),{mode:0o600});console.error('Notification preference SQL proof failed; private diagnostic saved');process.exitCode=1;});

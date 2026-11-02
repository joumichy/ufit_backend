import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
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
import {INSTALLATION as I,type InstallationRegistration} from '../src/modules/notifications/domain/notification-installation';
import {PUSH_DELIVERY as PUSH} from '../src/modules/notifications/domain/push-delivery';

const PROOF={profile:{node:'development',port:4014,schema:'ufit',stripe:'sk_test_'},one:1,zero:0,step:1,secretBytes:32,offsetMs:60_000,secondMs:1_000,
  domain:'@example.invalid',tokenA:'00abcd',tokenB:'01abcd',tokenC:'02abcd',tokenD:'03abcd',shortToken:'00',invalidToken:'ABC',invalidState:'invalid',
  active:'active',suspended:'suspended',withMigration:'--with-migration',tables:['notification_installations','notification_device_associations','notification_installation_registrations'],
  migration:'../../src/shared/infrastructure/database/migrations/0026_notification_installations.sql',diagnostic:'/tmp/ufit-installations-diagnostic.txt',
  status:{unauthorized:401,bad:400,conflict:409,forbidden:403},code:{check:'23514',foreign:'23503',unique:'23505'},
  query:{tables:"select table_name from information_schema.tables where table_schema='ufit' and table_type='BASE TABLE' order by table_name",
    hashPrefix:"select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) digest from ufit.",hashSuffix:' t',
    installationExists:"select to_regclass('ufit.notification_installations') is not null as present",
    constraints:'set constraints ufit.notification_installation_relation,ufit.notification_association_relation ',immediate:'immediate',deferred:'deferred'},
} as const;
class RollbackProof extends Error {}
async function verify(){
  const env=getEnv();assert(env.NODE_ENV===PROOF.profile.node&&env.API_PORT===PROOF.profile.port&&env.UFIT_DB_SCHEMA===PROOF.profile.schema&&
    env.STRIPE_SECRET_KEY?.startsWith(PROOF.profile.stripe)&&!env.NOTIFICATION_EMAIL_ENABLED);
  const pool=new Pool({connectionString:env.SUPABASE_DIRECT_CONNECTION_DB_URL,ssl:buildPgSslConfig(env),max:PROOF.one}),client=await pool.connect();
  const db=drizzle(client,{schema}),withMigration=process.argv.includes(PROOF.withMigration);
  const tables=(await client.query<{table_name:string}>(PROOF.query.tables)).rows.map(row=>row.table_name);
  assert.equal(PROOF.tables.every(table=>tables.includes(table)),!withMigration);
  async function hash(table:string){assert(/^[a-z_]+$/.test(table));return (await client.query(PROOF.query.hashPrefix+table+PROOF.query.hashSuffix)).rows[PROOF.zero].digest as string;}
  const before=new Map<string,string>();let cases=PROOF.zero as number;
  try {
    for(const table of tables)before.set(table,await hash(table));
    try {await db.transaction(async tx=>{
      if(withMigration)await tx.execute(sql.raw(await readFile(resolve(__dirname,PROOF.migration),'utf8')));
      const registry=new DrizzleNotificationInstallationsRepository({db:tx});
      async function actor(){const [value]=await tx.insert(schema.users).values({supabaseUserId:randomUUID(),email:randomUUID()+PROOF.domain}).returning();assert(value);return value;}
      const a=await actor(),b=await actor(),id=randomUUID(),key=randomBytes(PROOF.secretBytes).toString(I.crypto.encoding),wrong=randomBytes(PROOF.secretBytes).toString(I.crypto.encoding);
      const start=Date.now()-PROOF.offsetMs;let tick=PROOF.zero as number;
      const now=()=>new Date(start+(tick++*PROOF.secondMs));
      function input(version:number,associationId:string,token:string=PROOF.tokenA):InstallationRegistration{return {expectedVersion:version,associationId,registrationId:randomUUID(),deviceToken:token,environment:PUSH.environment.development};}
      async function rejected(operation:()=>Promise<unknown>,status:number){await assert.rejects(operation,e=>e instanceof HttpException&&e.getStatus()===status);cases++;}
      async function relation(){await client.query(PROOF.query.constraints+PROOF.query.immediate);await client.query(PROOF.query.constraints+PROOF.query.deferred);}
      const initial=await registry.read(a.id,id,key);assert.equal(initial.version,PROOF.zero);assert.equal(initial.state,I.state.unregistered);
      assert.equal((await tx.select().from(schema.notificationInstallations)).length,PROOF.zero);cases++;
      const associationA=randomUUID(),firstInput=input(PROOF.zero,associationA),first=await registry.register(a.id,id,key,firstInput,now());
      assert.equal(first.version,PROOF.one);assert.equal(first.isCurrentAccount,true);assert.equal(first.state,I.state.registered);await relation();cases++;
      const raw=(await tx.select().from(schema.notificationInstallations).where(eq(schema.notificationInstallations.id,id)))[PROOF.zero];assert.notEqual(raw.credentialHash,key);assert.match(raw.credentialHash,I.crypto.proof);cases++;
      const otherView=await registry.read(b.id,id,key);assert.equal(otherView.isCurrentAccount,false);assert.equal(otherView.associationId,associationA);cases++;
      await rejected(()=>registry.read(a.id,id,wrong),PROOF.status.unauthorized);
      await rejected(()=>registry.register(a.id,id,wrong,input(first.version,associationA),now()),PROOF.status.unauthorized);
      await rejected(()=>registry.detach(id,associationA,wrong,{},now()),PROOF.status.unauthorized);
      const replay=await registry.register(a.id,id,key,firstInput,now());assert.deepEqual(replay,first);cases++;
      await rejected(()=>registry.register(a.id,id,key,{...firstInput,expectedVersion:first.version},now()),PROOF.status.conflict);
      await rejected(()=>registry.register(a.id,id,key,input(PROOF.zero,associationA),now()),PROOF.status.conflict);
      await rejected(()=>registry.register(b.id,id,key,firstInput,now()),PROOF.status.conflict);
      let current=await registry.register(a.id,id,key,input(first.version,associationA,PROOF.tokenB),now());assert.equal(current.version,first.version+PROOF.step);assert.notEqual(current.registeredAt,first.registeredAt);cases++;
      const oldTarget={installationId:id,associationId:associationA,registrationId:firstInput.registrationId};assert.equal(await registry.invalidate(oldTarget,null,now()),false);cases++;
      const target={installationId:id,associationId:associationA,registrationId:current.registrationId!};
      assert.equal(await registry.invalidate(target,new Date(Date.parse(current.registeredAt!)-PROOF.step),now()),false);cases++;
      assert.equal(await registry.invalidate(target,new Date(Date.parse(current.registeredAt!)+PROOF.step),now()),true);
      let invalid=await registry.read(a.id,id,key);assert.equal(invalid.state,I.state.invalidated);assert.equal(invalid.version,current.version+PROOF.step);cases++;
      await rejected(()=>registry.register(a.id,id,key,{...firstInput,expectedVersion:invalid.version},now()),PROOF.status.conflict);
      current=await registry.register(a.id,id,key,input(invalid.version,associationA,PROOF.tokenB),now());assert.equal(current.state,I.state.registered);await relation();cases++;
      const associationB=randomUUID(),bInput=input(current.version,associationB,PROOF.tokenC),bCurrent=await registry.register(b.id,id,key,bInput,now());
      assert.equal(bCurrent.isCurrentAccount,true);assert.equal((await registry.read(a.id,id,key)).isCurrentAccount,false);await relation();cases++;
      assert.equal((await registry.detach(id,associationA,key,{},now())).detached,true);assert.deepEqual(await registry.read(b.id,id,key),bCurrent);cases++;
      await tx.update(schema.users).set({status:PROOF.suspended}).where(eq(schema.users.id,b.id));
      await rejected(()=>registry.read(b.id,id,key),PROOF.status.forbidden);
      await rejected(()=>registry.register(b.id,id,key,input(bCurrent.version,associationB),now()),PROOF.status.forbidden);
      await registry.detach(id,associationB,key,{},now());const detached=await registry.read(a.id,id,key);assert.equal(detached.state,I.state.detached);assert.equal(detached.version,bCurrent.version+PROOF.step);await relation();cases++;
      await registry.detach(id,associationB,key,{},now());assert.deepEqual(await registry.read(a.id,id,key),detached);cases++;
      await rejected(()=>registry.register(a.id,id,key,input(detached.version,associationA),now()),PROOF.status.conflict);
      await tx.update(schema.users).set({status:PROOF.active}).where(eq(schema.users.id,b.id));
      await rejected(()=>registry.register(b.id,id,key,input(detached.version,associationB),now()),PROOF.status.conflict);
      const associationC=randomUUID();current=await registry.register(a.id,id,key,input(detached.version,associationC,PROOF.tokenD),now());
      await registry.detach(id,associationB,key,{},now());assert.deepEqual(await registry.read(a.id,id,key),current);cases++;
      assert.equal(await registry.invalidate({installationId:id,associationId:associationB,registrationId:bInput.registrationId},null,now()),false);cases++;
      assert.equal(await registry.invalidate({installationId:id,associationId:associationC,registrationId:current.registrationId!},null,now()),true);invalid=await registry.read(a.id,id,key);assert.equal(invalid.state,I.state.invalidated);cases++;
      current=await registry.register(a.id,id,key,input(invalid.version,associationC,PROOF.tokenD),now());assert.equal(current.state,I.state.registered);cases++;
      const secondID=randomUUID(),secondKey=randomBytes(PROOF.secretBytes).toString(I.crypto.encoding),secondInput=input(PROOF.zero,randomUUID(),PROOF.tokenD);
      await rejected(()=>registry.register(b.id,secondID,secondKey,secondInput,now()),PROOF.status.conflict);
      assert.equal((await registry.read(b.id,secondID,secondKey)).version,PROOF.zero);assert.deepEqual(await registry.read(a.id,id,key),current);cases++;
      const second=await registry.register(b.id,secondID,secondKey,{...secondInput,environment:PUSH.environment.production},now());assert.equal(second.version,PROOF.one);await relation();cases++;
      const shortID=randomUUID(),shortKey=randomBytes(PROOF.secretBytes).toString(I.crypto.encoding);
      assert.equal((await registry.register(a.id,shortID,shortKey,input(PROOF.zero,randomUUID(),PROOF.shortToken),now())).state,I.state.registered);cases++;
      await rejected(()=>registry.register(a.id,id,key,{...input(current.version,associationC),userId:b.id},now()),PROOF.status.bad);
      await rejected(()=>registry.detach(id,associationC,key,{expectedVersion:current.version},now()),PROOF.status.bad);
      async function storageReject(query:string,values:unknown[],code:string){
        await assert.rejects(()=>tx.transaction(async()=>{await client.query(query,values);await client.query(PROOF.query.constraints+PROOF.query.immediate);}),e=>(e as {code?:string}).code===code);
        await client.query(PROOF.query.constraints+PROOF.query.deferred);cases++;
      }
      await storageReject('update ufit.notification_installations set version=$1 where id=$2',[PROOF.zero,id],PROOF.code.check);
      await storageReject('update ufit.notification_installations set state=$1 where id=$2',[PROOF.invalidState,id],PROOF.code.check);
      await storageReject('update ufit.notification_installations set device_token=$1 where id=$2',[PROOF.invalidToken,id],PROOF.code.check);
      await storageReject('update ufit.notification_installations set credential_hash=$1 where id=$2',[wrong,id],PROOF.code.check);
      await storageReject('update ufit.notification_device_associations set user_id=$1 where id=$2',[b.id,associationC],PROOF.code.check);
      await storageReject('update ufit.notification_device_associations set closed_at=null where id=$1',[associationA],PROOF.code.check);
      await storageReject('delete from ufit.notification_device_associations where id=$1',[associationA],PROOF.code.check);
      await storageReject('update ufit.notification_installations set current_association_id=$1 where id=$2',[second.associationId,id],PROOF.code.foreign);
      await storageReject('update ufit.notification_device_associations set closed_at=$1 where id=$2',[now(),associationC],PROOF.code.check);
      await storageReject("update ufit.notification_installations set state='detached',current_association_id=null,registration_id=null,device_token=null,environment=null,registered_at=null,invalidated_at=null where id=$1",[id],PROOF.code.check);
      await storageReject('insert into ufit.notification_device_associations(id,installation_id,user_id,opened_at) values($1,$2,$3,$4)',[randomUUID(),id,a.id,now()],PROOF.code.unique);
      await relation();throw new RollbackProof();
    });}catch(error){if(!(error instanceof RollbackProof))throw error;}
    for(const table of tables)assert.equal(await hash(table),before.get(table),'Original table unchanged: '+table);
    assert.equal((await client.query(PROOF.query.installationExists)).rows[PROOF.zero].present,!withMigration);
    console.log(JSON.stringify({cases,tablesUnchanged:tables.length,migrationRolledBack:withMigration,providerCalls:PROOF.zero}));
  }finally{client.release();await pool.end();}
}
verify().catch(async error=>{await writeFile(PROOF.diagnostic,String(error.stack),{mode:0o600});console.error('Installation SQL proof failed; private diagnostic saved');process.exitCode=1;});

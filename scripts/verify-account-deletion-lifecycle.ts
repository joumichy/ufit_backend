import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {DrizzleQueryError,eq,sql} from 'drizzle-orm';
import {getTableConfig} from 'drizzle-orm/pg-core';
import {HttpException} from '@nestjs/common';
import {getEnv} from '../src/config/env';
import {buildPgSslConfig} from '../src/shared/infrastructure/database/pg-ssl';
import * as schema from '../src/shared/infrastructure/database/schema';
import {ACCOUNT_DELETION as D,AccountDeletionAuthorityFailure} from '../src/modules/identity/domain/account-deletion.contract';
import {DrizzleAccountDeletionQueue,deletionCredentialHash} from '../src/modules/identity/infrastructure/persistence/drizzle-account-deletion-queue';
import {AccountDeletionProcessor} from '../src/modules/identity/application/account-deletion-processor';
import {CREATOR_GRADE} from '../src/modules/creators/grades/creator-grade.contract';
import {OUTFIT_MEDIA} from '../src/modules/media/domain/outfit-media.contract';

const P={profile:{node:'development',port:4014,schema:'ufit',stripe:'sk_test_'},one:1,zero:0,two:2,secretBytes:32,
  domain:'@example.invalid',deleted:'deleted',active:'active',wrongStatus:404,check:'23514',unique:'23505',copy:'Deletion lifecycle fixture',
  withMigration:'--with-migration',table:'account_deletions',mediaTable:'account_deletion_media',
  migration:'../src/shared/infrastructure/database/migrations/0029_account_deletion_lifecycle.sql',encoding:'utf8',
  diagnostic:'/tmp/ufit-account-deletion-lifecycle-diagnostic.txt',
  tablesQuery:"select table_name from information_schema.tables where table_schema='ufit' and table_type='BASE TABLE' order by table_name",
} as const;
class Rollback extends Error{}
async function verify(){
  const env=getEnv();assert(env.NODE_ENV===P.profile.node&&env.API_PORT===P.profile.port&&env.UFIT_DB_SCHEMA===P.profile.schema&&
    env.STRIPE_SECRET_KEY?.startsWith(P.profile.stripe)&&!env.NOTIFICATION_PUSH_ENABLED&&!env.NOTIFICATION_EMAIL_ENABLED);
  const pool=new Pool({connectionString:env.SUPABASE_DIRECT_CONNECTION_DB_URL,ssl:buildPgSslConfig(env),max:P.one});
  const client=await pool.connect(),database=drizzle(client,{schema}),withMigration=process.argv.includes(P.withMigration);
  const tables=(await client.query<{table_name:string}>(P.tablesQuery)).rows.map(row=>row.table_name),cases:string[]=[];
  assert.equal(tables.includes(P.table),!withMigration);assert.equal(tables.includes(P.mediaTable),!withMigration);
  async function fingerprint(table:string){assert(/^[a-z_]+$/.test(table));return (await client.query("select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) digest from ufit."+table+' t')).rows[P.zero].digest;}
  const before=new Map<string,string>();
  try{
    for(const table of tables)before.set(table,await fingerprint(table));
    try{await database.transaction(async db=>{
      if(withMigration)await db.execute(sql.raw(await readFile(resolve(__dirname,P.migration),P.encoding)));
      for(const table of [schema.accountDeletions,schema.accountDeletionMedia]){
        const metadata=getTableConfig(table),checks=(await client.query<{conname:string}>(
          "select conname from pg_constraint where conrelid=$1::regclass and contype='c'",[P.profile.schema+'.'+metadata.name])).rows.map(x=>x.conname).sort();
        assert.deepEqual(checks,metadata.checks.map(x=>x.name).sort());
      }
      cases.push('drizzle_and_sql_check_names_match');
      const queue=new DrizzleAccountDeletionQueue({db}),now=new Date(),later=new Date(now.getTime()+D.limits.one),
        key=randomBytes(P.secretBytes).toString(D.crypto.encoding),wrong=randomBytes(P.secretBytes).toString(D.crypto.encoding);
      const [actor]=await db.insert(schema.users).values({supabaseUserId:randomUUID(),email:randomUUID()+P.domain,status:P.deleted}).returning();assert(actor);
      const requestId=randomUUID(),row={id:requestId,userId:actor.id,authUserId:actor.supabaseUserId,proofHash:deletionCredentialHash(key),
        phase:D.phase.purging,requestedAt:now,updatedAt:now,nextAttemptAt:now};
      assert.equal(await queue.lookup(requestId,key),null);cases.push('absent_receipt_does_not_create_deletion');
      await db.insert(schema.accountDeletions).values(row);
      const receipt=await queue.lookup(requestId,key);assert(receipt);assert.deepEqual(Object.keys(receipt).sort(),['completedAt','phase','requestId','requestedAt']);
      assert.equal(receipt.phase,D.phase.purging);cases.push('canonical_receipt_has_no_account_or_capability_fields');
      await assert.rejects(()=>queue.lookup(requestId,wrong),e=>e instanceof HttpException&&e.getStatus()===P.wrongStatus);cases.push('wrong_capability_cannot_read_existing_request');
      const lease=await queue.reserve(now);assert(lease);assert.equal(lease.requestId,requestId);assert.equal(await queue.reserve(later),null);cases.push('one_live_lease_prevents_duplicate_reservation');
      assert.equal(await queue.complete(lease,later),false);cases.push('media_phase_cannot_complete_auth_deletion');
      assert.equal(await queue.retry({...lease,userId:randomUUID()},D.retry.auth,later),false);cases.push('forged_actor_cannot_acknowledge');
      assert.equal(await queue.retry({...lease,token:randomUUID()},D.retry.auth,later),false);cases.push('foreign_lease_cannot_acknowledge');
      const mediaTarget={assetId:randomUUID(),kind:D.media.outfit,objectPath:randomUUID()};
      const [application]=await db.insert(schema.creatorApplications).values({userId:actor.id,email:actor.email,displayName:P.copy,motivation:P.copy}).returning();assert(application);
      const [creator]=await db.insert(schema.creatorProfiles).values({userId:actor.id,applicationId:application.id,displayName:P.copy,slug:randomUUID(),gradeCode:CREATOR_GRADE.initialCode}).returning();assert(creator);
      await db.insert(schema.outfitMediaAssets).values({id:mediaTarget.assetId,creatorId:creator.id,uploadedBy:actor.id,requestId:randomUUID(),
        fingerprint:deletionCredentialHash(key),byteSize:P.one,contentType:OUTFIT_MEDIA.mime,objectPath:mediaTarget.objectPath,status:OUTFIT_MEDIA.status.ready});
      await db.insert(schema.accountDeletionMedia).values({requestId,...mediaTarget});
      assert.deepEqual(await queue.targets(lease,later),[mediaTarget]);cases.push('only_owned_media_targets_returned');
      assert.equal(await queue.advanceToAuth(lease,later),false);cases.push('remaining_media_prevents_auth_phase');
      async function rejectStorage(operation:()=>Promise<unknown>,code:string=P.check){
        await assert.rejects(()=>db.transaction(operation),e=>e instanceof DrizzleQueryError&&(e.cause as {code?:string}).code===code);
      }
      await rejectStorage(()=>db.update(schema.accountDeletions).set({phase:D.phase.revoking}).where(eq(schema.accountDeletions.id,requestId)));cases.push('sql_cannot_skip_pending_media');
      await rejectStorage(()=>db.update(schema.accountDeletions).set({authUserId:randomUUID()}).where(eq(schema.accountDeletions.id,requestId)));cases.push('auth_subject_is_immutable');
      await rejectStorage(()=>db.update(schema.accountDeletions).set({proofHash:deletionCredentialHash(wrong)}).where(eq(schema.accountDeletions.id,requestId)));cases.push('receipt_capability_is_immutable');
      await rejectStorage(()=>db.update(schema.accountDeletionMedia).set({objectPath:randomUUID()}).where(eq(schema.accountDeletionMedia.requestId,requestId)));cases.push('media_target_cannot_be_reassigned');
      await rejectStorage(()=>db.insert(schema.accountDeletions).values({...row,id:randomUUID()}),P.unique);cases.push('one_deletion_per_business_account');
      const [active]=await db.insert(schema.users).values({supabaseUserId:randomUUID(),email:randomUUID()+P.domain,status:P.active}).returning();assert(active);
      await rejectStorage(()=>db.insert(schema.accountDeletions).values({...row,id:randomUUID(),userId:active.id,authUserId:active.supabaseUserId}));cases.push('sql_request_requires_closed_account');
      const [otherClosed]=await db.insert(schema.users).values({supabaseUserId:randomUUID(),email:randomUUID()+P.domain,status:P.deleted}).returning();assert(otherClosed);
      await rejectStorage(()=>db.insert(schema.accountDeletions).values({...row,id:randomUUID(),userId:otherClosed.id,authUserId:randomUUID()}));cases.push('sql_request_requires_matching_auth_subject');
      await rejectStorage(()=>db.insert(schema.accountDeletions).values({...row,id:randomUUID(),userId:otherClosed.id,authUserId:otherClosed.supabaseUserId,phase:D.phase.completed,completedAt:now}));cases.push('sql_cannot_insert_fabricated_completion');
      await rejectStorage(()=>db.update(schema.accountDeletions).set({leaseUntil:null}).where(eq(schema.accountDeletions.id,requestId)));cases.push('sql_rejects_partial_lease');
      await rejectStorage(()=>db.update(schema.accountDeletions).set({attempts:P.zero}).where(eq(schema.accountDeletions.id,requestId)));cases.push('attempts_cannot_decrease');
      assert.equal(await queue.acknowledgeMedia(lease,{...mediaTarget,objectPath:randomUUID()},later),false);cases.push('wrong_storage_path_cannot_acknowledge_media');
      const expired=new Date(lease.expiresAt.getTime()+D.limits.one);
      assert.equal(await queue.acknowledgeMedia(lease,mediaTarget,expired),false);cases.push('expired_lease_cannot_acknowledge');
      const recovered=await queue.reserve(expired);assert(recovered);assert.notEqual(recovered.token,lease.token);cases.push('expired_lease_recovered_with_new_fence');
      assert.equal(await queue.acknowledgeMedia(lease,mediaTarget,expired),false);cases.push('old_lease_remains_fenced_after_recovery');
      assert.equal(await queue.acknowledgeMedia(recovered,mediaTarget,expired),true);cases.push('acknowledged_storage_target_removed');
      assert.equal((await db.select().from(schema.outfitMediaAssets).where(eq(schema.outfitMediaAssets.id,mediaTarget.assetId))).length,P.zero);cases.push('acknowledged_asset_registry_removed_with_target');
      assert.equal(await queue.advanceToAuth(recovered,expired),true);cases.push('empty_media_phase_advances_once');
      await rejectStorage(()=>db.insert(schema.accountDeletionMedia).values({requestId,...mediaTarget}));cases.push('closed_media_phase_refuses_late_target');
      const authLease=await queue.reserve(expired);assert(authLease);assert.equal(authLease.phase,D.phase.revoking);
      assert.equal(await queue.retry(authLease,D.retry.auth,expired),true);assert.equal(await queue.reserve(expired),null);cases.push('provider_failure_defers_retry_without_false_completion');
      const due=new Date(expired.getTime()+D.limits.retryMs),retry=await queue.reserve(due);assert(retry);assert.equal(retry.phase,D.phase.revoking);
      assert.equal(await queue.complete(authLease,due),false);cases.push('stale_auth_attempt_cannot_complete');
      assert.equal(await queue.complete(retry,due),true);const completed=await queue.lookup(requestId,key);assert(completed);
      assert.equal(completed.phase,D.phase.completed);assert.equal(completed.completedAt,due.toISOString());cases.push('completion_records_canonical_ack_time');
      assert.equal(await queue.reserve(due),null);cases.push('completed_request_is_never_reserved');
      await rejectStorage(()=>db.update(schema.accountDeletions).set({phase:D.phase.revoking,completedAt:null}).where(eq(schema.accountDeletions.id,requestId)));cases.push('completed_request_cannot_reopen');
      await rejectStorage(()=>db.update(schema.accountDeletions).set({updatedAt:new Date(due.getTime()+D.limits.one)}).where(eq(schema.accountDeletions.id,requestId)));cases.push('completed_receipt_cannot_change');
      await rejectStorage(()=>db.delete(schema.accountDeletions).where(eq(schema.accountDeletions.id,requestId)));cases.push('completed_receipt_cannot_be_forgotten');
      const processedId=randomUUID();let clock=new Date(due.getTime()+D.limits.one),failStorage=true,failApple=true;
      const erasures:string[]=[],authSubjects:string[]=[];
      await db.insert(schema.accountDeletions).values({...row,id:processedId,userId:otherClosed.id,authUserId:otherClosed.supabaseUserId,
        requestedAt:clock,updatedAt:clock,nextAttemptAt:clock});
      const targets=Array.from({length:D.limits.batch+D.limits.one},()=>({requestId:processedId,assetId:randomUUID(),kind:D.media.outfit,objectPath:randomUUID()}));
      await db.insert(schema.accountDeletionMedia).values(targets);
      const processor=new AccountDeletionProcessor(queue,{
        product:{eraseOrVerify:async()=>{throw new Error(P.copy);}},
        outfit:{eraseOrVerify:async path=>{if(failStorage)throw new Error(P.copy);erasures.push(path);}},
      },{erase:async subject=>{authSubjects.push(subject);if(failApple)throw new AccountDeletionAuthorityFailure(D.retry.apple);}},()=>clock);
      assert.equal(await processor.runNext(),true);
      let processed=(await db.select().from(schema.accountDeletions).where(eq(schema.accountDeletions.id,processedId)))[P.zero];
      assert.equal(processed.phase,D.phase.purging);assert.equal(processed.lastFailure,D.retry.storage);assert.equal(authSubjects.length,P.zero);
      assert.equal(await processor.runNext(),false);cases.push('processor_defers_storage_failure_without_auth_deletion');
      failStorage=false;clock=new Date(clock.getTime()+D.limits.retryMs);assert.equal(await processor.runNext(),true);
      processed=(await db.select().from(schema.accountDeletions).where(eq(schema.accountDeletions.id,processedId)))[P.zero];
      assert.equal(processed.phase,D.phase.purging);assert.equal(processed.leaseToken,null);assert.equal(erasures.length,D.limits.batch);
      assert.equal(authSubjects.length,P.zero);cases.push('processor_releases_full_batch_before_next_reservation');
      assert.equal(await processor.runNext(),true);assert.equal(erasures.length,targets.length);assert.equal(new Set(erasures).size,targets.length);
      assert.equal(authSubjects.length,P.zero);assert.equal((await queue.lookup(processedId,key))?.phase,D.phase.revoking);cases.push('processor_erases_all_targets_before_auth_phase');
      assert.equal(await processor.runNext(),true);processed=(await db.select().from(schema.accountDeletions).where(eq(schema.accountDeletions.id,processedId)))[P.zero];
      assert.equal(processed.phase,D.phase.revoking);assert.equal(processed.lastFailure,D.retry.apple);assert.equal(processed.completedAt,null);
      assert.deepEqual(authSubjects,[otherClosed.supabaseUserId]);cases.push('processor_keeps_unrevoked_apple_authority_pending');
      failApple=false;clock=new Date(clock.getTime()+D.limits.retryMs);assert.equal(await processor.runNext(),true);
      assert.equal((await queue.lookup(processedId,key))?.phase,D.phase.completed);assert.deepEqual(authSubjects,[otherClosed.supabaseUserId,otherClosed.supabaseUserId]);
      cases.push('processor_completion_requires_authority_acknowledgement');
      assert.equal(await processor.runNext(),false);cases.push('processor_does_not_repeat_completed_work');
      throw new Rollback();
    });}catch(error){if(!(error instanceof Rollback))throw error;}
    for(const table of tables)assert.equal(await fingerprint(table),before.get(table),'Original table unchanged: '+table);
    assert.equal((await client.query("select to_regclass('ufit.account_deletions') is not null present")).rows[P.zero].present,!withMigration);
    console.log(JSON.stringify({cases:cases.length,scenarios:cases,tablesUnchanged:tables.length,migrationRolledBack:withMigration,providerCalls:P.zero}));
  }finally{client.release();await pool.end();}
}
verify().catch(async error=>{await writeFile(P.diagnostic,String(error.stack),{mode:0o600});console.error('Deletion lifecycle SQL proof failed; private diagnostic saved');process.exitCode=1;});

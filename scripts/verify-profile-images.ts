import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {eq, sql} from 'drizzle-orm';
import {HttpException,ServiceUnavailableException} from '@nestjs/common';
import {getEnv} from '../src/config/env';
import {buildPgSslConfig} from '../src/shared/infrastructure/database/pg-ssl';
import {quoteIdentifier} from '../src/shared/infrastructure/database/quote-identifier';
import * as schema from '../src/shared/infrastructure/database/schema';
import {PROFILE_STATUS} from '../src/shared/domain/profile-editing.contract';
import {USER_ADMINISTRATION} from '../src/modules/identity/domain/user-administration.contract';

import {ProfileImageService} from '../src/modules/media/application/profile-image.service';
import {DrizzleProfileMediaRepository} from '../src/modules/media/infrastructure/drizzle-profile-media.repository';
import {PROFILE_IMAGE as I,type ProfileImageOwner} from '../src/modules/media/domain/profile-image.contract';
import {IMAGE_UPLOAD} from '../src/modules/media/domain/image-upload.contract';
import {MediaAssetLocator} from '../src/modules/media/application/media-asset-locator';
import {DrizzleAccountDeletionRepository} from '../src/modules/identity/infrastructure/persistence/drizzle-account-deletion.repository';
import {DrizzleAccountDeletionQueue} from '../src/modules/identity/infrastructure/persistence/drizzle-account-deletion-queue';
import {ACCOUNT_DELETION as D,type AccountDeletionLease} from '../src/modules/identity/domain/account-deletion.contract';
import {PROFILE_AUTHOR_ROLES as R} from '../src/shared/domain/profile-editing.contract';
import {DrizzleBrandsRepository} from '../src/modules/brands/drizzle-brands.repository';
const P={
  profile:{node:'development',port:4014,schema:'ufit',stripe:'sk_test_'},
  zero:0,one:1,two:2,three:3,manager:'manager',accepted:'accepted',proofByte:'a',proofLength:64,
  domain:'@example.invalid',copy:'Profile image rollback qualification',site:'https://example.invalid',origin:'http://127.0.0.1:4014',
  http:{unavailable:503,invalid:400,forbidden:403,conflict:409,missing:404},signed:'https://example.invalid/signed/',
  failed:'Profile image verification failed; transaction rolled back.',diagnostic:'/tmp/ufit-profile-verification.txt',
  sql:{tables:"select table_name from information_schema.tables where table_schema=$1 and table_type='BASE TABLE' order by table_name",
    digest:"select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) digest from ",alias:' t',separator:'.'},
  checks:{empty:'owned_empty_documents',scope:'other_account_refused',private:'account_photo_never_public',
    staged:'upload_is_not_selection',replayUpload:'upload_request_reuses_immutable_asset',changedUpload:'changed_upload_bytes_refused',
    account:'account_selection_persisted',badCommand:'missing_null_and_extra_command_fields_refused',invalidFile:'invalid_upload_refused',
    receipt:'replay_command_does_not_increment',changedReceipt:'changed_command_refused',stale:'stale_version_refused',
    cross:'cross_profile_asset_refused',pending:'pending_asset_refused',creator:'selected_creator_is_public',
    hidden:'paused_creator_image_hidden_but_editable',suspended:'suspended_creator_edit_refused',
    removed:'removed_creator_photo_hidden',replaced:'replaced_creator_photo_hidden',brand:'selected_brand_logo_projected_publicly',
    roles:'brand_role_and_membership_rechecked',active:'suspended_user_refused',
    deletion:'deletion_retires_personal_creator_and_orphan_brand_assets',shared:'shared_brand_keeps_selected_logo_and_changes_owner',
    unused:'unused_upload_of_deleted_brand_member_retired',closed:'deleted_actor_cannot_finish_upload',
    purge:'profile_registry_removed_only_after_matching_erasure_ack',history:'receipt_survives_media_erasure',
    external:'provider_avatar_explicitly_represented_and_removable',
    retry:'failed_upload_resumes_same_reservation',revoked:'revoked_role_during_upload_stays_pending',
    sign:'lost_sign_response_reuses_ready_asset_without_upload',incompleteSign:'incomplete_signed_projection_refused'},
} as const;
class Rollback extends Error {}

async function verify() {
  const env = getEnv();
  assert(env.NODE_ENV === P.profile.node && env.API_PORT === P.profile.port && env.UFIT_DB_SCHEMA === P.profile.schema &&
    env.STRIPE_SECRET_KEY?.startsWith(P.profile.stripe) && !env.NOTIFICATION_PUSH_ENABLED && !env.NOTIFICATION_EMAIL_ENABLED);
  const pool = new Pool({connectionString: env.SUPABASE_DIRECT_CONNECTION_DB_URL, ssl: buildPgSslConfig(env), max: P.one});
  const client = await pool.connect(), database = drizzle(client, {schema}), cases = new Set<string>();
  const tables = (await client.query<{table_name: string}>(P.sql.tables, [env.UFIT_DB_SCHEMA])).rows.map(row => row.table_name);
  const before = new Map<string, string>();
  async function fingerprint(table: string) {
    return (await client.query(P.sql.digest + quoteIdentifier(env.UFIT_DB_SCHEMA) + P.sql.separator + quoteIdentifier(table) + P.sql.alias)).rows[P.zero].digest as string;
  }
  try {
    for (const table of tables) before.set(table, await fingerprint(table));
    try {
      await database.transaction(async db => {
        const [actor,other,successor]=await db.insert(schema.users).values(Array.from({length:P.three},()=>({supabaseUserId:randomUUID(),email:randomUUID()+P.domain,status:USER_ADMINISTRATION.status.active}))).returning();
        await db.insert(schema.userRoles).values([{userId:actor.id,role:R.creator},{userId:actor.id,role:R.brandOwner},{userId:successor.id,role:R.brandOwner}]);
        const [application]=await db.insert(schema.creatorApplications).values({userId:actor.id,email:actor.email,displayName:P.copy,motivation:P.copy}).returning();
        const [creator]=await db.insert(schema.creatorProfiles).values({userId:actor.id,applicationId:application.id,displayName:P.copy,slug:randomUUID()}).returning();
        async function brand(){
          const [a]=await db.insert(schema.brandApplications).values({userId:actor.id,email:actor.email,brandName:P.copy,websiteUrl:P.site,productCategory:P.copy,positioning:P.copy,status:P.accepted}).returning();
          const [b]=await db.insert(schema.brandProfiles).values({ownerUserId:actor.id,applicationId:a.id,brandName:P.copy,slug:randomUUID()}).returning();
          await db.insert(schema.brandMembers).values({brandProfileId:b.id,userId:actor.id,role:D.anonymized.memberOwner,status:I.access.member});return b;
        }
        const sole=await brand(),shared=await brand();
        await db.insert(schema.brandMembers).values({brandProfileId:shared.id,userId:successor.id,role:D.anonymized.memberOwner,status:I.access.member});
        const account:ProfileImageOwner={kind:I.kind.account,ownerId:actor.id},author:ProfileImageOwner={kind:I.kind.creator,ownerId:creator.id},
          brandOwner:ProfileImageOwner={kind:I.kind.brand,ownerId:sole.id},sharedOwner:ProfileImageOwner={kind:I.kind.brand,ownerId:shared.id};
        const repository=new DrizzleProfileMediaRepository({db}),storage=new Map<string,string>();
        let failUpload=false,failSign=false,emptySign=false,revokeRole=false,uploadCalls=P.zero as number;
        const service=new ProfileImageService(repository,{uploadOrVerify:async(path,bytes,fingerprint)=>{
          uploadCalls+=P.one;
          if(failUpload)throw new ServiceUnavailableException(I.failure.unavailable);
          assert.equal(bytes.length>=IMAGE_UPLOAD.image.minimumBytes,true);
          const previous=storage.get(path);if(previous!==undefined)assert.equal(previous,fingerprint);storage.set(path,fingerprint);
          if(revokeRole)await db.delete(schema.userRoles).where(sql`${schema.userRoles.userId}=${actor.id} and ${schema.userRoles.role}=${R.creator}`);
        },sign:async paths=>{if(failSign)throw new ServiceUnavailableException(I.failure.unavailable);return emptySign?new Map():new Map(paths.map(path=>[path,P.signed+path]));}},new MediaAssetLocator(()=>P.origin,I));
        const bytes=Buffer.from([...IMAGE_UPLOAD.image.prefix,...IMAGE_UPLOAD.image.suffix]),file={buffer:bytes,mimetype:I.mime,size:bytes.length};
        async function reject(action:()=>Promise<unknown>,status:number){await assert.rejects(action,error=>error instanceof HttpException&&error.getStatus()===status);}
        for(const scope of [account,author,brandOwner])assert.deepEqual(await service.read(actor.id,scope),{...scope,version:P.zero,image:null});cases.add(P.checks.empty);
        await reject(()=>service.read(other.id,account),P.http.forbidden);cases.add(P.checks.scope);
        await reject(()=>service.upload(actor.id,{...account,requestId:randomUUID()},{...file,size:P.zero}),P.http.invalid);cases.add(P.checks.invalidFile);
        const uploadRequest=randomUUID(),first=await service.upload(actor.id,{...account,requestId:uploadRequest},file);
        assert.equal((await service.read(actor.id,account)).image,null);cases.add(P.checks.staged);
        assert.equal((await service.upload(actor.id,{...account,requestId:uploadRequest},file)).id,first.id);cases.add(P.checks.replayUpload);
        const different=Buffer.concat([Buffer.from(IMAGE_UPLOAD.image.prefix),Buffer.from([P.one]),Buffer.from(IMAGE_UPLOAD.image.suffix)]);
        await reject(()=>service.upload(actor.id,{...account,requestId:uploadRequest},{buffer:different,mimetype:I.mime,size:different.length}),P.http.conflict);cases.add(P.checks.changedUpload);
        await reject(()=>service.upload(actor.id,{...author,requestId:uploadRequest},file),P.http.conflict);
        const command={requestId:randomUUID(),expectedVersion:P.zero,assetId:first.id};
        assert.deepEqual(await service.select(actor.id,account,command),{requestId:command.requestId,version:P.one});
        assert.equal((await service.read(actor.id,account)).image?.id,first.id);cases.add(P.checks.account);
        await reject(()=>service.publicImage(first.id),P.http.missing);cases.add(P.checks.private);
        assert.deepEqual(await service.select(actor.id,account,command),{requestId:command.requestId,version:P.one});
        assert.equal((await service.read(actor.id,account)).version,P.one);cases.add(P.checks.receipt);
        await reject(()=>service.select(actor.id,account,{...command,assetId:null}),P.http.conflict);cases.add(P.checks.changedReceipt);
        await reject(()=>service.select(actor.id,account,{...command,requestId:randomUUID()}),P.http.conflict);cases.add(P.checks.stale);
        await reject(()=>service.select(actor.id,author,{...command,requestId:randomUUID()}),P.http.conflict);cases.add(P.checks.cross);
        for(const invalid of [{requestId:randomUUID(),expectedVersion:P.one},{...command,expectedVersion:null},{...command,forged:true}])
          await reject(()=>service.select(actor.id,account,invalid),P.http.invalid);cases.add(P.checks.badCommand);
        const failedRequest=randomUUID();failUpload=true;
        await reject(()=>service.upload(actor.id,{...author,requestId:failedRequest},file),P.http.unavailable);
        const [reserved]=await db.select().from(schema.profileMediaAssets).where(eq(schema.profileMediaAssets.requestId,failedRequest));
        assert.equal(reserved.status,I.status.pending);failUpload=false;
        assert.equal((await service.upload(actor.id,{...author,requestId:failedRequest},file)).id,reserved.id);cases.add(P.checks.retry);
        const revokedRequest=randomUUID();revokeRole=true;
        await reject(()=>service.upload(actor.id,{...author,requestId:revokedRequest},file),P.http.forbidden);
        const [revoked]=await db.select().from(schema.profileMediaAssets).where(eq(schema.profileMediaAssets.requestId,revokedRequest));
        assert.equal(revoked.status,I.status.pending);revokeRole=false;
        await db.insert(schema.userRoles).values({userId:actor.id,role:R.creator});
        assert.equal((await service.upload(actor.id,{...author,requestId:revokedRequest},file)).id,revoked.id);cases.add(P.checks.revoked);
        const signRequest=randomUUID();failSign=true;
        await reject(()=>service.upload(actor.id,{...author,requestId:signRequest},file),P.http.unavailable);failSign=false;
        const attempts=uploadCalls;
        await service.upload(actor.id,{...author,requestId:signRequest},file);assert.equal(uploadCalls,attempts);cases.add(P.checks.sign);
        emptySign=true;await reject(()=>service.privateImage(actor.id,first.id),P.http.unavailable);emptySign=false;cases.add(P.checks.incompleteSign);
        const a=await service.upload(actor.id,{...author,requestId:randomUUID()},file);
        await reject(()=>service.publicImage(a.id),P.http.missing);
        await service.select(actor.id,author,{requestId:randomUUID(),expectedVersion:P.zero,assetId:a.id});
        assert.equal(await service.publicImage(a.id),a.displayUrl);cases.add(P.checks.creator);
        await db.update(schema.creatorProfiles).set({status:PROFILE_STATUS.paused}).where(eq(schema.creatorProfiles.id,creator.id));
        await reject(()=>service.publicImage(a.id),P.http.missing);assert.equal((await service.read(actor.id,author)).version,P.one);cases.add(P.checks.hidden);
        await db.update(schema.creatorProfiles).set({status:PROFILE_STATUS.suspended}).where(eq(schema.creatorProfiles.id,creator.id));
        await reject(()=>service.select(actor.id,author,{requestId:randomUUID(),expectedVersion:P.one,assetId:null}),P.http.forbidden);cases.add(P.checks.suspended);
        await db.update(schema.creatorProfiles).set({status:PROFILE_STATUS.active}).where(eq(schema.creatorProfiles.id,creator.id));
        await service.select(actor.id,author,{requestId:randomUUID(),expectedVersion:P.one,assetId:null});
        await reject(()=>service.publicImage(a.id),P.http.missing);cases.add(P.checks.removed);
        const next=await service.upload(actor.id,{...author,requestId:randomUUID()},file);
        await service.select(actor.id,author,{requestId:randomUUID(),expectedVersion:P.two,assetId:next.id});
        await reject(()=>service.publicImage(a.id),P.http.missing);assert.equal(await service.publicImage(next.id),next.displayUrl);cases.add(P.checks.replaced);
        const pending=await repository.reserve(author,{id:randomUUID(),uploadedBy:actor.id,requestId:randomUUID(),fingerprint:P.proofByte.repeat(P.proofLength),byteSize:file.size,contentType:I.mime,objectPath:randomUUID()});
        await reject(()=>service.select(actor.id,author,{requestId:randomUUID(),expectedVersion:P.three,assetId:pending.id}),P.http.conflict);cases.add(P.checks.pending);
        const soleLogo=await service.upload(actor.id,{...brandOwner,requestId:randomUUID()},file),sharedLogo=await service.upload(actor.id,{...sharedOwner,requestId:randomUUID()},file);
        await service.select(actor.id,brandOwner,{requestId:randomUUID(),expectedVersion:P.zero,assetId:soleLogo.id});
        await service.select(actor.id,sharedOwner,{requestId:randomUUID(),expectedVersion:P.zero,assetId:sharedLogo.id});
        assert.equal((await new DrizzleBrandsRepository({db}).findPublicProfileById(sole.id))?.logoUrl,soleLogo.url);
        assert.equal(await service.publicImage(soleLogo.id),soleLogo.displayUrl);cases.add(P.checks.brand);
        await reject(()=>service.read(other.id,brandOwner),P.http.forbidden);
        await db.insert(schema.brandMembers).values({brandProfileId:sole.id,userId:other.id,role:P.manager,status:I.access.member});
        await reject(()=>service.read(other.id,brandOwner),P.http.forbidden);
        await db.insert(schema.userRoles).values({userId:other.id,role:R.brandManager});
        assert.equal((await service.read(other.id,brandOwner)).version,P.one);
        await db.update(schema.brandMembers).set({status:D.anonymized.memberRemoved}).where(eq(schema.brandMembers.userId,other.id));
        await reject(()=>service.read(other.id,brandOwner),P.http.forbidden);cases.add(P.checks.roles);
        await db.update(schema.users).set({status:USER_ADMINISTRATION.status.suspended}).where(eq(schema.users.id,actor.id));
        await reject(()=>service.read(actor.id,account),P.http.forbidden);await reject(()=>service.publicImage(next.id),P.http.missing);cases.add(P.checks.active);
        await db.update(schema.users).set({status:USER_ADMINISTRATION.status.active}).where(eq(schema.users.id,actor.id));
        const unused=await service.upload(actor.id,{...sharedOwner,requestId:randomUUID()},file);
        const providerAccount:ProfileImageOwner={kind:I.kind.account,ownerId:other.id};
        await db.update(schema.users).set({avatarUrl:P.site}).where(eq(schema.users.id,other.id));
        assert.deepEqual((await service.read(other.id,providerAccount)).image,{id:null,url:P.site,displayUrl:P.site});
        await service.select(other.id,providerAccount,{requestId:randomUUID(),expectedVersion:P.zero,assetId:null});cases.add(P.checks.external);
        const now=new Date(),requestId=randomUUID();
        await new DrizzleAccountDeletionRepository({db}).accept(actor.supabaseUserId,requestId,P.proofByte.repeat(P.proofLength),now);
        const targets=await db.select().from(schema.accountDeletionMedia).where(eq(schema.accountDeletionMedia.requestId,requestId));
        for(const id of [first.id,a.id,next.id,pending.id,soleLogo.id]){
          assert(targets.some(target=>target.assetId===id&&target.kind===D.media.profile));
          assert.equal((await db.select().from(schema.profileMediaAssets).where(eq(schema.profileMediaAssets.id,id)))[P.zero].status,I.status.retired);
        }cases.add(P.checks.deletion);
        assert(!targets.some(target=>target.assetId===sharedLogo.id));
        assert.equal((await db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.id,shared.id)))[P.zero].ownerUserId,successor.id);
        assert.equal(await service.publicImage(sharedLogo.id),sharedLogo.displayUrl);cases.add(P.checks.shared);
        assert(targets.some(target=>target.assetId===unused.id));cases.add(P.checks.unused);
        await reject(()=>repository.markReady(pending,actor.id),P.http.forbidden);cases.add(P.checks.closed);
        const token=randomUUID(),expiresAt=new Date(now.getTime()+D.limits.leaseMs);
        await db.update(schema.accountDeletions).set({leaseToken:token,leaseUntil:expiresAt,attempts:P.one}).where(eq(schema.accountDeletions.id,requestId));
        const lease:AccountDeletionLease={requestId,userId:actor.id,authUserId:actor.supabaseUserId,phase:D.phase.purging,token,expiresAt},queue=new DrizzleAccountDeletionQueue({db});
        for(const target of targets){
          assert.equal(await queue.acknowledgeMedia(lease,{...target,objectPath:randomUUID()},now),false);
          assert.equal(await queue.acknowledgeMedia(lease,target,now),true);
          assert.equal((await db.select().from(schema.profileMediaAssets).where(eq(schema.profileMediaAssets.id,target.assetId))).length,P.zero);
        }cases.add(P.checks.purge);
        assert((await db.select().from(schema.profileImageChanges).where(eq(schema.profileImageChanges.requestId,command.requestId))).length===P.one);cases.add(P.checks.history);
        throw new Rollback();
      });
    }catch(error){if(!(error instanceof Rollback))throw error;}
    for(const table of tables)assert.equal(await fingerprint(table),before.get(table));
    console.log(JSON.stringify({scenarios:cases.size,cases:[...cases],rolledBack:true,unchangedTables:tables.length,providerCalls:P.zero}));
  }finally{client.release();await pool.end();}
}
verify().catch(async error=>{
  await writeFile(P.diagnostic,String(error)+String(error?.cause),{mode:0o600});console.error(P.failed);process.exitCode=P.one;
});

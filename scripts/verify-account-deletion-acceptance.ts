import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {DrizzleQueryError,and,eq,sql} from 'drizzle-orm';
import {HttpException} from '@nestjs/common';
import {getEnv} from '../src/config/env';
import {buildPgSslConfig} from '../src/shared/infrastructure/database/pg-ssl';
import * as schema from '../src/shared/infrastructure/database/schema';
import type {DatabaseSession} from '../src/shared/infrastructure/database/database-session';
import {ACCOUNT_DELETION as D} from '../src/modules/identity/domain/account-deletion.contract';
import {USER_ADMINISTRATION as U} from '../src/modules/identity/domain/user-administration.contract';
import {DrizzleAccountDeletionRepository} from '../src/modules/identity/infrastructure/persistence/drizzle-account-deletion.repository';
import {DrizzleAccountDeletionQueue} from '../src/modules/identity/infrastructure/persistence/drizzle-account-deletion-queue';
import {DrizzleIdentityRepository} from '../src/modules/identity/infrastructure/persistence/drizzle-identity.repository';
import {deletionEmail} from '../src/modules/identity/infrastructure/persistence/account-deletion-anonymization';
import {DrizzleNotificationInstallationsRepository} from '../src/modules/notifications/infrastructure/drizzle-notification-installations.repository';
import {DrizzleNotificationsRepository} from '../src/modules/notifications/infrastructure/drizzle-notifications.repository';
import {DrizzleOutfitMediaRepository} from '../src/modules/media/infrastructure/drizzle-outfit-media.repository';
import {DrizzleProductMediaRepository} from '../src/modules/media/infrastructure/drizzle-product-media.repository';
import {DrizzleApplicationReader} from '../src/modules/applications/drizzle-application-reader';
import {DrizzleAdminRepository} from '../src/modules/admin/infrastructure/drizzle-admin.repository';
import {CREATOR_GRADE} from '../src/modules/creators/grades/creator-grade.contract';
import {OUTFIT_MEDIA} from '../src/modules/media/domain/outfit-media.contract';
import {PRODUCT_MEDIA} from '../src/modules/media/domain/product-media.contract';
import {MediaAssetLocator} from '../src/modules/media/application/media-asset-locator';
import {INSTALLATION as I} from '../src/modules/notifications/domain/notification-installation';
import {PUSH_DELIVERY} from '../src/modules/notifications/domain/push-delivery';
import {NOTIFICATION} from '../src/modules/notifications/domain/notification.contract';

const P={profile:'development',port:4014,schema:'ufit',stripe:'sk_test_',domain:'@example.invalid',one:1,zero:0,bytes:32,
  copy:'Account deletion qualification content',website:'https://qualification.invalid',status:{accepted:'accepted',active:'active',submitted:'submitted',published:'published',private:'private'},
  role:{customer:'customer',creator:'creator',brandOwner:'brand_owner',superAdmin:'super_admin'},platform:'instagram',item:'top',
  member:{owner:'owner',active:'active'},gender:'unisex',diagnostic:'/tmp/ufit-account-deletion-acceptance-diagnostic.txt',
  migrations:['0029_account_deletion_lifecycle.sql','0030_account_deletion_boundaries.sql'],encoding:'utf8',
  pg:{check:'23514'},http:{notFound:404,conflict:409,forbidden:403},
  tablesQuery:"select table_name from information_schema.tables where table_schema='ufit' and table_type='BASE TABLE' order by table_name",
  financial:/^(orders$|order_|payments$|commissions$|commission_|creator_payouts$|shipments$|shipment_|connect_accounts$|return_commission_)/,
} as const;
class Rollback extends Error{}
async function verify(){
 const env=getEnv();assert(env.NODE_ENV===P.profile&&env.API_PORT===P.port&&env.UFIT_DB_SCHEMA===P.schema&&env.STRIPE_SECRET_KEY?.startsWith(P.stripe)&&!env.NOTIFICATION_PUSH_ENABLED&&!env.NOTIFICATION_EMAIL_ENABLED);
 assert(env.MEDIA_PUBLIC_API_ORIGIN);
 const pool=new Pool({connectionString:env.SUPABASE_DIRECT_CONNECTION_DB_URL,ssl:buildPgSslConfig(env),max:P.one}),client=await pool.connect(),database=drizzle(client,{schema});
 const tables=(await client.query<{table_name:string}>(P.tablesQuery)).rows.map(row=>row.table_name),cases:string[]=[],before=new Map<string,string>();
 const withMigration=!tables.includes('account_deletions');
 async function fingerprint(table:string){assert(/^[a-z_]+$/.test(table));return (await client.query("select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) digest from ufit."+table+' t')).rows[P.zero].digest;}
 try{
  for(const table of tables)before.set(table,await fingerprint(table));
  try{await database.transaction(async db=>{
   if(withMigration)for(const migration of P.migrations)await db.execute(sql.raw(await readFile(resolve(__dirname,'../src/shared/infrastructure/database/migrations',migration),P.encoding)));
   const repository=new DrizzleAccountDeletionRepository({db}),queue=new DrizzleAccountDeletionQueue({db}),registry=new DrizzleNotificationInstallationsRepository({db});
   const key=()=>randomBytes(P.bytes).toString(I.crypto.encoding),now=new Date();
   async function actor(roles:string[]=[P.role.customer]){
    const [row]=await db.insert(schema.users).values({supabaseUserId:randomUUID(),email:randomUUID()+P.domain,displayName:P.copy,avatarUrl:P.website}).returning();assert(row);
    for(const role of roles)await db.insert(schema.userRoles).values({userId:row.id,role:role as typeof schema.userRoles.$inferInsert.role});return row;
   }
   async function creator(owner:Awaited<ReturnType<typeof actor>>){
    const [application]=await db.insert(schema.creatorApplications).values({userId:owner.id,email:owner.email,displayName:P.copy,motivation:P.copy,status:P.status.accepted,portfolioUrl:P.website}).returning();assert(application);
    const [profile]=await db.insert(schema.creatorProfiles).values({userId:owner.id,applicationId:application.id,displayName:P.copy,slug:randomUUID(),bio:P.copy,avatarUrl:P.website,gradeCode:CREATOR_GRADE.initialCode}).returning();assert(profile);
    return {profile,application};
   }
   async function brand(owner:Awaited<ReturnType<typeof actor>>){
    const [application]=await db.insert(schema.brandApplications).values({userId:owner.id,email:owner.email,brandName:P.copy,websiteUrl:P.website,productCategory:P.copy,positioning:P.copy,status:P.status.accepted}).returning();assert(application);
    const [profile]=await db.insert(schema.brandProfiles).values({ownerUserId:owner.id,applicationId:application.id,brandName:P.copy,slug:randomUUID(),bio:P.copy,websiteUrl:P.website}).returning();assert(profile);
    await db.insert(schema.brandMembers).values({brandProfileId:profile.id,userId:owner.id,role:P.member.owner,status:P.member.active});return {profile,application};
   }
   async function reject(operation:()=>Promise<unknown>,status:number){await assert.rejects(operation,e=>e instanceof HttpException&&e.getStatus()===status);}
   async function rejectStorage(operation:()=>Promise<unknown>){await assert.rejects(()=>db.transaction(operation),e=>e instanceof DrizzleQueryError&&(e.cause as {code?:string}).code===P.pg.check);}
   const a=await actor([P.role.customer,P.role.creator]),other=await actor([P.role.customer,P.role.creator]),c=await creator(a),foreign=await creator(other);
   const [pending]=await db.insert(schema.brandApplications).values({userId:a.id,email:a.email,brandName:P.copy,websiteUrl:P.website,productCategory:P.copy,positioning:P.copy}).returning();assert(pending);
   await db.insert(schema.creatorSocialAccounts).values({creatorProfileId:c.profile.id,platform:P.platform,handle:P.copy,url:P.website});
   const assetId=randomUUID(),path=randomUUID(),photo=new MediaAssetLocator(()=>env.MEDIA_PUBLIC_API_ORIGIN!,OUTFIT_MEDIA).url(assetId);
   const [media]=await db.insert(schema.outfitMediaAssets).values({id:assetId,creatorId:c.profile.id,uploadedBy:a.id,requestId:randomUUID(),fingerprint:key(),byteSize:P.one,contentType:OUTFIT_MEDIA.mime,objectPath:path,status:OUTFIT_MEDIA.status.ready}).returning();assert(media);
   const [outfit]=await db.insert(schema.outfits).values({creatorId:c.profile.id,title:P.copy,description:P.copy,coverImageUrl:photo,status:P.status.published,visibility:'public'}).returning();assert(outfit);
   await db.insert(schema.outfitImages).values({outfitId:outfit.id,url:photo,position:P.zero});
   await db.insert(schema.outfitItems).values({outfitId:outfit.id,itemType:P.item,externalLabel:P.copy,stylingNote:P.copy});
   const [foreignOutfit]=await db.insert(schema.outfits).values({creatorId:foreign.profile.id,title:P.copy,description:P.copy,coverImageUrl:P.website,status:P.status.published,visibility:'public'}).returning();assert(foreignOutfit);
   await db.insert(schema.savedOutfits).values([{userId:a.id,outfitId:foreignOutfit.id},{userId:other.id,outfitId:outfit.id},{userId:other.id,outfitId:foreignOutfit.id}]);
   await db.insert(schema.creatorFollows).values([{userId:a.id,creatorId:foreign.profile.id},{userId:other.id,creatorId:c.profile.id}]);
   await db.insert(schema.carts).values({userId:a.id});
   const installation=randomUUID(),association=randomUUID(),proof=key();
   await registry.register(a.id,installation,proof,{expectedVersion:I.revision.absent,associationId:association,registrationId:randomUUID(),deviceToken:key(),environment:PUSH_DELIVERY.environment.development},now);
   const sharedInstallation=randomUUID(),sharedProof=key();let shared=await registry.register(a.id,sharedInstallation,sharedProof,{expectedVersion:I.revision.absent,associationId:randomUUID(),registrationId:randomUUID(),deviceToken:key(),environment:PUSH_DELIVERY.environment.development},now);
   shared=await registry.register(other.id,sharedInstallation,sharedProof,{expectedVersion:shared.version,associationId:randomUUID(),registrationId:randomUUID(),deviceToken:key(),environment:PUSH_DELIVERY.environment.development},now);
   await reject(()=>registry.detachDeletedAccount(other.id,now),P.http.forbidden);assert.deepEqual(await registry.read(other.id,sharedInstallation,sharedProof),shared);cases.push('deletion_device_cleanup_refuses_active_account');
   const writer=new DrizzleNotificationsRepository({db});await writer.record({eventKey:randomUUID(),recipientUserId:a.id,resourceType:NOTIFICATION.resource.brandApplication,resourceId:pending.id,audience:NOTIFICATION.audience.applicant,brandId:null,subject:P.copy,text:P.copy});
   const reader=new DrizzleApplicationReader({db}),admin=new DrizzleAdminRepository({db});
   const activityBefore=await admin.countReviewQueues();assert((await reader.queue({})).items.some(x=>x.id===pending.id));
   const requestId=randomUUID(),receiptKey=key(),receipt=await repository.accept(a.supabaseUserId,requestId,receiptKey,now);
   assert.equal(receipt.phase,D.phase.purging);assert.equal(receipt.completedAt,null);cases.push('acceptance_is_pending_not_external_deletion');
   assert.deepEqual(await repository.accept(a.supabaseUserId,requestId,receiptKey,now),receipt);cases.push('same_private_request_replays_without_repeating_anonymization');
   await reject(()=>repository.accept(other.supabaseUserId,requestId,key(),now),P.http.notFound);cases.push('foreign_capability_cannot_take_over_request');
   await reject(()=>repository.accept(a.supabaseUserId,randomUUID(),key(),now),P.http.conflict);cases.push('another_command_cannot_reassign_closed_account');
   const [closed]=await db.select().from(schema.users).where(eq(schema.users.id,a.id));assert.equal(closed.status,U.status.deleted);assert.equal(closed.email,deletionEmail(a.id));assert.equal(closed.displayName,null);assert.equal(closed.avatarUrl,null);
   assert.equal((await db.select().from(schema.userRoles).where(eq(schema.userRoles.userId,a.id))).length,P.zero);cases.push('identity_anonymized_and_roles_removed_atomically');
   await reject(()=>new DrizzleIdentityRepository({db}).updateProfile(a.id,{displayName:P.copy}),P.http.notFound);cases.push('stale_profile_update_cannot_restore_personal_data');
   await rejectStorage(()=>db.update(schema.users).set({email:a.email}).where(eq(schema.users.id,a.id)));await rejectStorage(()=>db.update(schema.users).set({status:U.status.active}).where(eq(schema.users.id,a.id)));
   await rejectStorage(()=>db.insert(schema.userRoles).values({userId:a.id,role:P.role.customer}));cases.push('sql_cannot_reactivate_identity_or_regrant_roles');
   await rejectStorage(()=>db.insert(schema.carts).values({userId:a.id}));cases.push('late_cart_insert_cannot_recreate_personal_state');
   await rejectStorage(()=>db.insert(schema.savedOutfits).values({userId:a.id,outfitId:foreignOutfit.id}));cases.push('late_favorite_insert_cannot_recreate_personal_state');
   assert.equal((await db.select().from(schema.creatorSocialAccounts).where(eq(schema.creatorSocialAccounts.creatorProfileId,c.profile.id))).length,P.zero);
   const [profile]=await db.select().from(schema.creatorProfiles).where(eq(schema.creatorProfiles.id,c.profile.id));assert.equal(profile.displayName,D.anonymized.name);assert.equal(profile.bio,null);assert.equal(profile.avatarUrl,null);assert.equal(profile.status,'suspended');cases.push('creator_profile_and_socials_anonymized');
   const [removedOutfit]=await db.select().from(schema.outfits).where(eq(schema.outfits.id,outfit.id));assert.equal(removedOutfit.status,'archived');assert.equal(removedOutfit.visibility,P.status.private);assert.equal(removedOutfit.coverImageUrl,'');assert.equal(removedOutfit.description,'');
   assert.equal((await db.select().from(schema.outfitImages).where(eq(schema.outfitImages.outfitId,outfit.id))).length,P.zero);assert.equal((await db.select().from(schema.outfitItems).where(eq(schema.outfitItems.outfitId,outfit.id))).length,P.zero);cases.push('personal_outfit_content_removed_with_financial_identity_retained');
   const allSaved=await db.select().from(schema.savedOutfits).where(eq(schema.savedOutfits.userId,other.id));assert.equal(allSaved.length,P.one);assert.equal(allSaved[P.zero].outfitId,foreignOutfit.id);cases.push('foreign_saved_content_preserved');
   assert.equal((await db.select().from(schema.carts).where(eq(schema.carts.userId,a.id))).length,P.zero);cases.push('unreferenced_cart_removed');
   assert.equal((await db.select().from(schema.notifications).where(eq(schema.notifications.recipientUserId,a.id))).length,P.zero);cases.push('private_notification_envelopes_removed');
   const [retired]=await db.select().from(schema.outfitMediaAssets).where(eq(schema.outfitMediaAssets.id,assetId));assert.equal(retired.status,OUTFIT_MEDIA.status.retired);
   const targets=await db.select().from(schema.accountDeletionMedia).where(eq(schema.accountDeletionMedia.requestId,requestId));assert.equal(targets.length,P.one);assert.equal(targets[P.zero].objectPath,path);cases.push('personal_media_captured_and_retired_before_worker');
   await rejectStorage(()=>db.update(schema.outfitMediaAssets).set({status:OUTFIT_MEDIA.status.ready}).where(eq(schema.outfitMediaAssets.id,assetId)));cases.push('retired_media_cannot_regain_ready_state');
   await reject(()=>new DrizzleOutfitMediaRepository({db}).markReady({...media,creatorId:c.profile.id,brandId:null},a.id),P.http.forbidden);cases.push('late_outfit_upload_cannot_publish_after_acceptance');
   const activityAfter=await admin.countReviewQueues();assert.equal(activityAfter.applications,activityBefore.applications-P.one);assert(!(await reader.queue({})).items.some(x=>x.id===pending.id));await reject(()=>reader.admin('brand',pending.id),P.http.notFound);cases.push('deleted_applicant_removed_from_queue_counters_and_detail');
   const lease=await queue.reserve(now);assert(lease);assert.equal(await queue.detachDevices(lease,now),true);
   const [device]=await db.select().from(schema.notificationInstallations).where(eq(schema.notificationInstallations.id,installation));assert.equal(device.state,I.state.detached);assert.equal(device.deviceToken,null);cases.push('closed_account_devices_detached_before_auth');
   assert.deepEqual(await registry.read(other.id,sharedInstallation,sharedProof),shared);cases.push('subsequent_device_account_preserved');
   const owner=await actor([P.role.customer,P.role.brandOwner]),coOwner=await actor([P.role.customer,P.role.brandOwner]),business=await brand(owner);
   await db.insert(schema.brandMembers).values({brandProfileId:business.profile.id,userId:coOwner.id,role:P.member.owner,status:P.member.active});
   const companyFingerprint=JSON.stringify(business.profile),companyId=business.profile.id;
   const companyMedia={id:randomUUID(),brandId:companyId,uploadedBy:owner.id,requestId:randomUUID(),fingerprint:key(),byteSize:P.one,contentType:PRODUCT_MEDIA.mime,objectPath:randomUUID(),status:PRODUCT_MEDIA.status.ready};
   const [attached]=await db.insert(schema.productMediaAssets).values(companyMedia).returning();assert(attached);
   const image=new MediaAssetLocator(()=>env.MEDIA_PUBLIC_API_ORIGIN!,PRODUCT_MEDIA).url(attached.id);
   const [product]=await db.insert(schema.products).values({brandId:companyId,name:P.copy,slug:randomUUID(),description:P.copy,category:P.copy,basePrice:P.one,currency:'CHF'}).returning();assert(product);
   await db.insert(schema.productImages).values({productId:product.id,url:image,position:P.zero});
   const [unattached]=await db.insert(schema.productMediaAssets).values({...companyMedia,id:randomUUID(),requestId:randomUUID(),objectPath:randomUUID()}).returning();assert(unattached);
   const companyRequest=randomUUID();await repository.accept(owner.supabaseUserId,companyRequest,key(),now);
   const [continued]=await db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.id,companyId));assert.equal(continued.ownerUserId,coOwner.id);assert.equal(continued.brandName,business.profile.brandName);assert.equal(continued.status,business.profile.status);cases.push('shared_brand_keeps_business_and_existing_owner_authority');
   const [kept]=await db.select().from(schema.productMediaAssets).where(eq(schema.productMediaAssets.id,attached.id));assert.equal(kept.status,PRODUCT_MEDIA.status.ready);cases.push('attached_company_image_preserved');
   const [stopped]=await db.select().from(schema.productMediaAssets).where(eq(schema.productMediaAssets.id,unattached.id));assert.equal(stopped.status,PRODUCT_MEDIA.status.retired);cases.push('unattached_private_upload_retired');
   const mediaRepository=new DrizzleProductMediaRepository({db});await reject(()=>mediaRepository.markReady(unattached,coOwner.id),P.http.conflict);cases.push('other_member_cannot_adopt_retired_upload');
   await reject(()=>mediaRepository.reserve({...companyMedia,id:randomUUID(),requestId:randomUUID(),objectPath:randomUUID(),uploadedBy:owner.id}),P.http.forbidden);cases.push('late_product_reservation_requires_current_active_account');
   const sole=await actor([P.role.customer,P.role.brandOwner]),soleBusiness=await brand(sole);await repository.accept(sole.supabaseUserId,randomUUID(),key(),now);
   const [suspended]=await db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.id,soleBusiness.profile.id));assert.equal(suspended.status,'suspended');cases.push('brand_without_active_owner_stops_new_sales');
   // An existing paid-order customer is touched only inside this rollback.
   const [existing]=await db.select({id:schema.users.id,subject:schema.users.supabaseUserId}).from(schema.users)
     .where(and(eq(schema.users.status,U.status.active),sql`exists(select ${P.one} from ${schema.orders} o where o.customer_id=${schema.users.id})`,
       sql`not exists(select ${P.one} from ${schema.userRoles} r where r.user_id=${schema.users.id} and r.role=${P.role.superAdmin})`)).limit(P.one);assert(existing);
   const financial=tables.filter(name=>P.financial.test(name)),moneyBefore=new Map<string,string>();for(const table of financial)moneyBefore.set(table,await fingerprint(table));
   await repository.accept(existing.subject,randomUUID(),key(),now);
   for(const table of financial)assert.equal(await fingerprint(table),moneyBefore.get(table));cases.push('existing_orders_returns_commissions_shipments_and_connect_unchanged');
   const linkedCarts=await db.select({status:schema.carts.status}).from(schema.carts).innerJoin(schema.orders,eq(schema.orders.cartId,schema.carts.id)).where(eq(schema.carts.userId,existing.id));
   assert(linkedCarts.every(x=>x.status!==D.anonymized.cartActive));cases.push('order_referenced_carts_preserved_inactive');
   const [oldOrder]=await db.select().from(schema.orders).where(eq(schema.orders.customerId,existing.id)).limit(P.one);assert(oldOrder);
   await rejectStorage(()=>db.insert(schema.orders).values({...oldOrder,id:randomUUID(),orderNumber:randomUUID(),checkoutRequestId:null,stripeCheckoutSessionId:null,stripePaymentIntentId:null}));cases.push('late_checkout_cannot_create_order_after_closure');
   const [administrator]=await db.select({id:schema.users.id,subject:schema.users.supabaseUserId}).from(schema.users).innerJoin(schema.userRoles,eq(schema.userRoles.userId,schema.users.id))
     .where(and(eq(schema.users.status,U.status.active),eq(schema.userRoles.role,P.role.superAdmin))).limit(P.one);assert(administrator);
   const superCount=(await db.select().from(schema.userRoles).innerJoin(schema.users,eq(schema.users.id,schema.userRoles.userId)).where(and(eq(schema.userRoles.role,P.role.superAdmin),eq(schema.users.status,U.status.active)))).length;
   if(superCount===P.one){await reject(()=>repository.accept(administrator.subject,randomUUID(),key(),now),P.http.conflict);cases.push('last_active_super_administrator_cannot_disappear');}
   await client.query('set constraints all immediate');throw new Rollback();
  });}catch(error){if(!(error instanceof Rollback))throw error;}
  for(const table of tables)assert.equal(await fingerprint(table),before.get(table),'Original table unchanged: '+table);
  assert.equal((await client.query("select to_regclass('ufit.account_deletions') is null absent")).rows[P.zero].absent,withMigration);
  console.log(JSON.stringify({cases:cases.length,scenarios:cases,tablesUnchanged:tables.length,migrationsRolledBack:withMigration?P.migrations.length:P.zero,providerCalls:P.zero,existingAccountChangesRolledBack:true}));
 }finally{client.release();await pool.end();}
}
verify().catch(async error=>{await writeFile(P.diagnostic,String(error.stack),{mode:0o600});console.error('Account deletion acceptance SQL proof failed; private diagnostic saved');process.exitCode=1;});

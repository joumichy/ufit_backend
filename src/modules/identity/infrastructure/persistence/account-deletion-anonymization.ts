import {PROFILE_IMAGE} from '../../../media/domain/profile-image.contract';
import {stylePreferences} from '../../../../shared/infrastructure/database/schema.style-preferences';
import {shippingAddressBooks} from '../../../../shared/infrastructure/database/schema.shipping-addresses';
import {and,eq,exists,inArray,not,or,sql} from 'drizzle-orm';
import type {DatabaseSession} from '../../../../shared/infrastructure/database/database-session';
import {users,userRoles,creatorApplications,brandApplications,creatorProfiles,creatorSocialAccounts,brandProfiles,brandMembers,
  outfits,outfitImages,outfitItems,outfitTags,savedOutfits,creatorFollows,carts,cartItems,orders,productMediaAssets,brandSettings,
  outfitMediaAssets,profileMediaAssets,productImages,orderItems,notifications,notificationPushDeliveries,notificationPreferences} from '../../../../shared/infrastructure/database/schema';
import {accountDeletionMedia} from '../../../../shared/infrastructure/database/schema.account-deletions';
import {PROFILE_STATUS,PROFILE_EDITING,PROFILE_AUTHOR_ROLES} from '../../../../shared/domain/profile-editing.contract';
import {OUTFIT_STATUS,OUTFIT_VISIBILITY,OUTFIT_EDITING} from '../../../outfits/domain/outfit-editing.contract';
import {PRODUCT_MEDIA} from '../../../media/domain/product-media.contract';
import {MEDIA_ASSET_STATUS} from '../../../media/domain/image-upload.contract';
import {USER_ADMINISTRATION as U} from '../../domain/user-administration.contract';
import {ACCOUNT_DELETION as D} from '../../domain/account-deletion.contract';

export function deletionEmail(userId:string):string {return D.anonymized.emailPrefix+userId+D.anonymized.emailDomain;}

export async function anonymizeAccount(database:DatabaseSession,actor:{id:string;email:string},requestId:string,now:Date):Promise<void> {
  const userId=actor.id,db=database.db,copy=D.anonymized,email=deletionEmail(userId);
  await db.update(users).set({status:U.status.deleted,email,displayName:null,avatarUrl:null,updatedAt:now}).where(eq(users.id,userId));
  await db.delete(userRoles).where(eq(userRoles.userId,userId));
  // Brand writers lock the same brand row before changing its catalogue.
  const brands=await db.select({id:brandProfiles.id,ownerUserId:brandProfiles.ownerUserId}).from(brandProfiles)
    .where(affectedBrand(userId)).orderBy(brandProfiles.id).for(D.persistence.lock);
  await db.update(brandMembers).set({status:copy.memberRemoved}).where(eq(brandMembers.userId,userId));
  if(brands.length)await db.update(brandSettings).set({fulfillmentEmail:null,updatedAt:now})
    .where(and(inArray(brandSettings.brandProfileId,brands.map(brand=>brand.id)),sql`lower(btrim(${brandSettings.fulfillmentEmail}))=${actor.email.trim().toLowerCase()}`));
  for(const brand of brands){
    const [owner]=await db.select({id:users.id}).from(brandMembers).innerJoin(users,eq(users.id,brandMembers.userId))
      .where(and(eq(brandMembers.brandProfileId,brand.id),eq(brandMembers.role,copy.memberOwner),
        eq(brandMembers.status,PROFILE_EDITING.persistence.memberActive),eq(users.status,U.status.active),
        exists(db.select({id:userRoles.id}).from(userRoles).where(and(eq(userRoles.userId,users.id),eq(userRoles.role,PROFILE_AUTHOR_ROLES.brandOwner))))))
      .orderBy(users.id).limit(D.limits.one);
    if(!owner)await db.update(brandProfiles).set({status:PROFILE_STATUS.suspended,logoUrl:null,updatedAt:now}).where(eq(brandProfiles.id,brand.id));
    else if(brand.ownerUserId===userId)await db.update(brandProfiles).set({ownerUserId:owner.id,updatedAt:now}).where(eq(brandProfiles.id,brand.id));
  }
  await capturePersonalMedia(database,userId,requestId,now);
  const creators=db.select({id:creatorProfiles.id}).from(creatorProfiles).where(eq(creatorProfiles.userId,userId));
  const ownedOutfits=db.select({id:outfits.id}).from(outfits).where(inArray(outfits.creatorId,creators));
  await db.delete(savedOutfits).where(or(eq(savedOutfits.userId,userId),inArray(savedOutfits.outfitId,ownedOutfits)));
  await db.delete(creatorFollows).where(or(eq(creatorFollows.userId,userId),inArray(creatorFollows.creatorId,creators)));
  await db.delete(creatorSocialAccounts).where(inArray(creatorSocialAccounts.creatorProfileId,creators));
  await db.delete(outfitImages).where(inArray(outfitImages.outfitId,ownedOutfits));
  await db.delete(outfitItems).where(inArray(outfitItems.outfitId,ownedOutfits));
  await db.delete(outfitTags).where(inArray(outfitTags.outfitId,ownedOutfits));
  await db.update(outfits).set({title:copy.outfit,description:copy.empty,coverImageUrl:OUTFIT_EDITING.emptyImage,
    status:OUTFIT_STATUS.archived,visibility:OUTFIT_VISIBILITY.private,rejectionReason:null,updatedAt:now,
    version:sql`case when ${outfits.version}<${OUTFIT_EDITING.limits.integerMax} then ${outfits.version}+${OUTFIT_EDITING.versionStep} else ${outfits.version} end`})
    .where(inArray(outfits.creatorId,creators));
  await db.update(creatorProfiles).set({displayName:copy.name,bio:null,avatarUrl:null,status:PROFILE_STATUS.suspended,
    slug:sql`${copy.slugPrefix}||${creatorProfiles.id}::text`,updatedAt:now}).where(eq(creatorProfiles.userId,userId));
  await db.update(creatorApplications).set({displayName:copy.name,email,portfolioUrl:null,dossier:null,
    motivation:copy.application,audienceSummary:null,updatedAt:now,
    version:sql`case when ${creatorApplications.version}<${D.persistence.maximumRevision} then ${creatorApplications.version}+${D.limits.one} else ${creatorApplications.version} end`})
    .where(eq(creatorApplications.userId,userId));
  await db.update(brandApplications).set({brandName:copy.brand,email,websiteUrl:copy.website,dossier:null,
    productCategory:copy.application,positioning:copy.application,updatedAt:now,
    version:sql`case when ${brandApplications.version}<${D.persistence.maximumRevision} then ${brandApplications.version}+${D.limits.one} else ${brandApplications.version} end`})
    .where(eq(brandApplications.userId,userId));
  const ownedCarts=db.select({id:carts.id}).from(carts).where(eq(carts.userId,userId));
  await db.delete(cartItems).where(inArray(cartItems.cartId,ownedCarts));
  await db.delete(carts).where(and(eq(carts.userId,userId),not(exists(db.select({id:orders.id}).from(orders).where(eq(orders.cartId,carts.id))))));
  await db.update(carts).set({status:copy.cartAbandoned,sourceOutfitId:null,sourceCreatorId:null,updatedAt:now})
    .where(and(eq(carts.userId,userId),eq(carts.status,copy.cartActive)));
  const messages=db.select({id:notifications.id}).from(notifications).where(eq(notifications.recipientUserId,userId));
  await db.delete(notificationPushDeliveries).where(inArray(notificationPushDeliveries.notificationId,messages));
  // Email deliveries cascade from their private notification intent.
  await db.delete(notifications).where(eq(notifications.recipientUserId,userId));
  await db.delete(notificationPreferences).where(eq(notificationPreferences.userId,userId));
  await db.delete(stylePreferences).where(eq(stylePreferences.userId,userId));
  await db.delete(shippingAddressBooks).where(eq(shippingAddressBooks.userId,userId));
}

export function affectedBrand(userId:string) {
  return or(eq(brandProfiles.ownerUserId,userId),
    sql`exists(select ${D.limits.one} from ${brandMembers} m where m.brand_profile_id=${brandProfiles.id} and m.user_id=${userId})`,
    sql`exists(select ${D.limits.one} from ${productMediaAssets} a where a.brand_id=${brandProfiles.id} and a.uploaded_by=${userId})`,
    sql`exists(select ${D.limits.one} from ${profileMediaAssets} a where a.brand_id=${brandProfiles.id} and a.uploaded_by=${userId})`);
}

async function capturePersonalMedia(database:DatabaseSession,userId:string,requestId:string,now:Date):Promise<void> {
  const db=database.db;
  await db.execute(sql`insert into ${accountDeletionMedia}(request_id,asset_id,kind,object_path)
    select ${requestId}::uuid,a.id,${D.media.outfit},a.object_path from ${outfitMediaAssets} a
    join ${creatorProfiles} c on c.id=a.creator_id where c.user_id=${userId}`);
  const suffix=sql`${PRODUCT_MEDIA.routes.assetPrefix}||a.id::text||${PRODUCT_MEDIA.routes.imageSuffix}`;
  await db.execute(sql`insert into ${accountDeletionMedia}(request_id,asset_id,kind,object_path)
    select ${requestId}::uuid,a.id,${D.media.product},a.object_path from ${productMediaAssets} a where a.uploaded_by=${userId}
      and not exists(select ${D.limits.one} from ${productImages} i where right(i.url,length(${suffix}))=${suffix})
      and not exists(select ${D.limits.one} from ${orderItems} i where right(i.product_snapshot->>${PRODUCT_MEDIA.snapshotImageKey},length(${suffix}))=${suffix})`);
  const profileSuffix=sql`${PROFILE_IMAGE.routes.assetPrefix}||a.id::text||${PROFILE_IMAGE.routes.imageSuffix}`;
  // Shared brand logos belong to the continuing brand; private/unused uploads
  // and media of a brand without an active owner are part of account erasure.
  await db.execute(sql`insert into ${accountDeletionMedia}(request_id,asset_id,kind,object_path)
    select ${requestId}::uuid,a.id,${D.media.profile},a.object_path from ${profileMediaAssets} a
    where a.user_id=${userId}
      or exists(select ${D.limits.one} from ${creatorProfiles} c where c.id=a.creator_id and c.user_id=${userId})
      or (a.brand_id is not null and (
        (a.uploaded_by=${userId} and not exists(select ${D.limits.one} from ${brandProfiles} b
          where b.id=a.brand_id and b.logo_url is not null and right(b.logo_url,length(${profileSuffix}))=${profileSuffix}))
        or (exists(select ${D.limits.one} from ${brandProfiles} b where b.id=a.brand_id and b.status=${PROFILE_STATUS.suspended})
          and not exists(select ${D.limits.one} from ${brandMembers} m join ${users} u on u.id=m.user_id
            join ${userRoles} r on r.user_id=u.id and r.role=${PROFILE_AUTHOR_ROLES.brandOwner}
            where m.brand_profile_id=a.brand_id and m.role=${D.anonymized.memberOwner} and m.status=${PROFILE_EDITING.persistence.memberActive} and u.status=${U.status.active}))
      ))`);
  for(const [table,kind] of [[outfitMediaAssets,D.media.outfit],[productMediaAssets,D.media.product],[profileMediaAssets,D.media.profile]] as const){
    const targets=db.select({id:accountDeletionMedia.assetId}).from(accountDeletionMedia)
      .where(and(eq(accountDeletionMedia.requestId,requestId),eq(accountDeletionMedia.kind,kind)));
    await db.update(table).set({status:MEDIA_ASSET_STATUS.retired,updatedAt:now}).where(inArray(table.id,targets));
  }
}

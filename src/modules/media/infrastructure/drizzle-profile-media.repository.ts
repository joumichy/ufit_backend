import {ConflictException,ForbiddenException,Inject,Injectable,NotFoundException} from '@nestjs/common';
import {and,eq,ne,sql} from 'drizzle-orm';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {users,userRoles,creatorProfiles,brandProfiles,profileMediaAssets,profileImageChanges} from '../../../shared/infrastructure/database/schema';
import {canAuthorProfile,PROFILE_STATUS} from '../../../shared/domain/profile-editing.contract';
import {findAuthoringProfile,ProfileAccessMode} from '../../../shared/infrastructure/database/profile-authoring-access';
import {USER_ADMINISTRATION as U} from '../../identity/domain/user-administration.contract';
import {PROFILE_IMAGE as P,type ProfileImageOwner,type ProfileImageSelection,type ProfileImageState} from '../domain/profile-image.contract';
export type ProfileAsset=typeof profileMediaAssets.$inferSelect;
type Reservation=typeof profileMediaAssets.$inferInsert;
export const profileOwnerColumns=(owner:ProfileImageOwner)=>({
  userId:owner.kind===P.kind.account?owner.ownerId:null,
  creatorId:owner.kind===P.kind.creator?owner.ownerId:null,
  brandId:owner.kind===P.kind.brand?owner.ownerId:null,
});
export function assetBelongsTo(asset:Pick<ProfileAsset,'userId'|'creatorId'|'brandId'>,owner:ProfileImageOwner):boolean {
  const scope=profileOwnerColumns(owner);
  return asset.userId===scope.userId && asset.creatorId===scope.creatorId && asset.brandId===scope.brandId;
}
export function profileAssetOwner(asset:ProfileAsset):ProfileImageOwner {
  if(asset.userId!==null)return {kind:P.kind.account,ownerId:asset.userId};
  if(asset.creatorId!==null)return {kind:P.kind.creator,ownerId:asset.creatorId};
  if(asset.brandId!==null)return {kind:P.kind.brand,ownerId:asset.brandId};
  throw new NotFoundException(P.failure.missing);
}
@Injectable()
export class DrizzleProfileMediaRepository {
  constructor(@Inject(DatabaseService) private readonly database:DatabaseSession) {}
  private async lockOwner(database:DatabaseSession,owner:ProfileImageOwner,actorId:string):Promise<void> {
    const [actor]=await database.db.select({id:users.id}).from(users)
      .where(and(eq(users.id,actorId),eq(users.status,U.status.active))).for(P.access.lock);
    if(!actor)throw new ForbiddenException(P.failure.access);
    if(owner.kind===P.kind.account){
      if(owner.ownerId!==actorId)throw new ForbiddenException(P.failure.access);
      return;
    }
    const roles=await database.db.select({role:userRoles.role}).from(userRoles).where(eq(userRoles.userId,actorId));
    const scope=owner.kind===P.kind.creator?{creatorId:owner.ownerId,brandId:null}:{creatorId:null,brandId:owner.ownerId};
    if(!canAuthorProfile(roles.map(row=>row.role),scope) ||
      !await findAuthoringProfile(database,scope,actorId,ProfileAccessMode.Lock))throw new ForbiddenException(P.failure.access);
  }
  private async state(database:DatabaseSession,owner:ProfileImageOwner):Promise<ProfileImageState> {
    const [row]=owner.kind===P.kind.account?
      await database.db.select({version:users.imageVersion,url:users.avatarUrl}).from(users).where(eq(users.id,owner.ownerId)):
      owner.kind===P.kind.creator?
      await database.db.select({version:creatorProfiles.imageVersion,url:creatorProfiles.avatarUrl}).from(creatorProfiles).where(eq(creatorProfiles.id,owner.ownerId)):
      await database.db.select({version:brandProfiles.imageVersion,url:brandProfiles.logoUrl}).from(brandProfiles).where(eq(brandProfiles.id,owner.ownerId));
    if(!row)throw new NotFoundException(P.failure.missing);
    return row;
  }
  read(owner:ProfileImageOwner,actorId:string):Promise<ProfileImageState> {
    return this.database.db.transaction(async tx=>{
      await this.lockOwner({db:tx},owner,actorId);return this.state({db:tx},owner);
    });
  }
  reserve(owner:ProfileImageOwner,input:Omit<Reservation,'userId'|'creatorId'|'brandId'>):Promise<ProfileAsset> {
    return this.database.db.transaction(async tx=>{
      await this.lockOwner({db:tx},owner,input.uploadedBy);
      await tx.insert(profileMediaAssets).values({...input,...profileOwnerColumns(owner)}).onConflictDoNothing();
      const [row]=await tx.select().from(profileMediaAssets).where(eq(profileMediaAssets.requestId,input.requestId));
      if(!row || !assetBelongsTo(row,owner) || row.uploadedBy!==input.uploadedBy || row.fingerprint!==input.fingerprint ||
        row.byteSize!==input.byteSize || row.contentType!==input.contentType)throw new ConflictException(P.failure.request);
      if(row.status===P.status.retired)throw new ConflictException(P.failure.ownership);
      return row;
    });
  }
  markReady(asset:ProfileAsset,actorId:string):Promise<ProfileAsset> {
    return this.database.db.transaction(async tx=>{
      await this.lockOwner({db:tx},profileAssetOwner(asset),actorId);
      const [row]=await tx.update(profileMediaAssets).set({status:P.status.ready,updatedAt:new Date()})
        .where(and(eq(profileMediaAssets.id,asset.id),eq(profileMediaAssets.fingerprint,asset.fingerprint),ne(profileMediaAssets.status,P.status.retired))).returning();
      if(!row)throw new ConflictException(P.failure.ownership);
      return row;
    });
  }
  async findOwnedReady(id:string,actorId:string):Promise<ProfileAsset|null> {
    return this.database.db.transaction(async tx=>{
      const [row]=await tx.select().from(profileMediaAssets).where(and(eq(profileMediaAssets.id,id),eq(profileMediaAssets.status,P.status.ready)));
      if(!row)return null;
      await this.lockOwner({db:tx},profileAssetOwner(row),actorId);return row;
    });
  }
  async findPublic(id:string,url:string):Promise<ProfileAsset|null> {
    const creator=sql`exists(select ${P.limits.one} from ${creatorProfiles} c join ${users} u on u.id=c.user_id
      where c.id=${profileMediaAssets.creatorId} and c.avatar_url=${url} and c.status=${PROFILE_STATUS.active} and u.status=${U.status.active})`;
    const brand=sql`exists(select ${P.limits.one} from ${brandProfiles} b where b.id=${profileMediaAssets.brandId}
      and b.logo_url=${url} and b.status=${PROFILE_STATUS.active})`;
    const [row]=await this.database.db.select().from(profileMediaAssets).where(and(eq(profileMediaAssets.id,id),eq(profileMediaAssets.status,P.status.ready),sql`(${creator} or ${brand})`));
    return row??null;
  }
  select(owner:ProfileImageOwner,actorId:string,input:ProfileImageSelection,url:string|null):Promise<{requestId:string;version:number}> {
    return this.database.db.transaction(async tx=>{
      await this.lockOwner({db:tx},owner,actorId);
      const [receipt]=await tx.select().from(profileImageChanges).where(eq(profileImageChanges.requestId,input.requestId));
      if(receipt){
        if(!assetBelongsTo(receipt,owner) || receipt.changedBy!==actorId || receipt.expectedVersion!==input.expectedVersion || receipt.assetId!==input.assetId)
          throw new ConflictException(P.failure.request);
        return {requestId:receipt.requestId,version:receipt.version};
      }
      const current=await this.state({db:tx},owner);
      if(current.version!==input.expectedVersion)throw new ConflictException(P.failure.changed);
      if(input.assetId!==null){
        const [asset]=await tx.select().from(profileMediaAssets).where(and(eq(profileMediaAssets.id,input.assetId),eq(profileMediaAssets.status,P.status.ready)));
        if(!asset || !assetBelongsTo(asset,owner))throw new ConflictException(P.failure.ownership);
      }
      const version=current.version+P.limits.one,updatedAt=new Date();
      if(owner.kind===P.kind.account)await tx.update(users).set({avatarUrl:url,imageVersion:version,updatedAt}).where(eq(users.id,owner.ownerId));
      else if(owner.kind===P.kind.creator)await tx.update(creatorProfiles).set({avatarUrl:url,imageVersion:version,updatedAt}).where(eq(creatorProfiles.id,owner.ownerId));
      else await tx.update(brandProfiles).set({logoUrl:url,imageVersion:version,updatedAt}).where(eq(brandProfiles.id,owner.ownerId));
      const [saved]=await tx.insert(profileImageChanges).values({...profileOwnerColumns(owner),changedBy:actorId,...input,version}).onConflictDoNothing().returning();
      if(!saved)throw new ConflictException(P.failure.request);
      return {requestId:saved.requestId,version:saved.version};
    });
  }
}

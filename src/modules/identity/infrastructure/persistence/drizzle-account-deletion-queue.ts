import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {BadRequestException,Inject,Injectable,NotFoundException} from '@nestjs/common';
import {and,asc,eq,isNull,lt,lte,ne,or,sql} from 'drizzle-orm';
import {DatabaseService} from '../../../../shared/infrastructure/database/database.service';
import type {DatabaseSession} from '../../../../shared/infrastructure/database/database-session';
import {accountDeletions as requests,accountDeletionMedia as media} from '../../../../shared/infrastructure/database/schema.account-deletions';
import {outfitMediaAssets,productMediaAssets} from '../../../../shared/infrastructure/database/schema';
import {ACCOUNT_DELETION as D,deletionIdentifierSchema,deletionProofSchema,deletionReceiptSchema,
  type AccountDeletionLease,type AccountDeletionMediaTarget,type AccountDeletionReceipt,type AccountDeletionRetry} from '../../domain/account-deletion.contract';

type DeletionRow=typeof requests.$inferSelect;

export function deletionCredentialHash(raw:unknown):string {
  const result=deletionProofSchema.safeParse(raw);
  if(!result.success)throw new NotFoundException(D.failure.proof);
  return createHash(D.crypto.algorithm).update(Buffer.from(result.data,D.crypto.encoding)).digest(D.crypto.encoding);
}
export function deletionRequestId(raw:string):string {
  const result=deletionIdentifierSchema.safeParse(raw);
  if(!result.success)throw new BadRequestException(D.failure.invalid);
  return result.data;
}
export function deletionReceipt(row:DeletionRow):AccountDeletionReceipt {
  return deletionReceiptSchema.parse({requestId:row.id,phase:row.phase,requestedAt:row.requestedAt.toISOString(),
    completedAt:row.completedAt?.toISOString()??null});
}
export function requireDeletionCredential(row:DeletionRow,hash:string):void {
  if(!deletionProofSchema.safeParse(hash).success || !deletionProofSchema.safeParse(row.proofHash).success ||
    !timingSafeEqual(Buffer.from(hash,D.crypto.encoding),Buffer.from(row.proofHash,D.crypto.encoding))) {
    throw new NotFoundException(D.failure.proof);
  }
}

@Injectable()
export class DrizzleAccountDeletionQueue {
  constructor(@Inject(DatabaseService) private readonly database:DatabaseSession) {}

  async lookup(rawId:string,proof:unknown):Promise<AccountDeletionReceipt|null> {
    const id=deletionRequestId(rawId),hash=deletionCredentialHash(proof);
    const [row]=await this.database.db.select().from(requests).where(eq(requests.id,id)).limit(D.limits.one);
    if(!row)return null;
    requireDeletionCredential(row,hash);return deletionReceipt(row);
  }

  async reserve(now=new Date()):Promise<AccountDeletionLease|null> {
    validTime(now);
    return this.database.db.transaction(async db=>{
      const [row]=await db.select().from(requests).where(and(ne(requests.phase,D.phase.completed),
        lte(requests.nextAttemptAt,now),lt(requests.attempts,D.limits.maximumAttempts),
        or(isNull(requests.leaseUntil),lte(requests.leaseUntil,now))))
        .orderBy(asc(requests.nextAttemptAt),asc(requests.id)).limit(D.limits.one).for(D.persistence.lock,{skipLocked:true});
      if(!row || row.phase===D.phase.completed)return null;
      const token=randomUUID(),expiresAt=new Date(now.getTime()+D.limits.leaseMs);
      await db.update(requests).set({leaseToken:token,leaseUntil:expiresAt,attempts:row.attempts+D.limits.one,
        updatedAt:now,lastFailure:null}).where(eq(requests.id,row.id));
      return {requestId:row.id,userId:row.userId,authUserId:row.authUserId,phase:row.phase,token,expiresAt};
    });
  }

  async targets(lease:AccountDeletionLease,now=new Date()):Promise<AccountDeletionMediaTarget[]> {
    validTime(now);
    return this.database.db.transaction(async db=>{
      const row=await lockedLease({db},lease,now);
      if(!row || row.phase!==D.phase.purging)return [];
      return db.select({assetId:media.assetId,kind:media.kind,objectPath:media.objectPath}).from(media)
        .where(eq(media.requestId,row.id)).orderBy(asc(media.kind),asc(media.assetId)).limit(D.limits.batch);
    });
  }

  async acknowledgeMedia(lease:AccountDeletionLease,target:AccountDeletionMediaTarget,now=new Date()):Promise<boolean> {
    validTime(now);
    return this.database.db.transaction(async db=>{
      const row=await lockedLease({db},lease,now);
      if(!row || row.phase!==D.phase.purging)return false;
      const [owned]=await db.select().from(media).where(and(eq(media.requestId,row.id),eq(media.assetId,target.assetId),
        eq(media.kind,target.kind),eq(media.objectPath,target.objectPath))).limit(D.limits.one);
      if(!owned)return false;
      const assets=owned.kind===D.media.product?productMediaAssets:outfitMediaAssets;
      await db.delete(assets).where(and(eq(assets.id,owned.assetId),eq(assets.objectPath,owned.objectPath)));
      await db.delete(media).where(and(eq(media.requestId,row.id),eq(media.kind,owned.kind),eq(media.assetId,owned.assetId)));
      return true;
    });
  }

  async advanceToAuth(lease:AccountDeletionLease,now=new Date()):Promise<boolean> {
    validTime(now);
    return this.database.db.transaction(async db=>{
      const row=await lockedLease({db},lease,now);
      if(!row || row.phase!==D.phase.purging)return false;
      const [remaining]=await db.select({id:media.assetId}).from(media).where(eq(media.requestId,row.id)).limit(D.limits.one);
      if(remaining)return false;
      await db.update(requests).set({phase:D.phase.revoking,updatedAt:now,nextAttemptAt:now,
        leaseToken:null,leaseUntil:null,lastFailure:null}).where(eq(requests.id,row.id));
      return true;
    });
  }

  async complete(lease:AccountDeletionLease,now=new Date()):Promise<boolean> {
    validTime(now);
    return this.database.db.transaction(async db=>{
      const row=await lockedLease({db},lease,now);
      if(!row || row.phase!==D.phase.revoking)return false;
      await db.update(requests).set({phase:D.phase.completed,completedAt:now,updatedAt:now,
        leaseToken:null,leaseUntil:null,lastFailure:null}).where(eq(requests.id,row.id));
      return true;
    });
  }

  async retry(lease:AccountDeletionLease,failure:AccountDeletionRetry,now=new Date()):Promise<boolean> {
    validTime(now);
    return this.database.db.transaction(async db=>{
      const row=await lockedLease({db},lease,now);
      if(!row)return false;
      await db.update(requests).set({updatedAt:now,nextAttemptAt:new Date(now.getTime()+D.limits.retryMs),
        leaseToken:null,leaseUntil:null,lastFailure:failure}).where(eq(requests.id,row.id));
      return true;
    });
  }
  async release(lease:AccountDeletionLease,now=new Date()):Promise<boolean> {
    validTime(now);
    return this.database.db.transaction(async db=>{
      const row=await lockedLease({db},lease,now);
      if(!row)return false;
      await db.update(requests).set({updatedAt:now,nextAttemptAt:now,leaseToken:null,leaseUntil:null}).where(eq(requests.id,row.id));
      return true;
    });
  }
}

function validTime(now:Date):void {if(!Number.isFinite(now.getTime()))throw new BadRequestException(D.failure.invalid);}
async function lockedLease(database:DatabaseSession,lease:AccountDeletionLease,now:Date):Promise<DeletionRow|undefined> {
  const [row]=await database.db.select().from(requests).where(and(eq(requests.id,lease.requestId),eq(requests.userId,lease.userId),
    eq(requests.authUserId,lease.authUserId),eq(requests.leaseToken,lease.token),eq(requests.phase,lease.phase),
    sql`${requests.leaseUntil}>${now}`)).limit(D.limits.one).for(D.persistence.lock);
  return row;
}

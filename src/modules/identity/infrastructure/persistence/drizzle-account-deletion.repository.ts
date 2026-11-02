import {BadRequestException,ConflictException,Inject,Injectable,NotFoundException} from '@nestjs/common';
import {and,eq,exists,inArray,or,sql} from 'drizzle-orm';
import {DatabaseService} from '../../../../shared/infrastructure/database/database.service';
import type {DatabaseSession} from '../../../../shared/infrastructure/database/database-session';
import {users,userRoles,brandMembers,brandProfiles} from '../../../../shared/infrastructure/database/schema';
import {accountDeletions} from '../../../../shared/infrastructure/database/schema.account-deletions';
import {ACCOUNT_DELETION as D,deletionIdentifierSchema,type AccountDeletionReceipt} from '../../domain/account-deletion.contract';
import {USER_ADMINISTRATION as U} from '../../domain/user-administration.contract';
import {deletionCredentialHash,deletionRequestId,deletionReceipt,requireDeletionCredential} from './drizzle-account-deletion-queue';
import {affectedBrand,anonymizeAccount} from './account-deletion-anonymization';

@Injectable()
export class DrizzleAccountDeletionRepository {
  constructor(@Inject(DatabaseService) private readonly database:DatabaseSession) {}

  async accept(authSubject:string,rawRequestId:string,proof:unknown,now=new Date()):Promise<AccountDeletionReceipt> {
    const subject=deletionIdentifierSchema.safeParse(authSubject),id=deletionRequestId(rawRequestId),hash=deletionCredentialHash(proof);
    if(!subject.success || !Number.isFinite(now.getTime()))throw new BadRequestException(D.failure.invalid);
    return this.database.db.transaction(async db=>{
      // Serialize deletion decisions, then lock related identities in the same
      // ascending order as access administration. No provider call holds a lock.
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${D.persistence.administratorFence},${D.persistence.lockSeed}))`);
      const [prior]=await db.select().from(accountDeletions).where(eq(accountDeletions.id,id)).limit(D.limits.one);
      if(prior){requireDeletionCredential(prior,hash);return deletionReceipt(prior);}
      const [candidate]=await db.select().from(users).where(eq(users.supabaseUserId,subject.data)).limit(D.limits.one);
      if(!candidate)throw new NotFoundException(D.failure.unavailable);
      const brands=db.select({id:brandProfiles.id}).from(brandProfiles).where(affectedBrand(candidate.id));
      const related=await db.select().from(users).where(or(eq(users.id,candidate.id),
        exists(db.select({id:userRoles.id}).from(userRoles).where(and(eq(userRoles.userId,users.id),eq(userRoles.role,U.role.superAdmin)))),
        exists(db.select({id:brandMembers.id}).from(brandMembers).where(and(eq(brandMembers.userId,users.id),
          eq(brandMembers.role,D.anonymized.memberOwner),inArray(brandMembers.brandProfileId,brands))))))
        .orderBy(users.id).for(D.persistence.lock);
      const actor=related.find(row=>row.id===candidate.id&&row.supabaseUserId===subject.data);
      if(!actor)throw new NotFoundException(D.failure.unavailable);
      const [previous]=await db.select().from(accountDeletions).where(eq(accountDeletions.userId,actor.id)).limit(D.limits.one);
      if(previous)throw new ConflictException(D.failure.changed);
      const superIds=(await db.select({id:userRoles.userId}).from(userRoles).where(eq(userRoles.role,U.role.superAdmin))).map(row=>row.id);
      if(actor.status===U.status.active&&superIds.includes(actor.id)&&related.filter(row=>row.status===U.status.active&&superIds.includes(row.id)).length<=D.limits.one){
        throw new ConflictException(D.failure.lastAdministrator);
      }
      // The request and anonymization commit together; the receipt's proof is
      // independent of the authentication that the worker will revoke.
      await db.update(users).set({status:U.status.deleted}).where(eq(users.id,actor.id));
      const [request]=await db.insert(accountDeletions).values({id,userId:actor.id,authUserId:subject.data,proofHash:hash,
        phase:D.phase.purging,requestedAt:now,updatedAt:now,nextAttemptAt:now}).returning();
      if(!request)throw new NotFoundException(D.failure.unavailable);
      await anonymizeAccount({db},actor,id,now);
      return deletionReceipt(request);
    });
  }
}

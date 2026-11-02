import {BadRequestException,ConflictException,ForbiddenException,Inject,Injectable,InternalServerErrorException,UnauthorizedException} from '@nestjs/common';
import {createHash,timingSafeEqual} from 'node:crypto';
import {DrizzleQueryError,and,eq,sql} from 'drizzle-orm';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT,type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {notificationInstallations as installations,notificationDeviceAssociations as associations,notificationInstallationRegistrations as registrations,notificationInstallationDetachments as detachments} from '../../../shared/infrastructure/database/schema.notification-installations';
import {users} from '../../../shared/infrastructure/database/schema.identity';
import {notificationIdentifierSchema} from '../domain/notification.contract';
import {NOTIFICATION_READING} from '../domain/notification-reading';
import {INSTALLATION as I,installationProofSchema,installationRegistrationSchema,installationDetachSchema,installationDocumentSchema,
  installationDetachedSchema,installationTargetSchema,type InstallationDocument,type InstallationDetached,type InstallationTarget} from '../domain/notification-installation';

type InstallationRow=typeof installations.$inferSelect;
type AssociationRow=typeof associations.$inferSelect;

@Injectable()
export class DrizzleNotificationInstallationsRepository {
  constructor(@Inject(DatabaseService) private readonly database:DatabaseSession) {}
  async read(actorId:string,installationId:string,proof:unknown):Promise<InstallationDocument> {
    const id=identifier(installationId),credential=credentialHash(proof);
    return this.database.db.transaction(async db=>{
      await requireAccount({db},actorId,false);
      const row=await current({db},id);
      if(!row)return absent(id);
      requireCredential(row,credential);
      return document({db},row,actorId);
    },READ_SNAPSHOT);
  }
  async register(actorId:string,installationId:string,proof:unknown,raw:unknown,now=new Date()):Promise<InstallationDocument> {
    const id=identifier(installationId),credential=credentialHash(proof),parsed=installationRegistrationSchema.safeParse(raw);
    if(!parsed.success||!Number.isFinite(now.getTime()))throw new BadRequestException(I.failure.invalid);
    const input=parsed.data;
    const requestHash=createHash(I.crypto.algorithm).update(JSON.stringify(input),I.crypto.requestEncoding).digest(I.crypto.encoding);
    try {
      return await this.database.db.transaction(async db=>{
        await lockNotificationInstallation({db},id);await requireAccount({db},actorId,true);
        const previous=await current({db},id);
        if(previous)requireCredential(previous,credential);
        const [detached]=await db.select({installationId:detachments.installationId}).from(detachments)
          .where(and(eq(detachments.installationId,id),eq(detachments.associationId,input.associationId))).limit(I.storage.one);
        if(detached)throw new ConflictException(I.failure.association);
        let association=await findAssociation({db},input.associationId);
        const [receipt]=await db.select().from(registrations).where(eq(registrations.id,input.registrationId)).limit(I.storage.one);
        if(receipt){
          if(!previous||receipt.installationId!==id||receipt.associationId!==input.associationId||receipt.requestHash!==requestHash||previous.registrationId!==input.registrationId||
            previous.state!==I.state.registered||previous.currentAssociationId!==input.associationId||previous.deviceToken!==input.deviceToken||previous.environment!==input.environment||
            !association||association.userId!==actorId||association.installationId!==id||association.closedAt!==null)throw new ConflictException(I.failure.changed);
          return document({db},previous,actorId);
        }
        const version=previous?previous.version:I.revision.absent;
        if(version!==input.expectedVersion)throw new ConflictException(I.failure.changed);
        if(association&&(association.installationId!==id||association.userId!==actorId||association.closedAt!==null||previous?.currentAssociationId!==association.id))throw new ConflictException(I.failure.association);
        if(!previous)await db.insert(installations).values({id,credentialHash:credential,version:I.revision.initial,state:I.state.detached,createdAt:now,updatedAt:now});
        if(previous?.currentAssociationId&&previous.currentAssociationId!==input.associationId){
          await db.update(associations).set({closedAt:now}).where(and(eq(associations.id,previous.currentAssociationId),eq(associations.installationId,id)));
        }
        if(!association){
          const [created]=await db.insert(associations).values({id:input.associationId,installationId:id,userId:actorId,openedAt:now}).returning();
          if(!created)throw invalid();association=created;
        }
        await db.insert(registrations).values({id:input.registrationId,associationId:association.id,installationId:id,requestHash});
        const [saved]=await db.update(installations).set({version:version+I.revision.step,state:I.state.registered,currentAssociationId:association.id,
          registrationId:input.registrationId,deviceToken:input.deviceToken,environment:input.environment,registeredAt:now,invalidatedAt:null,updatedAt:now})
          .where(eq(installations.id,id)).returning();
        if(!saved)throw invalid();return document({db},saved,actorId);
      });
    }catch(error){
      if(error instanceof DrizzleQueryError){
        const pg=error.cause as {code?:string;constraint?:string};
        if(pg?.code===I.storage.uniqueViolation&&pg.constraint===I.storage.tokenUnique)throw new ConflictException(I.failure.token);
        if(pg?.code===I.storage.uniqueViolation&&(pg.constraint===I.storage.associationPrimary||pg.constraint===I.storage.associationActive))throw new ConflictException(I.failure.association);
        if(pg?.code===I.storage.uniqueViolation&&pg.constraint===I.storage.registrationPrimary)throw new ConflictException(I.failure.changed);
      }
      throw error;
    }
  }
  async detach(installationId:string,associationId:string,proof:unknown,raw:unknown,now=new Date()):Promise<InstallationDetached> {
    const id=identifier(installationId),target=identifier(associationId),credential=credentialHash(proof);
    if(!installationDetachSchema.safeParse(raw).success||!Number.isFinite(now.getTime()))throw new BadRequestException(I.failure.invalid);
    return this.database.db.transaction(async db=>{
      await lockNotificationInstallation({db},id);
      let row=await current({db},id);
      if(row)requireCredential(row,credential);
      else {
        const [created]=await db.insert(installations).values({id,credentialHash:credential,version:I.revision.initial,
          state:I.state.detached,createdAt:now,updatedAt:now}).returning();
        if(!created)throw invalid();row=created;
      }
      await db.insert(detachments).values({installationId:id,associationId:target}).onConflictDoNothing();
      if(row.currentAssociationId===target){
        if(row.version>=I.revision.maximum)throw new ConflictException(I.failure.changed);
        await db.update(associations).set({closedAt:now}).where(and(eq(associations.id,target),eq(associations.installationId,id)));
        await db.update(installations).set({version:row.version+I.revision.step,state:I.state.detached,currentAssociationId:null,registrationId:null,
          deviceToken:null,environment:null,registeredAt:null,invalidatedAt:null,updatedAt:now}).where(eq(installations.id,id));
      }
      return installationDetachedSchema.parse({installationId:id,associationId:target,detached:true});
    });
  }
  async invalidate(raw:InstallationTarget,invalidatedAt:Date|null,now=new Date()):Promise<boolean> {
    const parsed=installationTargetSchema.safeParse(raw);
    if(!parsed.success||!Number.isFinite(now.getTime())||invalidatedAt!==null&&!Number.isFinite(invalidatedAt.getTime()))throw new BadRequestException(I.failure.invalid);
    const target=parsed.data;
    return this.database.db.transaction(async db=>{
      await lockNotificationInstallation({db},target.installationId);
      const row=await current({db},target.installationId);
      if(!row||row.state!==I.state.registered||row.currentAssociationId!==target.associationId||row.registrationId!==target.registrationId||row.version>=I.revision.maximum)return false;
      if(!row.registeredAt)throw invalid();
      if(invalidatedAt!==null&&invalidatedAt.getTime()<row.registeredAt.getTime())return false;
      await db.update(installations).set({version:row.version+I.revision.step,state:I.state.invalidated,invalidatedAt,updatedAt:now}).where(eq(installations.id,row.id));
      return true;
    });
  }
}

function invalid(){return new InternalServerErrorException(I.failure.persisted);}
function identifier(raw:string):string {const parsed=notificationIdentifierSchema.safeParse(raw);if(!parsed.success)throw new BadRequestException(I.failure.invalid);return parsed.data;}
function credentialHash(raw:unknown):string {
  const parsed=installationProofSchema.safeParse(raw);if(!parsed.success)throw new UnauthorizedException(I.failure.proof);
  return createHash(I.crypto.algorithm).update(Buffer.from(parsed.data,I.crypto.encoding)).digest(I.crypto.encoding);
}
function requireCredential(row:InstallationRow,credential:string):void {
  if(!installationProofSchema.safeParse(row.credentialHash).success)throw invalid();
  if(!timingSafeEqual(Buffer.from(row.credentialHash,I.crypto.encoding),Buffer.from(credential,I.crypto.encoding)))throw new UnauthorizedException(I.failure.proof);
}
export async function lockNotificationInstallation(database:DatabaseSession,id:string):Promise<void> {
  await database.db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${I.storage.lockPrefix+id},${I.storage.lockSeed}))`);
}
async function current(database:DatabaseSession,id:string):Promise<InstallationRow|undefined> {
  const [row]=await database.db.select().from(installations).where(eq(installations.id,id)).limit(I.storage.one);return row;
}
async function findAssociation(database:DatabaseSession,id:string):Promise<AssociationRow|undefined> {
  const [row]=await database.db.select().from(associations).where(eq(associations.id,id)).limit(I.storage.one);return row;
}
async function requireAccount(database:DatabaseSession,actorId:string,locking:boolean):Promise<void> {
  const query=database.db.select({status:users.status}).from(users).where(eq(users.id,actorId)).limit(I.storage.one);
  const [actor]=locking?await query.for(I.storage.lock):await query;
  if(!actor||!NOTIFICATION_READING.account.readable.some(status=>status===actor.status))throw new ForbiddenException(I.failure.inactive);
}
async function document(database:DatabaseSession,row:InstallationRow,actorId:string):Promise<InstallationDocument> {
  let isCurrentAccount=false;
  if(row.currentAssociationId){
    const association=await findAssociation(database,row.currentAssociationId);
    if(!association||association.installationId!==row.id||association.closedAt!==null)throw invalid();
    isCurrentAccount=association.userId===actorId;
  }
  return installationDocumentSchema.parse({installationId:row.id,version:row.version,state:row.state,associationId:row.currentAssociationId,
    registrationId:row.registrationId,environment:row.environment,registeredAt:row.registeredAt===null?null:row.registeredAt.toISOString(),
    isCurrentAccount,updatedAt:row.updatedAt.toISOString()});
}
function absent(id:string):InstallationDocument {
  return installationDocumentSchema.parse({installationId:id,version:I.revision.absent,state:I.state.unregistered,associationId:null,
    registrationId:null,environment:null,registeredAt:null,isCurrentAccount:false,updatedAt:null});
}

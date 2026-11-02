import {BadRequestException,HttpException,HttpStatus,Inject,Injectable,InternalServerErrorException,NotFoundException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {and,asc,eq,inArray,lte,or} from 'drizzle-orm';
import {alias} from 'drizzle-orm/pg-core';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {users} from '../../../shared/infrastructure/database/schema.identity';
import {notifications} from '../../../shared/infrastructure/database/schema.notifications';
import {notificationPreferences} from '../../../shared/infrastructure/database/schema.notification-preferences';
import {notificationInstallations as installations,notificationDeviceAssociations as associations} from '../../../shared/infrastructure/database/schema.notification-installations';
import {notificationPushDeliveries as deliveries} from '../../../shared/infrastructure/database/schema.notification-push';
import {NOTIFICATION,notificationIdentifierSchema} from '../domain/notification.contract';
import {INSTALLATION as I} from '../domain/notification-installation';
import {NOTIFICATION_READING as READ} from '../domain/notification-reading';
import {NOTIFICATION_PREFERENCES as PREF} from '../domain/notification-preferences';
import {PUSH_DELIVERY as PUSH,pushDeliverySchema,type PushEnvironment,type PushTransportResult} from '../domain/push-delivery';
import {NOTIFICATION_PUSH as N,reservedPushSchema,startedPushSchema,pushTransportResultSchema,type ReservedNotificationPush,type StartedNotificationPush} from '../domain/notification-push.contract';
import {DrizzleNotificationReader} from './drizzle-notification-reader';
import {DrizzleNotificationInstallationsRepository,lockNotificationInstallation} from './drizzle-notification-installations.repository';

const due=alias(deliveries,N.claimAlias);
type DeliveryRow=typeof deliveries.$inferSelect;
type Completion=Partial<typeof deliveries.$inferInsert>;
const releasing={leaseToken:null,leaseUntil:null};

@Injectable()
export class DrizzleNotificationPushesRepository {
  constructor(@Inject(DatabaseService) private readonly database:DatabaseSession) {}

  // The writer supplies its business transaction; device registration never replays old events.
  async enqueue(notificationId:string):Promise<number> {
    const id=notificationIdentifierSchema.parse(notificationId),db=this.database.db;
    const [source]=await db.select({notification:notifications,status:users.status,pushEnabled:notificationPreferences.pushEnabled}).from(notifications)
      .innerJoin(users,eq(users.id,notifications.recipientUserId)).leftJoin(notificationPreferences,eq(notificationPreferences.userId,users.id))
      .where(eq(notifications.id,id)).limit(N.limits.one);
    if(!source)throw new NotFoundException(N.failure.missing);
    if(source.pushEnabled===false||!READ.account.readable.some(value=>value===source.status))return N.limits.zero;
    const targets=await db.select({installationId:installations.id,associationId:associations.id,environment:installations.environment}).from(installations)
      .innerJoin(associations,and(eq(associations.id,installations.currentAssociationId),eq(associations.installationId,installations.id)))
      .where(and(eq(associations.userId,source.notification.recipientUserId),eq(installations.state,I.state.registered)));
    if(!targets.length)return N.limits.zero;
    const rows=await db.insert(deliveries).values(targets.map(target=>{
      if(!target.environment)throw invalid();
      return {...target,environment:target.environment,notificationId:id,expiresAt:new Date(source.notification.createdAt.getTime()+N.limits.lifetimeMs)};
    })).onConflictDoNothing({target:[deliveries.notificationId,deliveries.installationId,deliveries.associationId]}).returning({id:deliveries.id});
    return rows.length;
  }

  async claim(environment:PushEnvironment,now=new Date()):Promise<ReservedNotificationPush[]> {
    if(!pushDeliverySchema.shape.environment.safeParse(environment).success||!validTime(now))throw invalid();
    return this.database.db.transaction(async db=>{
      const rows=await db.select().from(due).where(and(eq(due.environment,environment),or(
        and(inArray(due.status,[N.status.pending,N.status.retry]),lte(due.nextAttemptAt,now)),
        and(inArray(due.status,[N.status.reserved,N.status.sending]),lte(due.leaseUntil,now)))))
        .orderBy(asc(due.nextAttemptAt),asc(due.id)).limit(N.limits.batch).for(N.lock,{of:due,skipLocked:true});
      const reserved:ReservedNotificationPush[]=[];
      for(const row of rows){
        if(row.status===N.status.sending){
          await db.update(deliveries).set({...releasing,status:N.status.uncertain,lastFailure:N.failure.lease,updatedAt:now}).where(eq(deliveries.id,row.id));continue;
        }
        if(row.expiresAt.getTime()<=now.getTime()||row.cancelRequestedAt!==null){
          const cancelled=row.cancelRequestedAt!==null;
          await db.update(deliveries).set({...releasing,status:cancelled?N.status.cancelled:N.status.expired,
            lastFailure:cancelled?N.failure.cancelled:PUSH.failure.expired,updatedAt:now}).where(eq(deliveries.id,row.id));continue;
        }
        const leaseToken=randomUUID();
        await db.update(deliveries).set({status:N.status.reserved,leaseToken,leaseUntil:new Date(now.getTime()+N.limits.leaseMs),updatedAt:now}).where(eq(deliveries.id,row.id));
        reserved.push({id:row.id,leaseToken,installationId:row.installationId,associationId:row.associationId});
      }
      return reserved;
    });
  }

  async start(raw:ReservedNotificationPush,now=new Date()):Promise<StartedNotificationPush|null> {
    const parsed=reservedPushSchema.safeParse(raw);if(!parsed.success||!validTime(now))throw new BadRequestException(N.failure.persisted);
    const reservation=parsed.data;
    return this.database.db.transaction(async db=>{
      // Match registration's lock order; preferences lock user -> delivery. No network under these locks.
      await lockNotificationInstallation({db},reservation.installationId);
      const [source]=await db.select({recipient:notifications.recipientUserId}).from(deliveries).innerJoin(notifications,eq(notifications.id,deliveries.notificationId))
        .where(and(eq(deliveries.id,reservation.id),eq(deliveries.installationId,reservation.installationId))).limit(N.limits.one);
      if(!source)return null;
      await db.select({id:users.id}).from(users).where(eq(users.id,source.recipient)).for(NOTIFICATION.recipientLock);
      const [row]=await db.select().from(deliveries).where(eq(deliveries.id,reservation.id)).limit(N.limits.one).for(N.lock);
      if(!row||row.status!==N.status.reserved||row.leaseToken!==reservation.leaseToken||row.associationId!==reservation.associationId||!row.leaseUntil||row.leaseUntil.getTime()<=now.getTime())return null;
      const cancel=async(reason:string,status:string=N.status.cancelled)=>{
        await db.update(deliveries).set({...releasing,status,lastFailure:reason,updatedAt:now}).where(eq(deliveries.id,row.id));return null;
      };
      if(row.expiresAt.getTime()<=now.getTime())return cancel(PUSH.failure.expired,N.status.expired);
      if(row.cancelRequestedAt!==null)return cancel(N.failure.cancelled);
      const [preference]=await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId,source.recipient)).limit(N.limits.one);
      if(preference?.pushEnabled===false)return cancel(PREF.failure.disabled);
      const [target]=await db.select({installation:installations,association:associations}).from(installations)
        .innerJoin(associations,eq(associations.id,installations.currentAssociationId)).where(eq(installations.id,row.installationId)).limit(N.limits.one);
      if(!target||target.installation.state!==I.state.registered||target.association.id!==row.associationId||target.association.userId!==source.recipient||target.association.closedAt!==null)return cancel(N.failure.association);
      const device=target.installation;
      if(device.environment!==row.environment)return cancel(N.failure.environment);
      try {await new DrizzleNotificationReader({db}).read(source.recipient,row.notificationId);}
      catch(error){if(error instanceof HttpException&&[HttpStatus.FORBIDDEN,HttpStatus.NOT_FOUND].some(status=>status===error.getStatus()))return cancel(N.failure.missing);throw error;}
      if(!device.registrationId||!device.deviceToken)throw invalid();
      const attempts=row.attempts+N.limits.step;
      const push=pushDeliverySchema.parse({deliveryId:row.id,notificationId:row.notificationId,environment:row.environment,deviceToken:device.deviceToken,expiresAt:row.expiresAt});
      await db.update(deliveries).set({status:N.status.sending,attempts,registrationId:device.registrationId,deviceToken:device.deviceToken,
        attemptedAt:now,leaseUntil:new Date(now.getTime()+N.limits.leaseMs),updatedAt:now}).where(eq(deliveries.id,row.id));
      return {...reservation,attempts,registrationId:device.registrationId,attemptedAt:now,push};
    });
  }

  async finish(raw:StartedNotificationPush,rawResult:PushTransportResult,now=new Date()):Promise<boolean> {
    const claim=startedPushSchema.safeParse(raw),result=pushTransportResultSchema.safeParse(rawResult);
    if(!claim.success||!result.success||!validTime(now)||now.getTime()<claim.data.attemptedAt.getTime())throw invalid();
    const attempt=claim.data,outcome=result.data;
    if(attempt.push.deliveryId!==attempt.id||outcome.outcome===PUSH.outcome.accepted&&outcome.providerMessageId!==attempt.id)throw invalid();
    return this.database.db.transaction(async db=>{
      await lockNotificationInstallation({db},attempt.installationId);
      const [row]=await db.select().from(deliveries).where(eq(deliveries.id,attempt.id)).limit(N.limits.one).for(N.lock);
      if(!row||!matches(row,attempt)||!row.leaseUntil||row.leaseUntil.getTime()<=now.getTime())return false;
      let state:Completion={...releasing,updatedAt:now};
      switch(outcome.outcome){
        case PUSH.outcome.accepted:state={...state,status:N.status.accepted,providerMessageId:outcome.providerMessageId,acceptedAt:now,lastFailure:null};break;
        case PUSH.outcome.unknown:state={...state,status:N.status.uncertain,lastFailure:outcome.reason};break;
        case PUSH.outcome.rejected:state={...state,...(outcome.reason===PUSH.failure.credentials?retry(row,outcome.reason,N.limits.credentialsRetryMs,now):{status:N.status.rejected,lastFailure:outcome.reason})};break;
        case PUSH.outcome.expired:state={...state,status:N.status.expired,lastFailure:outcome.reason};break;
        case PUSH.outcome.retry:state={...state,...retry(row,outcome.reason,outcome.retryAfterMs,now)};break;
        case PUSH.outcome.invalidDevice:{
          const invalidated=await new DrizzleNotificationInstallationsRepository({db}).invalidate({installationId:row.installationId,
            associationId:row.associationId,registrationId:attempt.registrationId},outcome.invalidatedAt,now);
          const [device]=await db.select().from(installations).where(eq(installations.id,row.installationId)).limit(N.limits.one);
          const fresh=!invalidated&&device?.state===I.state.registered&&device.currentAssociationId===row.associationId&&device.environment===row.environment;
          state={...state,...(fresh?retry(row,outcome.reason,N.limits.firstRetryMs,now):{status:N.status.rejected,lastFailure:outcome.reason})};break;
        }
      }
      await db.update(deliveries).set(state).where(eq(deliveries.id,row.id));return true;
    });
  }
}
function validTime(now:Date){return Number.isFinite(now.getTime());}
function invalid(){return new InternalServerErrorException(N.failure.persisted);}
function matches(row:DeliveryRow,attempt:StartedNotificationPush):boolean {
  return row.status===N.status.sending&&row.leaseToken===attempt.leaseToken&&row.attempts===attempt.attempts&&row.installationId===attempt.installationId&&
    row.associationId===attempt.associationId&&row.registrationId===attempt.registrationId&&row.deviceToken===attempt.push.deviceToken&&
    row.environment===attempt.push.environment&&row.notificationId===attempt.push.notificationId&&row.expiresAt.getTime()===attempt.push.expiresAt.getTime()&&row.attemptedAt?.getTime()===attempt.attemptedAt.getTime();
}
function retry(row:DeliveryRow,reason:string,requestedDelay:number,now:Date):Completion {
  if(row.cancelRequestedAt!==null)return {status:N.status.cancelled,lastFailure:N.failure.cancelled};
  const backoff=Math.min(N.limits.maximumRetryMs,N.limits.firstRetryMs*N.limits.retryFactor**(row.attempts-N.limits.step));
  const nextAttemptAt=new Date(now.getTime()+Math.max(backoff,requestedDelay));
  if(!validTime(nextAttemptAt))throw invalid();
  return nextAttemptAt.getTime()>=row.expiresAt.getTime()?{status:N.status.expired,lastFailure:PUSH.failure.expired}:
    {status:N.status.retry,lastFailure:reason,nextAttemptAt};
}

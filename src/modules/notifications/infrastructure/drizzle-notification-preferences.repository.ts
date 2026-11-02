import {BadRequestException,ConflictException,ForbiddenException,Inject,Injectable} from '@nestjs/common';
import {and,eq,inArray} from 'drizzle-orm';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT,type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {users} from '../../../shared/infrastructure/database/schema.identity';
import {notificationPreferences as preferences} from '../../../shared/infrastructure/database/schema.notification-preferences';
import {notifications,notificationEmailDeliveries as emails} from '../../../shared/infrastructure/database/schema.notifications';
import {NOTIFICATION_READING} from '../domain/notification-reading';
import {NOTIFICATION_EMAIL} from '../domain/notification-email.contract';
import {NOTIFICATION_PREFERENCES as PREF,notificationPreferencesInputSchema,notificationPreferencesSchema,type NotificationPreferences} from '../domain/notification-preferences';

@Injectable()
export class DrizzleNotificationPreferencesRepository {
  constructor(@Inject(DatabaseService) private readonly database:DatabaseSession) {}
  read(actorId:string):Promise<NotificationPreferences> {
    return this.database.db.transaction(async db=>{await requireAccount({db},actorId,false);return current({db},actorId);},READ_SNAPSHOT);
  }
  async write(actorId:string,raw:unknown):Promise<NotificationPreferences> {
    const parsed=notificationPreferencesInputSchema.safeParse(raw);
    if(!parsed.success)throw new BadRequestException(PREF.failure.invalid);
    const input=parsed.data;
    return this.database.db.transaction(async db=>{
      await requireAccount({db},actorId,true);
      const previous=await current({db},actorId);
      if(previous.version!==input.expectedVersion)throw new ConflictException(PREF.failure.changed);
      if(previous.version!==PREF.revision.absent&&previous.emailEnabled===input.emailEnabled&&previous.pushEnabled===input.pushEnabled)return previous;
      const saved={userId:actorId,version:previous.version+PREF.revision.step,emailEnabled:input.emailEnabled,pushEnabled:input.pushEnabled,updatedAt:new Date()};
      if(previous.version===PREF.revision.absent)await db.insert(preferences).values(saved);
      else await db.update(preferences).set(saved).where(eq(preferences.userId,actorId));
      if(!saved.emailEnabled)await db.update(emails).set({status:NOTIFICATION_EMAIL.status.cancelled,lastFailure:PREF.failure.disabled,updatedAt:saved.updatedAt})
        .where(and(inArray(emails.status,[NOTIFICATION_EMAIL.status.pending,NOTIFICATION_EMAIL.status.retry]),
          inArray(emails.notificationId,db.select({id:notifications.id}).from(notifications).where(eq(notifications.recipientUserId,actorId)))));
      return notificationPreferencesSchema.parse({...saved,updatedAt:saved.updatedAt.toISOString()});
    });
  }
}
async function requireAccount(database:DatabaseSession,actorId:string,lock:boolean):Promise<void> {
  const query=database.db.select({status:users.status}).from(users).where(eq(users.id,actorId)).limit(PREF.persistence.one);
  const [actor]=lock?await query.for(PREF.persistence.lock):await query;
  if(!actor||!NOTIFICATION_READING.account.readable.some(status=>status===actor.status))throw new ForbiddenException(PREF.failure.inactive);
}
async function current(database:DatabaseSession,actorId:string):Promise<NotificationPreferences> {
  const [row]=await database.db.select().from(preferences).where(eq(preferences.userId,actorId)).limit(PREF.persistence.one);
  return notificationPreferencesSchema.parse(row?{...row,updatedAt:row.updatedAt.toISOString()}:
    {userId:actorId,version:PREF.revision.absent,...PREF.defaults,updatedAt:null});
}

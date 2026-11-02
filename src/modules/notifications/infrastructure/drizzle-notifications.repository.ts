import {ConflictException,Inject,Injectable,InternalServerErrorException,NotFoundException} from '@nestjs/common';
import {and,eq} from 'drizzle-orm';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {users} from '../../../shared/infrastructure/database/schema.identity';
import {notifications} from '../../../shared/infrastructure/database/schema.notifications';
import {NOTIFICATION,notificationIntentSchema,type NotificationIntent,type NotificationsWriter} from '../domain/notification.contract';
import {DrizzleNotificationPushesRepository} from './drizzle-notification-pushes.repository';
import {DrizzleNotificationEmailsRepository} from './drizzle-notification-emails.repository';

@Injectable()
export class DrizzleNotificationsRepository implements NotificationsWriter {
  constructor(@Inject(DatabaseService) private readonly database:DatabaseSession) {}
  async record(input:NotificationIntent):Promise<string|null> {
    const intent=notificationIntentSchema.parse(input);
    return this.database.db.transaction(async db=>{
      // Serialize fanout with preference changes without conflicting with recipient foreign keys.
      const [recipient]=await db.select({status:users.status}).from(users).where(eq(users.id,intent.recipientUserId)).limit(NOTIFICATION.limits.minimum).for(NOTIFICATION.recipientLock);
      if(!recipient)throw new NotFoundException(NOTIFICATION.failure.missing);
      if(recipient.status===NOTIFICATION.account.deleted)return null;
      const [created]=await db.insert(notifications).values({eventKey:intent.eventKey,recipientUserId:intent.recipientUserId,
        resourceType:intent.resourceType,resourceId:intent.resourceId,audience:intent.audience,brandId:intent.brandId,
        subject:intent.subject,bodyText:intent.text})
        .onConflictDoNothing({target:[notifications.eventKey,notifications.recipientUserId]}).returning({id:notifications.id});
      if(created){
        await new DrizzleNotificationEmailsRepository({db}).enqueue(created.id);
        await new DrizzleNotificationPushesRepository({db}).enqueue(created.id);
        return created.id;
      }
      const [current]=await db.select().from(notifications).where(and(eq(notifications.eventKey,intent.eventKey),eq(notifications.recipientUserId,intent.recipientUserId))).limit(NOTIFICATION.limits.minimum);
      if(!current)throw new InternalServerErrorException(NOTIFICATION.failure.persisted);
      if(current.resourceType!==intent.resourceType||current.resourceId!==intent.resourceId||current.audience!==intent.audience||current.brandId!==intent.brandId||current.subject!==intent.subject||current.bodyText!==intent.text) {
        throw new ConflictException(NOTIFICATION.failure.changed);
      }
      return current.id;
    });
  }
}

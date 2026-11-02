import {IdentityModule} from '../identity/identity.module';
import {DrizzleNotificationReader} from './infrastructure/drizzle-notification-reader';
import {NotificationsController} from './presentation/notifications.controller';
import {Module} from '@nestjs/common';
import {DatabaseModule} from '../../shared/infrastructure/database/database.module';
import {DrizzleNotificationsRepository} from './infrastructure/drizzle-notifications.repository';
import {DrizzleNotificationEmailsRepository} from './infrastructure/drizzle-notification-emails.repository';
import {NotificationEmailsWorker} from './infrastructure/notification-emails.worker';

@Module({imports:[DatabaseModule,IdentityModule],controllers:[NotificationsController],providers:[DrizzleNotificationReader,DrizzleNotificationsRepository,DrizzleNotificationEmailsRepository,NotificationEmailsWorker],exports:[DrizzleNotificationsRepository]})
export class NotificationsModule {}

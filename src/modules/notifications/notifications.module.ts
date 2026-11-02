import {Module} from '@nestjs/common';
import {DatabaseModule} from '../../shared/infrastructure/database/database.module';
import {DrizzleNotificationsRepository} from './infrastructure/drizzle-notifications.repository';
import {DrizzleNotificationEmailsRepository} from './infrastructure/drizzle-notification-emails.repository';
import {NotificationEmailsWorker} from './infrastructure/notification-emails.worker';

@Module({imports:[DatabaseModule],providers:[DrizzleNotificationsRepository,DrizzleNotificationEmailsRepository,NotificationEmailsWorker],exports:[DrizzleNotificationsRepository]})
export class NotificationsModule {}

import {NotificationPushesWorker} from './infrastructure/notification-pushes.worker';
import {DrizzleNotificationPushesRepository} from './infrastructure/drizzle-notification-pushes.repository';
import {DrizzleNotificationPreferencesRepository} from './infrastructure/drizzle-notification-preferences.repository';
import {DrizzleNotificationInstallationsRepository} from './infrastructure/drizzle-notification-installations.repository';
import {NotificationInstallationsController} from './presentation/notification-installations.controller';
import {IdentityModule} from '../identity/identity.module';
import {DrizzleNotificationReader} from './infrastructure/drizzle-notification-reader';
import {NotificationsController} from './presentation/notifications.controller';
import {Module} from '@nestjs/common';
import {DatabaseModule} from '../../shared/infrastructure/database/database.module';
import {DrizzleNotificationsRepository} from './infrastructure/drizzle-notifications.repository';
import {DrizzleNotificationEmailsRepository} from './infrastructure/drizzle-notification-emails.repository';
import {NotificationEmailsWorker} from './infrastructure/notification-emails.worker';

@Module({imports:[DatabaseModule,IdentityModule],controllers:[NotificationsController,NotificationInstallationsController],providers:[DrizzleNotificationPushesRepository,NotificationPushesWorker,DrizzleNotificationInstallationsRepository,DrizzleNotificationPreferencesRepository,DrizzleNotificationReader,DrizzleNotificationsRepository,DrizzleNotificationEmailsRepository,NotificationEmailsWorker],exports:[DrizzleNotificationsRepository]})
export class NotificationsModule {}

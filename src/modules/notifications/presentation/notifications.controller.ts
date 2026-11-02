import {Controller,Get,Header,Inject,Param,ParseUUIDPipe,UseGuards} from '@nestjs/common';
import {AuthGuard} from '../../../shared/presentation/guards/auth.guard';
import {CurrentUser} from '../../../shared/presentation/decorators/current-user.decorator';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {NOTIFICATION_READING} from '../domain/notification-reading';
import {DrizzleNotificationReader} from '../infrastructure/drizzle-notification-reader';

@Controller(NOTIFICATION_READING.route.root)
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(@Inject(DrizzleNotificationReader) private readonly reader:DrizzleNotificationReader) {}
  @Get(NOTIFICATION_READING.route.detail)
  @Header(NOTIFICATION_READING.response.cacheHeader,NOTIFICATION_READING.response.cachePolicy)
  read(@CurrentUser() actor:AuthenticatedUser,@Param(NOTIFICATION_READING.route.id,ParseUUIDPipe) id:string){
    return this.reader.read(actor.id,id);
  }
}

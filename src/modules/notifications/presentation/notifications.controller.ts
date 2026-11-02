import {DrizzleNotificationPreferencesRepository} from '../infrastructure/drizzle-notification-preferences.repository';
import {NOTIFICATION_PREFERENCES} from '../domain/notification-preferences';
import {Controller,Get,Header,Inject,Body,Put,NotFoundException,Param,ParseUUIDPipe,UseGuards} from '@nestjs/common';
import {AuthGuard} from '../../../shared/presentation/guards/auth.guard';
import {CurrentUser} from '../../../shared/presentation/decorators/current-user.decorator';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {NOTIFICATION_READING} from '../domain/notification-reading';
import {DrizzleNotificationReader} from '../infrastructure/drizzle-notification-reader';

@Controller(NOTIFICATION_READING.route.root)
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(@Inject(DrizzleNotificationReader) private readonly reader:DrizzleNotificationReader,
    @Inject(DrizzleNotificationPreferencesRepository) private readonly preferences:DrizzleNotificationPreferencesRepository) {}
  @Get(NOTIFICATION_PREFERENCES.route.path)
  @Header(NOTIFICATION_READING.response.cacheHeader,NOTIFICATION_READING.response.cachePolicy)
  readPreferences(@CurrentUser() actor:AuthenticatedUser,@Param(NOTIFICATION_PREFERENCES.route.userId,ParseUUIDPipe) userId:string){
    if(actor.id!==userId.toLowerCase())throw new NotFoundException(NOTIFICATION_PREFERENCES.failure.foreign);
    return this.preferences.read(actor.id);
  }
  @Put(NOTIFICATION_PREFERENCES.route.path)
  @Header(NOTIFICATION_READING.response.cacheHeader,NOTIFICATION_READING.response.cachePolicy)
  writePreferences(@CurrentUser() actor:AuthenticatedUser,@Param(NOTIFICATION_PREFERENCES.route.userId,ParseUUIDPipe) userId:string,@Body() input:unknown){
    if(actor.id!==userId.toLowerCase())throw new NotFoundException(NOTIFICATION_PREFERENCES.failure.foreign);
    return this.preferences.write(actor.id,input);
  }
  @Get(NOTIFICATION_READING.route.detail)
  @Header(NOTIFICATION_READING.response.cacheHeader,NOTIFICATION_READING.response.cachePolicy)
  read(@CurrentUser() actor:AuthenticatedUser,@Param(NOTIFICATION_READING.route.id,ParseUUIDPipe) id:string){
    return this.reader.read(actor.id,id);
  }
}

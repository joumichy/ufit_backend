import {Body,Controller,Delete,Get,Header,Headers,Inject,NotFoundException,Param,ParseUUIDPipe,Put,UseGuards} from '@nestjs/common';
import {CurrentUser} from '../../../shared/presentation/decorators/current-user.decorator';
import {AuthGuard} from '../../../shared/presentation/guards/auth.guard';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {INSTALLATION as I} from '../domain/notification-installation';
import {NOTIFICATION_READING} from '../domain/notification-reading';
import {DrizzleNotificationInstallationsRepository} from '../infrastructure/drizzle-notification-installations.repository';

@Controller(I.route.root)
export class NotificationInstallationsController {
  constructor(@Inject(DrizzleNotificationInstallationsRepository) private readonly installations:DrizzleNotificationInstallationsRepository) {}
  @Get(I.route.read)
  @UseGuards(AuthGuard)
  @Header(NOTIFICATION_READING.response.cacheHeader,NOTIFICATION_READING.response.cachePolicy)
  read(@CurrentUser() actor:AuthenticatedUser,@Param(I.route.installationId,ParseUUIDPipe) id:string,@Headers(I.route.proof) proof:unknown){
    return this.installations.read(actor.id,id,proof);
  }
  @Put(I.route.register)
  @UseGuards(AuthGuard)
  @Header(NOTIFICATION_READING.response.cacheHeader,NOTIFICATION_READING.response.cachePolicy)
  register(@CurrentUser() actor:AuthenticatedUser,@Param(I.route.installationId,ParseUUIDPipe) id:string,@Param(I.route.userId,ParseUUIDPipe) userId:string,
    @Headers(I.route.proof) proof:unknown,@Body() body:unknown){
    if(actor.id!==userId.toLowerCase())throw new NotFoundException(I.failure.foreign);
    return this.installations.register(actor.id,id,proof,body);
  }
  @Delete(I.route.detach)
  @Header(NOTIFICATION_READING.response.cacheHeader,NOTIFICATION_READING.response.cachePolicy)
  detach(@Param(I.route.installationId,ParseUUIDPipe) id:string,@Param(I.route.associationId,ParseUUIDPipe) associationId:string,@Headers(I.route.proof) proof:unknown,@Body() body:unknown){
    return this.installations.detach(id,associationId,proof,body);
  }
}

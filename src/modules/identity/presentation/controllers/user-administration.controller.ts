import {Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards} from '@nestjs/common';
import {CurrentUser} from '../../../../shared/presentation/decorators/current-user.decorator';
import {AuthGuard} from '../../../../shared/presentation/guards/auth.guard';
import {AdminGuard} from '../../../../shared/presentation/guards/admin.guard';
import type {AuthenticatedUser} from '../../domain/user.types';
import {USER_ADMINISTRATION} from '../../domain/user-administration.contract';
import {UserAdministrationService} from '../../application/user-administration.service';

@Controller(USER_ADMINISTRATION.route.root)
@UseGuards(AuthGuard, AdminGuard)
export class UserAdministrationController {
  constructor(@Inject(UserAdministrationService) private readonly users: UserAdministrationService) {}
  @Get()
  list(@CurrentUser() actor: AuthenticatedUser, @Query() query: unknown) { return this.users.list(actor.id, query); }
  @Get(USER_ADMINISTRATION.route.user)
  current(@CurrentUser() actor: AuthenticatedUser, @Param(USER_ADMINISTRATION.route.parameter, ParseUUIDPipe) userId: string) { return this.users.current(actor.id, userId); }
  @Get(USER_ADMINISTRATION.route.history)
  history(@CurrentUser() actor: AuthenticatedUser, @Param(USER_ADMINISTRATION.route.parameter, ParseUUIDPipe) userId: string, @Query() query: unknown) { return this.users.history(actor.id, userId, query); }
  @Post(USER_ADMINISTRATION.route.status)
  changeStatus(@CurrentUser() actor: AuthenticatedUser, @Param(USER_ADMINISTRATION.route.parameter, ParseUUIDPipe) userId: string, @Body() body: unknown) { return this.users.changeStatus(actor.id, userId, body); }
  @Post(USER_ADMINISTRATION.route.adminAccess)
  changeAdminAccess(@CurrentUser() actor: AuthenticatedUser, @Param(USER_ADMINISTRATION.route.parameter, ParseUUIDPipe) userId: string, @Body() body: unknown) { return this.users.changeAdminAccess(actor.id, userId, body); }
}

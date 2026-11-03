import {Body, Controller, Get, Inject, Param, Post, Query, UseGuards} from '@nestjs/common';
import {CurrentUser} from '../../../../shared/presentation/decorators/current-user.decorator';
import {AuthGuard} from '../../../../shared/presentation/guards/auth.guard';
import {AdminGuard} from '../../../../shared/presentation/guards/admin.guard';
import type {AuthenticatedUser} from '../../domain/user.types';
import {PROFILE_ADMINISTRATION as P} from '../../domain/profile-administration.contract';
import {ProfileAdministrationService} from '../../application/profile-administration.service';

@Controller(P.route.root)
@UseGuards(AuthGuard, AdminGuard)
export class ProfileAdministrationController {
  constructor(@Inject(ProfileAdministrationService) private readonly profiles: ProfileAdministrationService) {}
  @Get()
  list(@CurrentUser() actor: AuthenticatedUser, @Param(P.route.user) userId: string, @Param(P.route.kind) kind: string, @Query() query: unknown) {
    return this.profiles.list(actor.id, userId, kind, query);
  }
  @Get(P.route.profile)
  current(@CurrentUser() actor: AuthenticatedUser, @Param(P.route.user) userId: string, @Param(P.route.kind) kind: string, @Param(P.route.id) profileId: string) {
    return this.profiles.current(actor.id, userId, kind, profileId);
  }
  @Get(P.route.history)
  history(@CurrentUser() actor: AuthenticatedUser, @Param(P.route.user) userId: string, @Param(P.route.kind) kind: string, @Param(P.route.id) profileId: string, @Query() query: unknown) {
    return this.profiles.history(actor.id, userId, kind, profileId, query);
  }
  @Post(P.route.status)
  change(@CurrentUser() actor: AuthenticatedUser, @Param(P.route.user) userId: string, @Param(P.route.kind) kind: string, @Param(P.route.id) profileId: string, @Body() body: unknown) {
    return this.profiles.change(actor.id, userId, kind, profileId, body);
  }
}

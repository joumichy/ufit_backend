import {Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Put, UseGuards} from '@nestjs/common';
import {CurrentUser} from '../../../../shared/presentation/decorators/current-user.decorator';
import {AuthGuard} from '../../../../shared/presentation/guards/auth.guard';
import type {AuthenticatedUser} from '../../domain/user.types';
import {STYLE_PREFERENCES as S} from '../../domain/style-preferences.contract';
import {DrizzleStylePreferencesRepository} from '../../infrastructure/persistence/drizzle-style-preferences.repository';

@Controller(S.route.root)
@UseGuards(AuthGuard)
export class StylePreferencesController {
  constructor(@Inject(DrizzleStylePreferencesRepository) private readonly preferences: DrizzleStylePreferencesRepository) {}
  @Get(S.route.change)
  change(@CurrentUser() actor: AuthenticatedUser, @Param(S.route.parameter, ParseUUIDPipe) userId: string,
    @Param(S.route.request, ParseUUIDPipe) requestId: string) {
    if (userId.toLowerCase() !== actor.id) throw new NotFoundException(S.failure.unavailable);
    return this.preferences.change(actor.id, requestId.toLowerCase());
  }
  @Get(S.route.user)
  read(@CurrentUser() actor: AuthenticatedUser, @Param(S.route.parameter, ParseUUIDPipe) userId: string) {
    if (userId.toLowerCase() !== actor.id) throw new NotFoundException(S.failure.unavailable);
    return this.preferences.read(actor.id);
  }
  @Put(S.route.user)
  write(@CurrentUser() actor: AuthenticatedUser, @Param(S.route.parameter, ParseUUIDPipe) userId: string, @Body() body: unknown) {
    if (userId.toLowerCase() !== actor.id) throw new NotFoundException(S.failure.unavailable);
    return this.preferences.write(actor.id, body);
  }
}

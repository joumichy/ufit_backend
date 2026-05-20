import { Body, Controller, Get, Inject, Patch, UseGuards } from '@nestjs/common';
import { IdentityService } from '../../application/identity.service';
import { toMeResponse, type MeResponse } from '../../application/dto/me.response';
import type { AuthenticatedUser } from '../../domain/user.types';
import { CurrentUser } from '../../../../shared/presentation/decorators/current-user.decorator';
import { AuthGuard } from '../../../../shared/presentation/guards/auth.guard';
import { UpdateMeRequest } from '../dto/update-me.request';

@Controller('me')
@UseGuards(AuthGuard)
export class MeController {
  constructor(@Inject(IdentityService) private readonly identityService: IdentityService) {}

  @Get()
  getMe(@CurrentUser() currentUser: AuthenticatedUser): MeResponse {
    return toMeResponse(currentUser);
  }

  @Patch()
  async updateMe(
    @CurrentUser() currentUser: AuthenticatedUser,
    @Body() request: UpdateMeRequest
  ): Promise<MeResponse> {
    const updatedUser = await this.identityService.updateProfile(currentUser.id, {
      displayName: request.displayName,
      avatarUrl: request.avatarUrl
    });

    return toMeResponse(updatedUser);
  }
}

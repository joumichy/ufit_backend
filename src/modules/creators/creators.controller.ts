import { Body, Controller, Get, Inject, Patch, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../shared/presentation/decorators/current-user.decorator';
import { AuthGuard } from '../../shared/presentation/guards/auth.guard';
import type { AuthenticatedUser } from '../identity/domain/user.types';
import { mapCreatorProfile } from './creator-response.mapper';
import { CreatorsService } from './creators.service';
import { UpdateCreatorProfileRequest } from './dto/update-creator-profile.request';

@Controller('creators')
@UseGuards(AuthGuard)
export class CreatorsController {
  constructor(@Inject(CreatorsService) private readonly creatorsService: CreatorsService) {}

  @Get('me')
  async getOwnProfile(@CurrentUser() user: AuthenticatedUser) {
    const details = await this.creatorsService.getOwnDetails(user.id);
    return mapCreatorProfile(details.profile, details.socialAccounts);
  }

  @Patch('me')
  async updateOwnProfile(@CurrentUser() user: AuthenticatedUser, @Body() body: UpdateCreatorProfileRequest) {
    await this.creatorsService.updateOwnProfile(user.id, body);
    const details = await this.creatorsService.getOwnDetails(user.id);
    return mapCreatorProfile(details.profile, details.socialAccounts);
  }
}

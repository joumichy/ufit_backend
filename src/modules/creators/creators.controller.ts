import { Body, Controller, Get, Patch, UnauthorizedException } from '@nestjs/common';
import { CurrentUser, type RequestUser } from '../../shared/presentation/auth/current-user.decorator';
import { mapCreatorProfile } from './creator-response.mapper';
import { CreatorsService } from './creators.service';
import { UpdateCreatorProfileRequest } from './dto/update-creator-profile.request';

@Controller('creators')
export class CreatorsController {
  constructor(private readonly creatorsService: CreatorsService) {}

  @Get('me')
  async getOwnProfile(@CurrentUser() user: RequestUser | undefined) {
    if (!user) {
      throw new UnauthorizedException('Authentication is required');
    }
    return mapCreatorProfile(await this.creatorsService.getOwnProfile(user.id));
  }

  @Patch('me')
  async updateOwnProfile(@CurrentUser() user: RequestUser | undefined, @Body() body: UpdateCreatorProfileRequest) {
    if (!user) {
      throw new UnauthorizedException('Authentication is required');
    }
    return mapCreatorProfile(await this.creatorsService.updateOwnProfile(user.id, body));
  }
}

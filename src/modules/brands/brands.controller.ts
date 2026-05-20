import { Body, Controller, Get, Param, Patch, UnauthorizedException } from '@nestjs/common';
import { CurrentUser, type RequestUser } from '../../shared/presentation/auth/current-user.decorator';
import { mapBrandProfile } from './brand-response.mapper';
import { BrandsService } from './brands.service';
import { UpdateBrandProfileRequest } from './dto/update-brand-profile.request';

@Controller('brands')
export class BrandsController {
  constructor(private readonly brandsService: BrandsService) {}

  @Get(':brandProfileId')
  async getProfile(@CurrentUser() user: RequestUser | undefined, @Param('brandProfileId') brandProfileId: string) {
    if (!user) {
      throw new UnauthorizedException('Authentication is required');
    }

    return mapBrandProfile(await this.brandsService.getProfileForMember(brandProfileId, user.id));
  }

  @Patch(':brandProfileId')
  async updateProfile(
    @CurrentUser() user: RequestUser | undefined,
    @Param('brandProfileId') brandProfileId: string,
    @Body() body: UpdateBrandProfileRequest
  ) {
    if (!user) {
      throw new UnauthorizedException('Authentication is required');
    }

    return mapBrandProfile(await this.brandsService.updateProfileForMember(brandProfileId, user.id, body));
  }
}

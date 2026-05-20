import { Body, Controller, Get, Inject, Param, Patch, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../shared/presentation/decorators/current-user.decorator';
import { AuthGuard } from '../../shared/presentation/guards/auth.guard';
import type { AuthenticatedUser } from '../identity/domain/user.types';
import { mapBrandProfile } from './brand-response.mapper';
import { BrandsService } from './brands.service';
import { UpdateBrandProfileRequest } from './dto/update-brand-profile.request';

@Controller('brands')
@UseGuards(AuthGuard)
export class BrandsController {
  constructor(@Inject(BrandsService) private readonly brandsService: BrandsService) {}

  @Get(':brandProfileId')
  async getProfile(@CurrentUser() user: AuthenticatedUser, @Param('brandProfileId') brandProfileId: string) {
    return mapBrandProfile(await this.brandsService.getProfileForMember(brandProfileId, user.id));
  }

  @Patch(':brandProfileId')
  async updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('brandProfileId') brandProfileId: string,
    @Body() body: UpdateBrandProfileRequest
  ) {
    return mapBrandProfile(await this.brandsService.updateProfileForMember(brandProfileId, user.id, body));
  }
}

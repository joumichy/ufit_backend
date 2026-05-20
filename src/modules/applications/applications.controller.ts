import { BadRequestException, Body, Controller, Param, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { CurrentUser, type RequestUser } from '../../shared/presentation/auth/current-user.decorator';
import type { BrandApplicationRow, CreatorApplicationRow } from '../../shared/infrastructure/database/schema';
import { RequireRoles } from '../../shared/presentation/auth/roles.decorator';
import { RolesGuard } from '../../shared/presentation/auth/roles.guard';
import { ApplicationsService } from './applications.service';
import { mapBrandApplication, mapCreatorApplication } from './application-response.mapper';
import { ReviewApplicationRequest } from './dto/review-application.request';
import { SubmitBrandApplicationRequest } from './dto/submit-brand-application.request';
import { SubmitCreatorApplicationRequest } from './dto/submit-creator-application.request';
import type { ApplicationType } from './types/application.types';

@Controller()
@UseGuards(RolesGuard)
export class ApplicationsController {
  constructor(private readonly applicationsService: ApplicationsService) {}

  @Post('applications/creators')
  async submitCreator(@CurrentUser() user: RequestUser | undefined, @Body() body: SubmitCreatorApplicationRequest) {
    if (!user) {
      throw new UnauthorizedException('Authentication is required');
    }

    const application = await this.applicationsService.submitCreatorApplication({
      userId: user.id,
      ...body
    });
    return mapCreatorApplication(application);
  }

  @Post('applications/brands')
  async submitBrand(@CurrentUser() user: RequestUser | undefined, @Body() body: SubmitBrandApplicationRequest) {
    if (!user) {
      throw new UnauthorizedException('Authentication is required');
    }

    const application = await this.applicationsService.submitBrandApplication({
      userId: user.id,
      ...body
    });
    return mapBrandApplication(application);
  }

  @Post('admin/applications/:applicationType/:applicationId/reviews')
  @RequireRoles('admin', 'super_admin')
  async review(
    @CurrentUser() user: RequestUser,
    @Param('applicationType') applicationType: ApplicationType,
    @Param('applicationId') applicationId: string,
    @Body() body: ReviewApplicationRequest
  ) {
    if (applicationType !== 'creator' && applicationType !== 'brand') {
      throw new BadRequestException('applicationType must be creator or brand');
    }

    const result = await this.applicationsService.reviewApplication({
      applicationType,
      applicationId,
      reviewerUserId: user.id,
      decision: body.decision,
      notes: body.notes
    });

    return applicationType === 'creator'
      ? mapCreatorApplication(result.application as CreatorApplicationRow)
      : mapBrandApplication(result.application as BrandApplicationRow);
  }
}

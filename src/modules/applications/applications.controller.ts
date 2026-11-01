import { APPLICATION } from "./types/application-contract";
import { DrizzleApplicationReader } from "./drizzle-application-reader";
import { BadRequestException, Body, Controller, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../shared/presentation/decorators/current-user.decorator';
import { Roles } from '../../shared/presentation/decorators/roles.decorator';
import { AuthGuard } from '../../shared/presentation/guards/auth.guard';
import { RoleGuard } from '../../shared/presentation/guards/role.guard';
import type { AuthenticatedUser } from '../identity/domain/user.types';
import { AdminAuditService } from '../admin-audit/application/admin-audit.service';
import { ApplicationsService } from './applications.service';
import { ReviewApplicationRequest } from './dto/review-application.request';
import { SubmitBrandApplicationRequest } from './dto/submit-brand-application.request';
import { SubmitCreatorApplicationRequest } from './dto/submit-creator-application.request';
import type { ApplicationType } from './types/application.types';

@Controller()
@UseGuards(AuthGuard, RoleGuard)
export class ApplicationsController {
  constructor(
    @Inject(ApplicationsService) private readonly applicationsService: ApplicationsService,
    @Inject(DrizzleApplicationReader) private readonly reader: DrizzleApplicationReader,
    @Inject(AdminAuditService) private readonly adminAuditService: AdminAuditService
  ) {}

  @Post('applications/creators')
  async submitCreator(@CurrentUser() user: AuthenticatedUser, @Body() body: SubmitCreatorApplicationRequest) {
    const application = await this.applicationsService.submitCreatorApplication({
      ...body,
      userId: user.id
    });
    return this.reader.owned(APPLICATION.kind.creator, application.id, user.id);
  }

  @Post('applications/brands')
  async submitBrand(@CurrentUser() user: AuthenticatedUser, @Body() body: SubmitBrandApplicationRequest) {
    const application = await this.applicationsService.submitBrandApplication({
      ...body,
      userId: user.id
    });
    return this.reader.owned(APPLICATION.kind.brand, application.id, user.id);
  }

  @Post('admin/applications/:applicationType/:applicationId/reviews')
  @Roles('admin', 'super_admin')
  async review(
    @CurrentUser() user: AuthenticatedUser,
    @Param('applicationType') applicationType: ApplicationType,
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
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
      expectedVersion: body.expectedVersion,
      notes: body.notes
    });
    await this.adminAuditService.record({
      adminUserId: user.id,
      action: 'application.reviewed',
      targetType: `${applicationType}_application`,
      targetId: applicationId,
      payload: {
        decision: body.decision,
        notes: body.notes ?? null
      }
    });

    return this.reader.admin(applicationType, result.application.id);
  }
}

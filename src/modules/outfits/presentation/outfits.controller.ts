import { Body, Controller, Get, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../../shared/presentation/decorators/current-user.decorator';
import { Roles } from '../../../shared/presentation/decorators/roles.decorator';
import { AuthGuard } from '../../../shared/presentation/guards/auth.guard';
import { RoleGuard } from '../../../shared/presentation/guards/role.guard';
import { AdminAuditService } from '../../admin-audit/application/admin-audit.service';
import type { AuthenticatedUser } from '../../identity/domain/user.types';
import { CreateOutfitDto, ReviewOutfitDto } from '../application/dto/outfit.dto';
import { OutfitsService } from '../application/outfits.service';

@Controller('outfits')
export class OutfitsController {
  constructor(
    @Inject(OutfitsService) private readonly outfitsService: OutfitsService,
    @Inject(AdminAuditService) private readonly adminAuditService: AdminAuditService
  ) {}

  @Post()
  @UseGuards(AuthGuard, RoleGuard)
  @Roles('creator', 'brand_owner', 'brand_manager', 'admin', 'super_admin')
  createOutfit(@Body() body: CreateOutfitDto) {
    return this.outfitsService.createOutfit(body);
  }

  @Patch(':id/submit')
  @UseGuards(AuthGuard, RoleGuard)
  @Roles('creator', 'brand_owner', 'brand_manager', 'admin', 'super_admin')
  submitOutfit(@Param('id') id: string) {
    return this.outfitsService.submitOutfit(id);
  }

  @Patch(':id/review')
  @UseGuards(AuthGuard, RoleGuard)
  @Roles('admin', 'super_admin')
  async reviewOutfit(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: ReviewOutfitDto) {
    const detail = await this.outfitsService.reviewOutfit(id, { ...body, reviewerId: user.id });
    await this.adminAuditService.record({
      adminUserId: user.id,
      action: 'outfit.reviewed',
      targetType: 'outfit',
      targetId: id,
      payload: {
        decision: body.decision,
        rejectionReason: body.rejectionReason ?? null
      }
    });
    return detail;
  }

  @Get()
  getPublicFeed(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.outfitsService.getPublicFeed({ limit: limit ? Number(limit) : undefined, cursor });
  }

  @Get(':id')
  getPublicDetail(@Param('id') id: string) {
    return this.outfitsService.getPublicDetail(id);
  }
}

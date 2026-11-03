import {OUTFIT_PUBLICATION as P, type OutfitPublicationInput} from '../domain/outfit-publication.contract';
import {OUTFIT_WRITE_ROLES, OUTFIT_ADMIN_ROLES} from '../domain/outfit-editing.contract';
import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../../shared/presentation/decorators/current-user.decorator';
import { Roles } from '../../../shared/presentation/decorators/roles.decorator';
import { AuthGuard } from '../../../shared/presentation/guards/auth.guard';
import { RoleGuard } from '../../../shared/presentation/guards/role.guard';
import { AdminAuditService } from '../../admin-audit/application/admin-audit.service';
import type { AuthenticatedUser } from '../../identity/domain/user.types';
import { CreateOutfitDto, ReviewOutfitDto, UpdateOutfitDto, OutfitVersionDto } from '../application/dto/outfit.dto';
import { OutfitsService } from '../application/outfits.service';

const outfitRoutes = {root: 'outfits', id: 'id', requestId: 'requestId', managed: 'managed', metadata: 'metadata', private: ':id/private',
  discovery: 'discovery', creation: 'creation-requests/:requestId', outfit: ':id', submit: ':id/submit', review: ':id/review', archive: ':id/archive', restore: ':id/restore'} as const;

@Controller(outfitRoutes.root)
export class OutfitsController {
  constructor(
    @Inject(OutfitsService) private readonly outfitsService: OutfitsService,
    @Inject(AdminAuditService) private readonly adminAuditService: AdminAuditService
  ) {}

  @Post()
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...OUTFIT_WRITE_ROLES)
  createOutfit(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateOutfitDto) {
    return this.outfitsService.createOutfit(user, body);
  }

  @Patch(outfitRoutes.submit)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...OUTFIT_WRITE_ROLES)
  submitOutfit(@CurrentUser() user: AuthenticatedUser, @Param(outfitRoutes.id, ParseUUIDPipe) id: string, @Body() body: OutfitVersionDto) {
    return this.outfitsService.submitOutfit(user, id, body);
  }

  @Patch(outfitRoutes.review)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...OUTFIT_ADMIN_ROLES)
  async reviewOutfit(@CurrentUser() user: AuthenticatedUser, @Param(outfitRoutes.id, ParseUUIDPipe) id: string, @Body() body: ReviewOutfitDto) {
    const detail = await this.outfitsService.reviewOutfit(user, id, body);
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

  @Get(outfitRoutes.metadata)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...OUTFIT_WRITE_ROLES)
  getMetadata() { return this.outfitsService.getMetadata(); }

  @Get(outfitRoutes.discovery)
  getDiscoveryOptions() { return this.outfitsService.getDiscoveryOptions(); }

  @Get(P.routes.calendar)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...OUTFIT_WRITE_ROLES)
  calendar(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, unknown>) {
    return this.outfitsService.getPublicationCalendar(user, query);
  }

  @Patch(P.routes.publication)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...OUTFIT_WRITE_ROLES)
  publication(@CurrentUser() user: AuthenticatedUser, @Param(outfitRoutes.id, ParseUUIDPipe) id: string, @Body() body: OutfitPublicationInput) {
    return this.outfitsService.planPublication(user, id, body);
  }

  @Get(outfitRoutes.managed)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...OUTFIT_WRITE_ROLES)
  listManaged(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, unknown>) { return this.outfitsService.listManagedOutfits(user, query); }

  @Get(outfitRoutes.creation)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...OUTFIT_WRITE_ROLES)
  recover(@CurrentUser() user: AuthenticatedUser, @Param(outfitRoutes.requestId, ParseUUIDPipe) requestId: string, @Query() query: Record<string, unknown>) {
    return this.outfitsService.recoverCreation(user, query, requestId);
  }

  @Get(outfitRoutes.private)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...OUTFIT_WRITE_ROLES)
  getManaged(@CurrentUser() user: AuthenticatedUser, @Param(outfitRoutes.id, ParseUUIDPipe) id: string) { return this.outfitsService.getManagedOutfit(user, id); }

  @Put(outfitRoutes.outfit)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...OUTFIT_WRITE_ROLES)
  update(@CurrentUser() user: AuthenticatedUser, @Param(outfitRoutes.id, ParseUUIDPipe) id: string, @Body() body: UpdateOutfitDto) { return this.outfitsService.updateOutfit(user, id, body); }

  @Patch(outfitRoutes.archive)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...OUTFIT_WRITE_ROLES)
  archive(@CurrentUser() user: AuthenticatedUser, @Param(outfitRoutes.id, ParseUUIDPipe) id: string, @Body() body: OutfitVersionDto) { return this.outfitsService.archiveOutfit(user, id, body); }

  @Patch(outfitRoutes.restore)
  @UseGuards(AuthGuard, RoleGuard)
  @Roles(...OUTFIT_WRITE_ROLES)
  restore(@CurrentUser() user: AuthenticatedUser, @Param(outfitRoutes.id, ParseUUIDPipe) id: string, @Body() body: OutfitVersionDto) { return this.outfitsService.restoreOutfit(user, id, body); }

  @Get()
  getPublicFeed(@Query() query: Record<string, unknown>) {
    return this.outfitsService.getPublicFeed(query);
  }

  @Get(outfitRoutes.outfit)
  getPublicDetail(@Param(outfitRoutes.id, ParseUUIDPipe) id: string) {
    return this.outfitsService.getPublicDetail(id);
  }
}

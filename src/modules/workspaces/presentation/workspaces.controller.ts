import { Controller, Get, Header, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../../shared/presentation/decorators/current-user.decorator';
import { Roles } from '../../../shared/presentation/decorators/roles.decorator';
import { AuthGuard } from '../../../shared/presentation/guards/auth.guard';
import { RoleGuard } from '../../../shared/presentation/guards/role.guard';
import type { AuthenticatedUser } from '../../identity/domain/user.types';
import { WorkspacesService } from '../application/workspaces.service';
import {WORKSPACE_TRANSFERS as TRANSFERS} from '../domain/workspace-transfers';

function pageFromQuery(limit?: string, offset?: string) {
  return {
    limit: limit === undefined ? undefined : Number(limit),
    offset: offset === undefined ? undefined : Number(offset)
  };
}

const WORKSPACE_REVENUE_ROUTE = {creator: 'creators/me/revenue', brand: 'brands/:brandProfileId/revenue'} as const;
const MEMBERSHIPS_ROUTE = "me/workspaces";
@Controller()
@UseGuards(AuthGuard, RoleGuard)
export class WorkspacesController {
  constructor(@Inject(WorkspacesService) private readonly workspacesService: WorkspacesService) {}

  @Get(TRANSFERS.route.creator)
  @Header(TRANSFERS.cache.header, TRANSFERS.cache.value)
  @Roles(...TRANSFERS.roles.creator)
  getCreatorTransfers(@CurrentUser() user: AuthenticatedUser, @Query() raw: unknown) {
    return this.workspacesService.getCreatorTransfers(user.id, raw);
  }

  @Get(TRANSFERS.route.brand)
  @Header(TRANSFERS.cache.header, TRANSFERS.cache.value)
  @Roles(...TRANSFERS.roles.brand)
  getBrandTransfers(@CurrentUser() user: AuthenticatedUser, @Param(TRANSFERS.route.brandId) brandProfileId: string, @Query() raw: unknown) {
    return this.workspacesService.getBrandTransfers(brandProfileId, user.id, raw);
  }

  @Get(MEMBERSHIPS_ROUTE)
  memberships(@CurrentUser() user: AuthenticatedUser, @Query() raw: unknown) {
    return this.workspacesService.listForUser(user.id, raw);
  }

  @Get('creators/me/dashboard')
  @Roles('creator')
  getCreatorDashboard(@CurrentUser() user: AuthenticatedUser) {
    return this.workspacesService.getCreatorDashboard(user.id);
  }

  @Get(WORKSPACE_REVENUE_ROUTE.creator)
  @Roles('creator')
  getCreatorRevenue(@CurrentUser() user: AuthenticatedUser, @Query() raw: unknown) {
    return this.workspacesService.getCreatorRevenue(user.id, raw);
  }

  @Get(WORKSPACE_REVENUE_ROUTE.brand)
  @Roles('brand_owner', 'brand_manager')
  getBrandRevenue(@CurrentUser() user: AuthenticatedUser, @Param('brandProfileId') brandProfileId: string, @Query() raw: unknown) {
    return this.workspacesService.getBrandRevenue(brandProfileId, user.id, raw);
  }

  @Get('creators/me/outfits')
  @Roles('creator')
  listCreatorOutfits(@CurrentUser() user: AuthenticatedUser, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.workspacesService.listCreatorOutfits(user.id, pageFromQuery(limit, offset));
  }

  @Get('brands/:brandProfileId/dashboard')
  @Roles('brand_owner', 'brand_manager')
  getBrandDashboard(@CurrentUser() user: AuthenticatedUser, @Param('brandProfileId') brandProfileId: string) {
    return this.workspacesService.getBrandDashboard(brandProfileId, user.id);
  }

  @Get('brands/:brandProfileId/products')
  @Roles('brand_owner', 'brand_manager')
  listBrandProducts(
    @CurrentUser() user: AuthenticatedUser,
    @Param('brandProfileId') brandProfileId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string
  ) {
    return this.workspacesService.listBrandProducts(brandProfileId, user.id, pageFromQuery(limit, offset));
  }

  @Get('brands/:brandProfileId/outfit-integrations')
  @Roles('brand_owner', 'brand_manager')
  listBrandOutfitIntegrations(
    @CurrentUser() user: AuthenticatedUser,
    @Param('brandProfileId') brandProfileId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string
  ) {
    return this.workspacesService.listBrandOutfitIntegrations(brandProfileId, user.id, pageFromQuery(limit, offset));
  }
}

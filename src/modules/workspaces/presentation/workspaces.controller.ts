import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../../shared/presentation/decorators/current-user.decorator';
import { Roles } from '../../../shared/presentation/decorators/roles.decorator';
import { AuthGuard } from '../../../shared/presentation/guards/auth.guard';
import { RoleGuard } from '../../../shared/presentation/guards/role.guard';
import type { AuthenticatedUser } from '../../identity/domain/user.types';
import { WorkspacesService } from '../application/workspaces.service';

function pageFromQuery(limit?: string, offset?: string) {
  return {
    limit: limit === undefined ? undefined : Number(limit),
    offset: offset === undefined ? undefined : Number(offset)
  };
}

const MEMBERSHIPS_ROUTE = "me/workspaces";
@Controller()
@UseGuards(AuthGuard, RoleGuard)
export class WorkspacesController {
  constructor(@Inject(WorkspacesService) private readonly workspacesService: WorkspacesService) {}

  @Get(MEMBERSHIPS_ROUTE)
  memberships(@CurrentUser() user: AuthenticatedUser, @Query() raw: unknown) {
    return this.workspacesService.listForUser(user.id, raw);
  }

  @Get('creators/me/dashboard')
  @Roles('creator')
  getCreatorDashboard(@CurrentUser() user: AuthenticatedUser) {
    return this.workspacesService.getCreatorDashboard(user.id);
  }

  @Get('creators/me/outfits')
  @Roles('creator')
  listCreatorOutfits(@CurrentUser() user: AuthenticatedUser, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.workspacesService.listCreatorOutfits(user.id, pageFromQuery(limit, offset));
  }

  @Get('creators/me/commissions')
  @Roles('creator')
  listCreatorCommissions(@CurrentUser() user: AuthenticatedUser, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.workspacesService.listCreatorCommissions(user.id, pageFromQuery(limit, offset));
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

  @Get('brands/:brandProfileId/orders')
  @Roles('brand_owner', 'brand_manager')
  listBrandOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Param('brandProfileId') brandProfileId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string
  ) {
    return this.workspacesService.listBrandOrders(brandProfileId, user.id, pageFromQuery(limit, offset));
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

import {Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards} from '@nestjs/common';
import {CurrentUser} from '../../../shared/presentation/decorators/current-user.decorator';
import {Roles} from '../../../shared/presentation/decorators/roles.decorator';
import {AuthGuard} from '../../../shared/presentation/guards/auth.guard';
import {RoleGuard} from '../../../shared/presentation/guards/role.guard';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {EDITORIAL as E} from '../domain/editorial.contract';
import {EditorialService} from '../application/editorial.service';
@Controller(E.route.root)
export class EditorialController {
  constructor(@Inject(EditorialService) private readonly editorial: EditorialService) {}
  @Get(E.route.managedPage) @UseGuards(AuthGuard, RoleGuard) @Roles(...E.roles)
  managedPage(@CurrentUser() user: AuthenticatedUser, @Query() query: unknown) { return this.editorial.managedPage(user.id, query); }
  @Get(E.route.change) @UseGuards(AuthGuard, RoleGuard) @Roles(...E.roles)
  change(@CurrentUser() user: AuthenticatedUser, @Param(E.param.requestId, ParseUUIDPipe) requestId: string) { return this.editorial.change(user.id, requestId.toLowerCase()); }
  @Get(E.route.managed) @UseGuards(AuthGuard, RoleGuard) @Roles(...E.roles)
  managed(@CurrentUser() user: AuthenticatedUser, @Param(E.param.id, ParseUUIDPipe) id: string) { return this.editorial.managed(user.id, id.toLowerCase()); }
  @Post(E.route.collections) @UseGuards(AuthGuard, RoleGuard) @Roles(...E.roles)
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) { return this.editorial.createCollection(user.id, body); }
  @Put(E.route.collection) @UseGuards(AuthGuard, RoleGuard) @Roles(...E.roles)
  edit(@CurrentUser() user: AuthenticatedUser, @Param(E.param.id, ParseUUIDPipe) id: string, @Body() body: unknown) { return this.editorial.editCollection(user.id, id.toLowerCase(), body); }
  @Patch(E.route.transition) @UseGuards(AuthGuard, RoleGuard) @Roles(...E.roles)
  transition(@CurrentUser() user: AuthenticatedUser, @Param(E.param.id, ParseUUIDPipe) id: string, @Param(E.param.action) action: string, @Body() body: unknown) {
    return this.editorial.transition(user.id, id.toLowerCase(), action, body);
  }
  @Get(E.route.collections)
  publicPage(@Query() query: unknown) { return this.editorial.getPublicCollections(query); }
  @Get(E.route.items)
  publicItems(@Param(E.param.id, ParseUUIDPipe) id: string, @Query() query: unknown) { return this.editorial.getPublicItems(id.toLowerCase(), query); }
  @Get(E.route.collection)
  publicDetail(@Param(E.param.id, ParseUUIDPipe) id: string) { return this.editorial.getPublicDetail(id.toLowerCase()); }
}

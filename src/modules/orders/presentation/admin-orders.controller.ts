import {Controller, Get, Header, Inject, Param, Query, UseGuards} from '@nestjs/common';
import {AuthGuard} from '../../../shared/presentation/guards/auth.guard';
import {AdminGuard} from '../../../shared/presentation/guards/admin.guard';
import {CurrentUser} from '../../../shared/presentation/decorators/current-user.decorator';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {ADMIN_ORDERS as A} from '../domain/admin-orders.contract';
import {AdminOrdersService} from '../application/admin-orders.service';

@Controller(A.route.root)
@UseGuards(AuthGuard, AdminGuard)
export class AdminOrdersController {
  constructor(@Inject(AdminOrdersService) private readonly orders: AdminOrdersService) {}
  @Get() @Header(A.cache.header, A.cache.value)
  list(@CurrentUser() actor: AuthenticatedUser, @Query() query: unknown) { return this.orders.list(actor.id, query); }
  @Get(A.route.detail) @Header(A.cache.header, A.cache.value)
  detail(@CurrentUser() actor: AuthenticatedUser, @Param(A.route.id) id: string) { return this.orders.detail(actor.id, id); }
  @Get(A.route.returns) @Header(A.cache.header, A.cache.value)
  returns(@CurrentUser() actor: AuthenticatedUser, @Param(A.route.id) id: string, @Query() query: unknown) { return this.orders.relatedReturns(actor.id, id, query); }
}

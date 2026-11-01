import {Controller, Get, Inject, Param, ParseUUIDPipe, Query, UseGuards} from '@nestjs/common';
import {IsIn, IsOptional} from 'class-validator';
import {AuthGuard} from '../../../shared/presentation/guards/auth.guard';
import {RoleGuard} from '../../../shared/presentation/guards/role.guard';
import {CurrentUser} from '../../../shared/presentation/decorators/current-user.decorator';
import {Roles} from '../../../shared/presentation/decorators/roles.decorator';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {BrandOrdersService} from '../application/brand-orders.service';
import {BRAND_ORDERS} from '../domain/brand-order.contract';
import type {OrderStatus} from '../domain/order-lifecycle';
import {OrderPageQuery} from './dto/order-page.query';
export class BrandOrderPageQuery extends OrderPageQuery {
  @IsOptional() @IsIn(BRAND_ORDERS.visibleStatuses) status?: OrderStatus;
}
@Controller(BRAND_ORDERS.route.root)
@UseGuards(AuthGuard, RoleGuard)
@Roles(...BRAND_ORDERS.roles)
export class BrandOrdersController {
  constructor(@Inject(BrandOrdersService) private readonly orders: BrandOrdersService) {}
  @Get()
  list(@CurrentUser() actor: AuthenticatedUser, @Param(BRAND_ORDERS.route.brandId, ParseUUIDPipe) brandId: string, @Query() query: BrandOrderPageQuery) {
    return this.orders.list(actor, brandId, query);
  }
  @Get(BRAND_ORDERS.route.detail)
  detail(@CurrentUser() actor: AuthenticatedUser, @Param(BRAND_ORDERS.route.brandId, ParseUUIDPipe) brandId: string, @Param(BRAND_ORDERS.route.id, ParseUUIDPipe) id: string) {
    return this.orders.detail(actor, brandId, id);
  }
}

import {Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards} from '@nestjs/common';
import {AuthGuard} from '../../../shared/presentation/guards/auth.guard';
import {CurrentUser} from '../../../shared/presentation/decorators/current-user.decorator';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {OrderReturnsService} from '../application/order-returns.service';
import {ORDER_RETURN} from '../domain/order-return.contract';
import {RETURN_ACTOR} from '../domain/order-return';
import {ReturnPageQuery} from './dto/return-page.query';

@Controller(ORDER_RETURN.route.customer)
@UseGuards(AuthGuard)
export class CustomerReturnsController {
  constructor(@Inject(OrderReturnsService) private readonly returns: OrderReturnsService) {}
  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Param(ORDER_RETURN.route.orderId, ParseUUIDPipe) orderId: string, @Query() query: ReturnPageQuery) {
    return this.returns.list(user.id, {kind: RETURN_ACTOR.customer, orderId}, query);
  }
  @Get(ORDER_RETURN.route.options)
  options(@CurrentUser() user: AuthenticatedUser, @Param(ORDER_RETURN.route.orderId, ParseUUIDPipe) orderId: string) {
    return this.returns.options(user.id, orderId);
  }
  @Post(ORDER_RETURN.route.preview)
  preview(@CurrentUser() user: AuthenticatedUser, @Param(ORDER_RETURN.route.orderId, ParseUUIDPipe) orderId: string, @Body() body: unknown) {
    return this.returns.preview(user.id, orderId, body);
  }
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Param(ORDER_RETURN.route.orderId, ParseUUIDPipe) orderId: string, @Body() body: unknown) {
    return this.returns.create(user.id, orderId, body);
  }
  @Get(ORDER_RETURN.route.detail)
  detail(@CurrentUser() user: AuthenticatedUser, @Param(ORDER_RETURN.route.orderId, ParseUUIDPipe) orderId: string, @Param(ORDER_RETURN.route.id, ParseUUIDPipe) id: string) {
    return this.returns.detail(user.id, {kind: RETURN_ACTOR.customer, orderId}, id);
  }
  @Post(ORDER_RETURN.route.actions)
  act(@CurrentUser() user: AuthenticatedUser, @Param(ORDER_RETURN.route.orderId, ParseUUIDPipe) orderId: string, @Param(ORDER_RETURN.route.id, ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.returns.act(user.id, {kind: RETURN_ACTOR.customer, orderId}, id, body);
  }
}

@Controller(ORDER_RETURN.route.brand)
@UseGuards(AuthGuard)
export class BrandReturnsController {
  constructor(@Inject(OrderReturnsService) private readonly returns: OrderReturnsService) {}
  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Param(ORDER_RETURN.route.brandId, ParseUUIDPipe) brandId: string, @Query() query: ReturnPageQuery) {
    return this.returns.list(user.id, {kind: RETURN_ACTOR.brand, brandId}, query);
  }
  @Get(ORDER_RETURN.route.detail)
  detail(@CurrentUser() user: AuthenticatedUser, @Param(ORDER_RETURN.route.brandId, ParseUUIDPipe) brandId: string, @Param(ORDER_RETURN.route.id, ParseUUIDPipe) id: string) {
    return this.returns.detail(user.id, {kind: RETURN_ACTOR.brand, brandId}, id);
  }
  @Post(ORDER_RETURN.route.actions)
  act(@CurrentUser() user: AuthenticatedUser, @Param(ORDER_RETURN.route.brandId, ParseUUIDPipe) brandId: string, @Param(ORDER_RETURN.route.id, ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.returns.act(user.id, {kind: RETURN_ACTOR.brand, brandId}, id, body);
  }
}

@Controller(ORDER_RETURN.route.admin)
@UseGuards(AuthGuard)
export class AdminReturnsController {
  constructor(@Inject(OrderReturnsService) private readonly returns: OrderReturnsService) {}
  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ReturnPageQuery) {
    return this.returns.list(user.id, {kind: RETURN_ACTOR.administrator}, query);
  }
  @Get(ORDER_RETURN.route.detail)
  detail(@CurrentUser() user: AuthenticatedUser, @Param(ORDER_RETURN.route.id, ParseUUIDPipe) id: string) {
    return this.returns.detail(user.id, {kind: RETURN_ACTOR.administrator}, id);
  }
  @Post(ORDER_RETURN.route.actions)
  act(@CurrentUser() user: AuthenticatedUser, @Param(ORDER_RETURN.route.id, ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.returns.act(user.id, {kind: RETURN_ACTOR.administrator}, id, body);
  }
}

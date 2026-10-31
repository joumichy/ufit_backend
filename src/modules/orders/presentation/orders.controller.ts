import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../../shared/presentation/guards/auth.guard';
import { CurrentUser } from '../../../shared/presentation/decorators/current-user.decorator';
import { OrderCheckoutService } from '../application/order-checkout.service';
import type { AuthenticatedUser } from '../../identity/domain/user.types';
import { OrderPageQuery } from './dto/order-page.query';
import { OrdersService } from '../application/orders.service';

@Controller('orders')
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(
    @Inject(OrdersService) private readonly ordersService: OrdersService,
    @Inject(OrderCheckoutService) private readonly checkoutService: OrderCheckoutService
  ) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: OrderPageQuery) {
    return this.ordersService.listForCustomer(user.id, query.limit, query.cursor);
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.ordersService.getForCustomer(user.id, id);
  }

  @Post('checkout')
  checkout(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.checkoutService.checkout(user.id, body);
  }
}

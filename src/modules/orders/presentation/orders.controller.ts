import { Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../../shared/presentation/guards/auth.guard';
import { OrdersService } from '../application/orders.service';

@Controller('orders')
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(@Inject(OrdersService) private readonly ordersService: OrdersService) {}

  @Post('checkout')
  checkout() {
    return this.ordersService.checkoutPlaceholder();
  }
}

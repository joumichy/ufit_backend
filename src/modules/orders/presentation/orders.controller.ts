import { Controller, Post } from '@nestjs/common';
import { OrdersService } from '../application/orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post('checkout')
  checkout() {
    return this.ordersService.checkoutPlaceholder();
  }
}

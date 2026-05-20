import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../../shared/presentation/guards/auth.guard';
import { CurrentUser } from '../../../shared/presentation/decorators/current-user.decorator';
import { CartService } from '../../cart/application/cart.service';
import type { AuthenticatedUser } from '../../identity/domain/user.types';
import { PaymentsService } from '../../payments/application/payments.service';
import { OrdersService, type ShippingAddressSnapshot } from '../application/orders.service';

interface CheckoutBody {
  shippingAddress: ShippingAddressSnapshot;
  shippingAmount?: number;
}

@Controller('orders')
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(
    @Inject(OrdersService) private readonly ordersService: OrdersService,
    @Inject(CartService) private readonly cartService: CartService,
    @Inject(PaymentsService) private readonly paymentsService: PaymentsService
  ) {}

  @Post('checkout')
  async checkout(@CurrentUser() user: AuthenticatedUser, @Body() body: CheckoutBody) {
    const cart = await this.cartService.getActiveForCheckout(user.id);
    const order = await this.ordersService.createPendingFromCart(cart, body.shippingAddress, body.shippingAmount ?? 0);
    return this.paymentsService.createCheckoutSession(order);
  }
}

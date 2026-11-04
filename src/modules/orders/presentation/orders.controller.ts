import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "../../../shared/presentation/guards/auth.guard";
import { CurrentUser } from "../../../shared/presentation/decorators/current-user.decorator";
import { OrderCheckoutService } from "../application/order-checkout.service";
import type { AuthenticatedUser } from "../../identity/domain/user.types";
import { OrderPageQuery } from "./dto/order-page.query";
import { OrderCancellationService } from "../application/order-cancellation.service";
import { PaymentsService } from "../../payments/application/payments.service";
import {CUSTOMER_PAYMENT} from '../../payments/domain/customer-payment';
import { OrdersService } from "../application/orders.service";
import {CHECKOUT_REQUEST} from '../domain/checkout-request';

@Controller("orders")
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(
    @Inject(OrdersService) private readonly ordersService: OrdersService,
    @Inject(OrderCheckoutService)
    private readonly checkoutService: OrderCheckoutService,
    @Inject(OrderCancellationService)
    private readonly cancellations: OrderCancellationService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: OrderPageQuery) {
    return this.ordersService.listForCustomer(
      user.id,
      query.limit,
      query.cursor,
    );
  }

  @Get(":id")
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.ordersService.getForCustomer(user.id, id);
  }

  @Get(CHECKOUT_REQUEST.route.outcome)
  @Header(CHECKOUT_REQUEST.cache.header, CHECKOUT_REQUEST.cache.value)
  outcome(@CurrentUser() user: AuthenticatedUser,
    @Param(CHECKOUT_REQUEST.route.requestId, ParseUUIDPipe) requestId: string) {
    return this.checkoutService.outcome(user.id, requestId);
  }

  @Post(":id/cancel")
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.cancellations.cancel(user.id, id);
  }

  @Post(":id/payment")
  @Header(CUSTOMER_PAYMENT.cache.header, CUSTOMER_PAYMENT.cache.value)
  async resume(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const order = await this.ordersService.getForCustomer(user.id, id);
    return this.payments.createPaymentIntent(order);
  }

  @Get(CUSTOMER_PAYMENT.route.status)
  @Header(CUSTOMER_PAYMENT.cache.header, CUSTOMER_PAYMENT.cache.value)
  async paymentStatus(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    const order = await this.ordersService.getForCustomer(user.id, id);
    return this.payments.paymentStatus(order);
  }

  @Post("checkout")
  @Header(CHECKOUT_REQUEST.cache.header, CHECKOUT_REQUEST.cache.value)
  checkout(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.checkoutService.checkout(user.id, body);
  }
}

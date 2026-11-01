import {
  Body,
  Controller,
  Get,
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
import { ORDER_STATUS, ORDER_FAILURE } from "../domain/order-lifecycle";
import { ConflictException } from "@nestjs/common";
import { OrdersService } from "../application/orders.service";

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

  @Post(":id/cancel")
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.cancellations.cancel(user.id, id);
  }

  @Post(":id/payment")
  async resume(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const order = await this.ordersService.getForCustomer(user.id, id);
    if (order.status !== ORDER_STATUS.pendingPayment)
      throw new ConflictException(ORDER_FAILURE.paymentUnavailable);
    return this.payments.createPaymentIntent(order);
  }

  @Post("checkout")
  checkout(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.checkoutService.checkout(user.id, body);
  }
}

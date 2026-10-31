import { Inject, Injectable, forwardRef } from "@nestjs/common";
import { PaymentsService } from "../../payments/application/payments.service";
import { OrdersService } from "./orders.service";
import {
  CANCELLATION,
  type OrderCancellationRepository,
} from "../domain/order-lifecycle";
@Injectable()
export class OrderCancellationService {
  constructor(
    @Inject(CANCELLATION.repository)
    private readonly cancellations: OrderCancellationRepository,
    @Inject(forwardRef(() => PaymentsService))
    private readonly payments: PaymentsService,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}
  async cancel(customerId: string, orderId: string) {
    const claim = await this.cancellations.claim(customerId, orderId);
    if (claim.status === CANCELLATION.status.succeeded)
      return this.orders.getForCustomer(customerId, orderId);
    const result = await this.payments.reverseCancellation(claim);
    if (result.refundId)
      await this.cancellations.rememberRefund(claim, result.refundId);
    if (result.settlement)
      await this.cancellations.complete(claim, result.settlement);
    return this.orders.getForCustomer(customerId, orderId);
  }
}

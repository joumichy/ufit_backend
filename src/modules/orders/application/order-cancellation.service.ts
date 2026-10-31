import { Inject, Injectable, forwardRef } from "@nestjs/common";
import { PaymentsService } from "../../payments/application/payments.service";
import { OrdersService } from "./orders.service";
import {
  CANCELLATION,
  type OrderCancellationRepository,
  type CancellationClaim,
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
    await this.settle(claim);
    return this.orders.getForCustomer(customerId, orderId);
  }
  async recoverOrder(orderId: string): Promise<void> {
    const claim = await this.cancellations.findPending(orderId);
    if (claim) await this.settle(claim);
  }
  async recoverDue(): Promise<void> {
    const claims = await this.cancellations.claimRecoverable();
    // Claims remain due after their persisted lease if Stripe is unavailable or still processing.
    await Promise.allSettled(claims.map((claim) => this.settle(claim)));
  }
  private async settle(claim: CancellationClaim): Promise<void> {
    const result = await this.payments.reverseCancellation(claim);
    if (result.refundId)
      await this.cancellations.rememberRefund(claim, result.refundId);
    if (result.settlement)
      await this.cancellations.complete(claim, result.settlement);
  }
}

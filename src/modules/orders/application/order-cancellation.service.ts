import {Inject, Injectable, forwardRef} from '@nestjs/common';
import {PaymentsService} from '../../payments/application/payments.service';
import {OrdersService} from './orders.service';
import {CANCELLATION, type OrderCancellationRepository, type CancellationClaim, type CancellationRefundReference} from '../domain/order-lifecycle';

@Injectable()
export class OrderCancellationService {
  constructor(@Inject(CANCELLATION.repository) private readonly cancellations: OrderCancellationRepository,
    @Inject(forwardRef(() => PaymentsService)) private readonly payments: PaymentsService,
    @Inject(OrdersService) private readonly orders: OrdersService) {}
  async cancel(customerId: string, orderId: string) {
    const claim = await this.cancellations.claim(customerId, orderId);
    if (claim.status === CANCELLATION.status.requested) await this.settle(claim);
    return this.orders.getForCustomer(customerId, orderId);
  }
  async recoverOrder(orderId: string): Promise<void> {
    const claim = await this.cancellations.findPending(orderId);
    if (claim) await this.settle(claim);
  }
  async recoverDue(): Promise<void> {
    const claims = await this.cancellations.claimRecoverable();
    // The lease remains durable when Stripe or SQL is unavailable.
    await Promise.allSettled(claims.map(claim => this.settle(claim)));
  }
  async reconcile(reference: CancellationRefundReference): Promise<boolean> {
    const claim = await this.cancellations.findRefund(reference);
    return this.settle(claim);
  }
  private async settle(claim: CancellationClaim): Promise<boolean> {
    const result = await this.payments.reverseCancellation(claim, () => this.cancellations.prepareRefund(claim));
    let changed = false;
    if (result.refund) changed = await this.cancellations.recordRefund(claim, result.refund.attempt, result.refund.result);
    // Financial facts are committed first, even when a payout prevents physical cancellation.
    if (result.settlement) await this.cancellations.complete(claim, result.settlement);
    else if (result.refund) await this.cancellations.complete(claim);
    return changed;
  }
}

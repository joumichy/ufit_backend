import {Inject, Injectable, forwardRef} from '@nestjs/common';
import {PaymentsService} from '../../payments/application/payments.service';
import {RETURN_REFUND, type ReturnRefundRepository, type ReturnRefundReference} from '../domain/return-refund';

@Injectable()
export class ReturnRefundsService {
  constructor(@Inject(RETURN_REFUND.repository) private readonly refunds: ReturnRefundRepository,
    @Inject(forwardRef(() => PaymentsService)) private readonly payments: PaymentsService) {}
  async recoverDue(): Promise<void> {
    const claims = await this.refunds.claimRecoverable();
    // The durable attempt remains due after its lease if the provider or database is unavailable.
    await Promise.allSettled(claims.map(async claim => this.refunds.settle(claim, await this.payments.refundReturn(claim))));
  }
  async reconcile(reference: ReturnRefundReference): Promise<boolean> {
    const claim = await this.refunds.findAttempt(reference);
    // A known refund ID only retrieves provider facts; webhook replay cannot create a refund.
    return this.refunds.settle(claim, await this.payments.refundReturn(claim));
  }
}

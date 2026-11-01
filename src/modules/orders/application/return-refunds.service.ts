import {Inject, Injectable, forwardRef} from '@nestjs/common';
import {PaymentsService} from '../../payments/application/payments.service';
import {RETURN_REFUND, type ReturnRefundRepository} from '../domain/return-refund';

@Injectable()
export class ReturnRefundsService {
  constructor(@Inject(RETURN_REFUND.repository) private readonly refunds: ReturnRefundRepository,
    @Inject(forwardRef(() => PaymentsService)) private readonly payments: PaymentsService) {}
  async recoverDue(): Promise<void> {
    const claims = await this.refunds.claimRecoverable();
    // The durable attempt remains due after its lease if the provider or database is unavailable.
    await Promise.allSettled(claims.map(async claim => this.refunds.settle(claim, await this.payments.refundReturn(claim))));
  }
}

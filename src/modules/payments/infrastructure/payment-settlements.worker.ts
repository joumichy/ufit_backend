import {Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy} from '@nestjs/common';
import {PaymentSettlementsService} from '../application/payment-settlements.service';
import {RefundSettlementsService} from '../application/refund-settlements.service';
import {PaymentDisbursementsService} from '../application/payment-disbursements.service';
import {PAYMENT_SETTLEMENT as C} from '../domain/payment-settlement';

@Injectable()
export class PaymentSettlementsWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopped = false;
  constructor(@Inject(PaymentSettlementsService) private readonly settlements: PaymentSettlementsService,
    @Inject(RefundSettlementsService) private readonly refunds: RefundSettlementsService,
    @Inject(PaymentDisbursementsService) private readonly disbursements: PaymentDisbursementsService) {}
  onApplicationBootstrap(): void { if (this.settlements.canSynchronize) this.schedule(); }
  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = Promise.allSettled([this.settlements.recoverDue(), this.refunds.recoverDue(), this.disbursements.recoverDue()]).then(() => undefined);
      void this.running.then(() => this.schedule(), () => this.schedule());
    }, C.limits.pollMs);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> { this.stopped = true; clearTimeout(this.timer); await this.running?.catch(() => undefined); }
}

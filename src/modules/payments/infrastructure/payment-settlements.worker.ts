import {Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy} from '@nestjs/common';
import {PaymentSettlementsService} from '../application/payment-settlements.service';
import {PAYMENT_SETTLEMENT as C} from '../domain/payment-settlement';

@Injectable()
export class PaymentSettlementsWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopped = false;
  constructor(@Inject(PaymentSettlementsService) private readonly settlements: PaymentSettlementsService) {}
  onApplicationBootstrap(): void { if (this.settlements.canSynchronize) this.schedule(); }
  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.settlements.recoverDue();
      void this.running.then(() => this.schedule(), () => this.schedule());
    }, C.limits.pollMs);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> { this.stopped = true; clearTimeout(this.timer); await this.running?.catch(() => undefined); }
}

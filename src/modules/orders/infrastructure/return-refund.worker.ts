import {Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy} from '@nestjs/common';
import {ReturnRefundsService} from '../application/return-refunds.service';
import {RETURN_REFUND} from '../domain/return-refund';

@Injectable()
export class ReturnRefundWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private running?: Promise<void>;
  constructor(@Inject(ReturnRefundsService) private readonly refunds: ReturnRefundsService) {}
  onApplicationBootstrap(): void { this.schedule(); }
  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.refunds.recoverDue();
      void this.running.then(() => this.schedule(), () => this.schedule());
    }, RETURN_REFUND.recovery.pollMilliseconds);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> { this.stopped = true; clearTimeout(this.timer); await this.running?.catch(() => undefined); }
}

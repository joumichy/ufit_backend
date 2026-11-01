import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { OrderCancellationService } from "../application/order-cancellation.service";
import { CANCELLATION } from "../domain/order-lifecycle";

@Injectable()
export class OrderCancellationWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private running?: Promise<void>;
  constructor(
    @Inject(OrderCancellationService)
    private readonly cancellations: OrderCancellationService,
  ) {}
  onApplicationBootstrap(): void {
    this.schedule();
  }
  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.cancellations.recoverDue();
      // Neither provider nor database failures consume the durable recovery request.
      void this.running.then(
        () => this.schedule(),
        () => this.schedule(),
      );
    }, CANCELLATION.recovery.pollMilliseconds);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running?.catch(() => undefined);
  }
}

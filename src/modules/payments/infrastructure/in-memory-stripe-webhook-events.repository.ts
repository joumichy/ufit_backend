import { Injectable } from '@nestjs/common';
import type { StripeWebhookEventRecord, StripeWebhookEventRepository } from '../application/payments.service';

@Injectable()
export class InMemoryStripeWebhookEventRepository implements StripeWebhookEventRepository {
  private readonly events = new Map<string, StripeWebhookEventRecord>();

  async insertIfNew(event: StripeWebhookEventRecord): Promise<boolean> {
    if (this.events.has(event.stripeEventId)) {
      return false;
    }

    this.events.set(event.stripeEventId, structuredClone(event));
    return true;
  }
}

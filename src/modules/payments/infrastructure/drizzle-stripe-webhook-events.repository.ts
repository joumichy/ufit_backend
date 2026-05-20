import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import { stripeWebhookEvents } from '../../../shared/infrastructure/database/schema';
import type { StripeWebhookEventRecord, StripeWebhookEventRepository } from '../application/payments.service';

@Injectable()
export class DrizzleStripeWebhookEventRepository implements StripeWebhookEventRepository {
  constructor(private readonly database: DatabaseService) {}

  async insertIfNew(event: StripeWebhookEventRecord): Promise<boolean> {
    const rows = await this.database.db
      .insert(stripeWebhookEvents)
      .values({
        stripeEventId: event.stripeEventId,
        type: event.type,
        payload: event.payload,
        processedAt: event.processedAt
      })
      .onConflictDoNothing({ target: stripeWebhookEvents.stripeEventId })
      .returning({ id: stripeWebhookEvents.id });

    return rows.length > 0;
  }
}

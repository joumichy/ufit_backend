import { Module, forwardRef } from '@nestjs/common';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsService, STRIPE_WEBHOOK_EVENTS } from './application/payments.service';
import { DrizzleStripeWebhookEventRepository } from './infrastructure/drizzle-stripe-webhook-events.repository';
import { InMemoryStripeWebhookEventRepository } from './infrastructure/in-memory-stripe-webhook-events.repository';
import { stripeClientProvider } from './infrastructure/stripe-client.provider';
import { PaymentsWebhookController } from './presentation/payments-webhook.controller';

@Module({
  imports: [DatabaseModule, forwardRef(() => OrdersModule)],
  controllers: [PaymentsWebhookController],
  providers: [
    PaymentsService,
    stripeClientProvider,
    { provide: STRIPE_WEBHOOK_EVENTS, useExisting: DrizzleStripeWebhookEventRepository },
    DrizzleStripeWebhookEventRepository,
    InMemoryStripeWebhookEventRepository
  ],
  exports: [PaymentsService]
})
export class PaymentsModule {}

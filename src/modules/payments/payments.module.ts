import { Module, forwardRef } from "@nestjs/common";
import { DatabaseModule } from "../../shared/infrastructure/database/database.module";
import { OrdersModule } from "../orders/orders.module";
import { PaymentsService } from "./application/payments.service";
import { STRIPE_PAYMENT_FINALIZER } from "./application/stripe-payment-finalizer";
import { DrizzleStripePaymentFinalizer } from "./infrastructure/drizzle-stripe-payment-finalizer";
import { stripeClientProvider } from "./infrastructure/stripe-client.provider";
import { PaymentsWebhookController } from "./presentation/payments-webhook.controller";

@Module({
  imports: [DatabaseModule, forwardRef(() => OrdersModule)],
  controllers: [PaymentsWebhookController],
  providers: [
    PaymentsService,
    stripeClientProvider,
    {
      provide: STRIPE_PAYMENT_FINALIZER,
      useExisting: DrizzleStripePaymentFinalizer,
    },
    DrizzleStripePaymentFinalizer,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}

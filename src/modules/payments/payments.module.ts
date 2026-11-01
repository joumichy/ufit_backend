import { ConnectAccountsService } from "./application/connect-accounts.service";
import { ConnectAccountsController } from "./presentation/connect-accounts.controller";
import { DrizzleConnectAccountsRepository } from "./infrastructure/drizzle-connect-accounts.repository";
import { CONNECT } from "./domain/connect-account";
import { BrandsModule } from "../brands/brands.module";
import { CreatorsModule } from "../creators/creators.module";
import { IdentityModule } from "../identity/identity.module";
import { Module, forwardRef } from "@nestjs/common";
import { DatabaseModule } from "../../shared/infrastructure/database/database.module";
import { OrdersModule } from "../orders/orders.module";
import { PaymentsService } from "./application/payments.service";
import { STRIPE_PAYMENT_FINALIZER } from "./application/stripe-payment-finalizer";
import { DrizzleStripePaymentFinalizer } from "./infrastructure/drizzle-stripe-payment-finalizer";
import { stripeClientProvider } from "./infrastructure/stripe-client.provider";
import { PaymentsWebhookController } from "./presentation/payments-webhook.controller";

@Module({
  imports: [
    DatabaseModule,
    BrandsModule,
    CreatorsModule,
    IdentityModule,
    forwardRef(() => OrdersModule),
  ],
  controllers: [PaymentsWebhookController, ConnectAccountsController],
  providers: [
    PaymentsService,
    stripeClientProvider,
    ConnectAccountsService,
    DrizzleConnectAccountsRepository,
    {
      provide: CONNECT.repository,
      useExisting: DrizzleConnectAccountsRepository,
    },
    {
      provide: STRIPE_PAYMENT_FINALIZER,
      useExisting: DrizzleStripePaymentFinalizer,
    },
    DrizzleStripePaymentFinalizer,
  ],
  exports: [PaymentsService, ConnectAccountsService],
})
export class PaymentsModule {}

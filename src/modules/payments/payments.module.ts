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
import {PAYMENT_SETTLEMENT} from './domain/payment-settlement';
import {PaymentSettlementsService} from './application/payment-settlements.service';
import {DrizzlePaymentSettlementsRepository} from './infrastructure/drizzle-payment-settlements.repository';
import {PaymentSettlementsWorker} from './infrastructure/payment-settlements.worker';
import {PaymentSettlementsController} from './presentation/payment-settlements.controller';
import {PAYMENT_DISTRIBUTION} from './domain/payment-distribution';
import {PaymentDistributionService} from './application/payment-distribution.service';
import {DrizzlePaymentDistributionRepository} from './infrastructure/drizzle-payment-distribution.repository';
import {PaymentDistributionController} from './presentation/payment-distribution.controller';
import {PAYMENT_ALLOCATION} from './domain/payment-allocation';
import {PaymentAllocationsService} from './application/payment-allocations.service';
import {DrizzlePaymentAllocationsRepository} from './infrastructure/drizzle-payment-allocations.repository';
import {PaymentAllocationsController} from './presentation/payment-allocations.controller';

@Module({
  imports: [
    DatabaseModule,
    BrandsModule,
    CreatorsModule,
    IdentityModule,
    forwardRef(() => OrdersModule),
  ],
  controllers: [PaymentsWebhookController, ConnectAccountsController, PaymentSettlementsController, PaymentDistributionController, PaymentAllocationsController],
  providers: [
    PaymentsService,
    stripeClientProvider,
    PaymentSettlementsService, PaymentSettlementsWorker,
    PaymentDistributionService,
    PaymentAllocationsService,
    {provide: PAYMENT_ALLOCATION.repository, useClass: DrizzlePaymentAllocationsRepository},
    {provide: PAYMENT_DISTRIBUTION.repository, useClass: DrizzlePaymentDistributionRepository},
    {provide: PAYMENT_SETTLEMENT.repository, useClass: DrizzlePaymentSettlementsRepository},
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

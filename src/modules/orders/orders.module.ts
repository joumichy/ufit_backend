import {BrandOrdersController} from './presentation/brand-orders.controller';
import {BrandOrdersService} from './application/brand-orders.service';
import {DrizzleBrandOrdersRepository} from './infrastructure/drizzle-brand-orders.repository';
import {BRAND_ORDERS} from './domain/brand-order.contract';
import { Module, forwardRef } from "@nestjs/common";
import { CartModule } from "../cart/cart.module";
import { CommissionsModule } from "../commissions/commissions.module";
import { IdentityModule } from "../identity/identity.module";
import { PaymentsModule } from "../payments/payments.module";
import { OrderCheckoutService } from "./application/order-checkout.service";
import { OrdersService } from "./application/orders.service";
import {
  DrizzleOrderRepository,
  DrizzleProductSnapshotReader,
} from "./infrastructure/drizzle-orders.repository";
import { CANCELLATION } from "./domain/order-lifecycle";
import { OrderCancellationService } from "./application/order-cancellation.service";
import { DrizzleOrderCancellationRepository } from "./infrastructure/drizzle-order-cancellation.repository";
import { OrderCancellationWorker } from "./infrastructure/order-cancellation.worker";
import { OrdersController } from "./presentation/orders.controller";

@Module({
  imports: [
    IdentityModule,
    CartModule,
    CommissionsModule,
    forwardRef(() => PaymentsModule),
  ],
  controllers: [OrdersController, BrandOrdersController],
  providers: [
    OrdersService,
    BrandOrdersService,
    DrizzleBrandOrdersRepository,
    {provide: BRAND_ORDERS.repository, useExisting: DrizzleBrandOrdersRepository},
    OrderCheckoutService,
    OrderCancellationService,
    OrderCancellationWorker,
    DrizzleOrderCancellationRepository,
    {
      provide: CANCELLATION.repository,
      useExisting: DrizzleOrderCancellationRepository,
    },
    { provide: "OrderRepository", useExisting: DrizzleOrderRepository },
    {
      provide: "ProductSnapshotReader",
      useExisting: DrizzleProductSnapshotReader,
    },
    DrizzleOrderRepository,
    DrizzleProductSnapshotReader,
  ],
  exports: [OrdersService, OrderCancellationService, "OrderRepository"],
})
export class OrdersModule {}

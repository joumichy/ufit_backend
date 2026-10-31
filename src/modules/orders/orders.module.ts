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
import { OrdersController } from "./presentation/orders.controller";

@Module({
  imports: [
    IdentityModule,
    CartModule,
    CommissionsModule,
    forwardRef(() => PaymentsModule),
  ],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OrderCheckoutService,
    { provide: "OrderRepository", useExisting: DrizzleOrderRepository },
    {
      provide: "ProductSnapshotReader",
      useExisting: DrizzleProductSnapshotReader,
    },
    DrizzleOrderRepository,
    DrizzleProductSnapshotReader,
  ],
  exports: [OrdersService, "OrderRepository"],
})
export class OrdersModule {}

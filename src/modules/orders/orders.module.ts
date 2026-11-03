import {AdminRefundProofController,PrivateRefundProofController} from './presentation/refund-proof.controller';
import {RefundProofService} from './application/refund-proof.service';
import {DrizzleRefundProofRepository} from './infrastructure/drizzle-refund-proof.repository';
import {SupabaseRefundProofStorage} from './infrastructure/supabase-refund-proof.storage';
import {REFUND_PROOF} from './domain/refund-proof.contract';
import {AdminRefundOrganizationController, PrivateRefundOrganizationController} from './presentation/refund-organization.controller';
import {RefundOrganizationService} from './application/refund-organization.service';
import {DrizzleRefundOrganizationRepository} from './infrastructure/drizzle-refund-organization.repository';
import {REFUND_ORGANIZATION} from './domain/refund-organization';
import {RefundRecoveryController} from './presentation/refund-recovery.controller';
import {RefundRecoveryService} from './application/refund-recovery.service';
import {DrizzleRefundRecoveryRepository} from './infrastructure/drizzle-refund-recovery.repository';
import {REFUND_RECOVERY} from './domain/refund-recovery.contract';
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
import {CustomerReturnsController, BrandReturnsController, AdminReturnsController} from './presentation/order-returns.controller';
import {OrderReturnsService} from './application/order-returns.service';
import {ReturnRefundsService} from './application/return-refunds.service';
import {DrizzleOrderReturnRepository} from './infrastructure/drizzle-order-return.repository';
import {DrizzleReturnRefundRepository} from './infrastructure/drizzle-return-refund.repository';
import {ReturnRefundWorker} from './infrastructure/return-refund.worker';
import {ORDER_RETURN} from './domain/order-return.contract';
import {RETURN_REFUND} from './domain/return-refund';

@Module({
  imports: [
    IdentityModule,
    CartModule,
    CommissionsModule,
    forwardRef(() => PaymentsModule),
  ],
  controllers: [AdminRefundProofController,PrivateRefundProofController,AdminRefundOrganizationController, PrivateRefundOrganizationController, RefundRecoveryController, OrdersController, BrandOrdersController, CustomerReturnsController, BrandReturnsController, AdminReturnsController],
  providers: [
    RefundProofService,{provide:REFUND_PROOF.repository,useClass:DrizzleRefundProofRepository},{provide:REFUND_PROOF.storage,useFactory:()=>new SupabaseRefundProofStorage()},
    RefundOrganizationService, DrizzleRefundOrganizationRepository, {provide: REFUND_ORGANIZATION.repository, useExisting: DrizzleRefundOrganizationRepository},
    RefundRecoveryService, DrizzleRefundRecoveryRepository, {provide: REFUND_RECOVERY.repository, useExisting: DrizzleRefundRecoveryRepository},
    OrdersService,
    OrderReturnsService,
    ReturnRefundsService,
    ReturnRefundWorker,
    DrizzleOrderReturnRepository,
    DrizzleReturnRefundRepository,
    {provide: ORDER_RETURN.repository, useExisting: DrizzleOrderReturnRepository},
    {provide: RETURN_REFUND.repository, useExisting: DrizzleReturnRefundRepository},
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
  exports: [OrdersService, OrderCancellationService, ReturnRefundsService, "OrderRepository"],
})
export class OrdersModule {}

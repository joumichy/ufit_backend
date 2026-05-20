import { Module, forwardRef } from '@nestjs/common';
import { CartModule } from '../cart/cart.module';
import { CommissionsService } from '../commissions/application/commissions.service';
import { CommissionsModule } from '../commissions/commissions.module';
import { IdentityModule } from '../identity/identity.module';
import { PaymentsModule } from '../payments/payments.module';
import { ShippingService } from '../shipping/application/shipping.service';
import { ShippingModule } from '../shipping/shipping.module';
import { OrdersService } from './application/orders.service';
import {
  DrizzleOrderRepository,
  DrizzlePaymentRepository,
  DrizzleProductSnapshotReader,
  DrizzleStockRepository
} from './infrastructure/drizzle-orders.repository';
import { OrdersController } from './presentation/orders.controller';

@Module({
  imports: [IdentityModule, CartModule, ShippingModule, CommissionsModule, forwardRef(() => PaymentsModule)],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    { provide: 'OrderRepository', useExisting: DrizzleOrderRepository },
    { provide: 'ProductSnapshotReader', useExisting: DrizzleProductSnapshotReader },
    { provide: 'PaymentRepository', useExisting: DrizzlePaymentRepository },
    { provide: 'StockRepository', useExisting: DrizzleStockRepository },
    { provide: 'PaidOrderShipmentCreator', useExisting: ShippingService },
    { provide: 'PaidOrderCommissionCreator', useExisting: CommissionsService },
    DrizzleOrderRepository,
    DrizzlePaymentRepository,
    DrizzleStockRepository,
    DrizzleProductSnapshotReader
  ],
  exports: [OrdersService, 'OrderRepository']
})
export class OrdersModule {}

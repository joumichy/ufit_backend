import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { OrdersService } from './application/orders.service';
import { DisabledProductSnapshotReader, InMemoryOrderRepository } from './infrastructure/in-memory-orders.repository';
import { OrdersController } from './presentation/orders.controller';

@Module({
  imports: [IdentityModule],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    { provide: 'OrderRepository', useExisting: InMemoryOrderRepository },
    { provide: 'ProductSnapshotReader', useExisting: DisabledProductSnapshotReader },
    InMemoryOrderRepository,
    DisabledProductSnapshotReader
  ],
  exports: [OrdersService]
})
export class OrdersModule {}

import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { ShippingService } from './application/shipping.service';
import { InMemoryShipmentRepository } from './infrastructure/in-memory-shipping.repository';
import { ShippingController } from './presentation/shipping.controller';

@Module({
  imports: [IdentityModule],
  controllers: [ShippingController],
  providers: [
    ShippingService,
    { provide: 'ShipmentRepository', useExisting: InMemoryShipmentRepository },
    InMemoryShipmentRepository
  ],
  exports: [ShippingService]
})
export class ShippingModule {}

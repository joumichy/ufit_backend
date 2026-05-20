import { Module } from '@nestjs/common';
import { CartService } from './application/cart.service';
import { DisabledProductCatalogReader, InMemoryCartRepository } from './infrastructure/in-memory-cart.repository';
import { CartController } from './presentation/cart.controller';

@Module({
  controllers: [CartController],
  providers: [
    CartService,
    { provide: 'CartRepository', useExisting: InMemoryCartRepository },
    { provide: 'ProductCatalogReader', useExisting: DisabledProductCatalogReader },
    InMemoryCartRepository,
    DisabledProductCatalogReader
  ],
  exports: [CartService]
})
export class CartModule {}

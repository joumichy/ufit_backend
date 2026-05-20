import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { CartService } from './application/cart.service';
import { DisabledProductCatalogReader, InMemoryCartRepository } from './infrastructure/in-memory-cart.repository';
import { CartController } from './presentation/cart.controller';

@Module({
  imports: [IdentityModule],
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

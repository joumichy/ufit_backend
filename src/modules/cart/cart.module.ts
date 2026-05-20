import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module';
import { IdentityModule } from '../identity/identity.module';
import { CartService } from './application/cart.service';
import { DrizzleCartRepository } from './infrastructure/drizzle-cart.repository';
import { DrizzleProductCatalogReader } from './infrastructure/drizzle-product-catalog.reader';
import { CartController } from './presentation/cart.controller';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [CartController],
  providers: [
    CartService,
    { provide: 'CartRepository', useExisting: DrizzleCartRepository },
    { provide: 'ProductCatalogReader', useExisting: DrizzleProductCatalogReader },
    DrizzleCartRepository,
    DrizzleProductCatalogReader
  ],
  exports: [CartService]
})
export class CartModule {}

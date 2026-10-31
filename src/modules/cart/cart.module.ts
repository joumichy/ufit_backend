import { BrandsModule } from '../brands/brands.module';
import { CartQuoteService } from './application/cart-quote.service';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module';
import { OutfitsModule } from '../outfits/outfits.module';
import { IdentityModule } from '../identity/identity.module';
import { CartService } from './application/cart.service';
import { DrizzleCartRepository } from './infrastructure/drizzle-cart.repository';
import { DrizzleProductCatalogReader } from './infrastructure/drizzle-product-catalog.reader';
import { CartController } from './presentation/cart.controller';

@Module({
  imports: [DatabaseModule, IdentityModule, OutfitsModule, BrandsModule],
  controllers: [CartController],
  providers: [
    CartService,
    CartQuoteService,
    { provide: 'CartRepository', useExisting: DrizzleCartRepository },
    { provide: 'ProductCatalogReader', useExisting: DrizzleProductCatalogReader },
    DrizzleCartRepository,
    DrizzleProductCatalogReader
  ],
  exports: [CartService, CartQuoteService]
})
export class CartModule {}

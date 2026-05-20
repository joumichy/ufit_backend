import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { ProductsService } from './application/products.service';
import { PRODUCT_REPOSITORY } from './domain/product.types';
import { DrizzleProductRepository } from './infrastructure/drizzle-product.repository';
import { ProductsController } from './presentation/products.controller';

@Module({
  imports: [IdentityModule],
  controllers: [ProductsController],
  providers: [
    ProductsService,
    {
      provide: PRODUCT_REPOSITORY,
      useClass: DrizzleProductRepository
    }
  ],
  exports: [ProductsService, PRODUCT_REPOSITORY]
})
export class ProductsModule {}

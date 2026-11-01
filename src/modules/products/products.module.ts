import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';
import { IdentityModule } from '../identity/identity.module';
import { ProductsService } from './application/products.service';
import { PRODUCT_REPOSITORY } from './domain/product.types';
import { DrizzleProductRepository } from './infrastructure/drizzle-product.repository';
import { ProductsController } from './presentation/products.controller';
import { MediaModule } from '../media/media.module';

@Module({
  imports: [DatabaseModule, IdentityModule, AdminAuditModule, MediaModule],
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

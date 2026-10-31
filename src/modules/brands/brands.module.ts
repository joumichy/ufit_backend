import { BrandCommerceService } from './brand-commerce.service';
import { BrandCommerceController } from './brand-commerce.controller';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module';
import { IdentityModule } from '../identity/identity.module';
import { PublicBrandsController } from './public-brands.controller';
import { BrandsController } from './brands.controller';
import { BrandsService } from './brands.service';
import { BRANDS_REPOSITORY, BRANDS_SERVICE } from './brands.tokens';
import { DrizzleBrandsRepository } from './drizzle-brands.repository';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [BrandsController, PublicBrandsController, BrandCommerceController],
  providers: [
    BrandsService,
    BrandCommerceService,
    { provide: BRANDS_REPOSITORY, useClass: DrizzleBrandsRepository },
    { provide: BRANDS_SERVICE, useExisting: BrandsService }
  ],
  exports: [BRANDS_SERVICE, BrandCommerceService]
})
export class BrandsModule {}

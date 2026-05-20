import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module';
import { BrandsController } from './brands.controller';
import { BrandsService } from './brands.service';
import { BRANDS_REPOSITORY, BRANDS_SERVICE } from './brands.tokens';
import { DrizzleBrandsRepository } from './drizzle-brands.repository';

@Module({
  imports: [DatabaseModule],
  controllers: [BrandsController],
  providers: [
    BrandsService,
    { provide: BRANDS_REPOSITORY, useClass: DrizzleBrandsRepository },
    { provide: BRANDS_SERVICE, useExisting: BrandsService }
  ],
  exports: [BRANDS_SERVICE]
})
export class BrandsModule {}

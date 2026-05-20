import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module';
import { OutfitsService } from './application/outfits.service';
import { OUTFIT_REPOSITORY } from './domain/outfit.types';
import { DrizzleOutfitRepository } from './infrastructure/drizzle-outfit.repository';
import { OutfitsController } from './presentation/outfits.controller';

@Module({
  imports: [ProductsModule],
  controllers: [OutfitsController],
  providers: [
    OutfitsService,
    {
      provide: OUTFIT_REPOSITORY,
      useClass: DrizzleOutfitRepository
    }
  ],
  exports: [OutfitsService, OUTFIT_REPOSITORY]
})
export class OutfitsModule {}

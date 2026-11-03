import {OutfitPublicationsWorker} from './infrastructure/outfit-publications.worker';
import {MediaModule} from '../media/media.module';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module';
import { IdentityModule } from '../identity/identity.module';
import { ProductsModule } from '../products/products.module';
import { OutfitsService } from './application/outfits.service';
import { OUTFIT_REPOSITORY } from './domain/outfit.types';
import { DrizzleOutfitRepository } from './infrastructure/drizzle-outfit.repository';
import { OutfitsController } from './presentation/outfits.controller';

@Module({
  imports: [DatabaseModule, IdentityModule, ProductsModule, MediaModule],
  controllers: [OutfitsController],
  providers: [
    OutfitsService, OutfitPublicationsWorker,
    {
      provide: OUTFIT_REPOSITORY,
      useClass: DrizzleOutfitRepository
    }
  ],
  exports: [OutfitsService, OUTFIT_REPOSITORY]
})
export class OutfitsModule {}

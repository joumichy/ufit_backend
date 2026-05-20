import { Module } from '@nestjs/common';
import { OutfitsModule } from '../outfits/outfits.module';
import { ProductsModule } from '../products/products.module';
import { EditorialService } from './application/editorial.service';
import { EDITORIAL_REPOSITORY } from './domain/editorial.types';
import { DrizzleEditorialRepository } from './infrastructure/drizzle-editorial.repository';
import { EditorialController } from './presentation/editorial.controller';

@Module({
  imports: [ProductsModule, OutfitsModule],
  controllers: [EditorialController],
  providers: [
    EditorialService,
    {
      provide: EDITORIAL_REPOSITORY,
      useClass: DrizzleEditorialRepository
    }
  ],
  exports: [EditorialService, EDITORIAL_REPOSITORY]
})
export class EditorialModule {}

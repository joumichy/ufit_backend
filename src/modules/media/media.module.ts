import { Module, ServiceUnavailableException } from '@nestjs/common';
import { getEnv } from '../../config/env';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module';
import { IdentityModule } from '../identity/identity.module';
import { PRODUCT_MEDIA } from './domain/product-media.contract';
import { ProductMediaLocator } from './application/product-media-locator';
import { ProductMediaService } from './application/product-media.service';
import { DrizzleProductMediaRepository } from './infrastructure/drizzle-product-media.repository';
import { SupabaseProductMediaStorage } from './infrastructure/supabase-product-media.storage';
import { ProductMediaController } from './presentation/product-media.controller';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [ProductMediaController],
  providers: [ProductMediaService,
    {provide: PRODUCT_MEDIA.repository, useClass: DrizzleProductMediaRepository},
    {provide: PRODUCT_MEDIA.storage, useClass: SupabaseProductMediaStorage},
    {provide: PRODUCT_MEDIA.reader, useExisting: ProductMediaService},
    {provide: PRODUCT_MEDIA.locator, useFactory: () => new ProductMediaLocator(() => {
      const origin = getEnv().MEDIA_PUBLIC_API_ORIGIN;
      if (!origin) throw new ServiceUnavailableException(PRODUCT_MEDIA.failure.configuration);
      return origin;
    })},
  ],
  exports: [PRODUCT_MEDIA.reader],
})
export class MediaModule {}

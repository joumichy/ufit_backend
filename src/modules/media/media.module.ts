import {PROFILE_IMAGE} from './domain/profile-image.contract';
import {ProfileImageService} from './application/profile-image.service';
import {DrizzleProfileMediaRepository} from './infrastructure/drizzle-profile-media.repository';
import {ProfileImageController} from './presentation/profile-image.controller';
import {OUTFIT_MEDIA} from './domain/outfit-media.contract';
import {OutfitMediaService} from './application/outfit-media.service';
import {DrizzleOutfitMediaRepository} from './infrastructure/drizzle-outfit-media.repository';
import {OutfitMediaController} from './presentation/outfit-media.controller';
import { Module, ServiceUnavailableException } from '@nestjs/common';
import { getEnv } from '../../config/env';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module';
import { IdentityModule } from '../identity/identity.module';
import { PRODUCT_MEDIA } from './domain/product-media.contract';
import { MediaAssetLocator } from './application/media-asset-locator';
import { ProductMediaService } from './application/product-media.service';
import { DrizzleProductMediaRepository } from './infrastructure/drizzle-product-media.repository';
import { SupabaseImageStorage } from './infrastructure/supabase-image.storage';
import { ProductMediaController } from './presentation/product-media.controller';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [ProductMediaController, OutfitMediaController,ProfileImageController],
  providers: [ProductMediaService, OutfitMediaService,ProfileImageService,DrizzleProfileMediaRepository,
    {provide:PROFILE_IMAGE.token.storage,useFactory:()=>new SupabaseImageStorage(PROFILE_IMAGE)},
    {provide:PROFILE_IMAGE.token.locator,useFactory:()=>new MediaAssetLocator(()=>{
      const origin=getEnv().MEDIA_PUBLIC_API_ORIGIN;
      if(!origin)throw new ServiceUnavailableException(PROFILE_IMAGE.failure.configuration);
      return origin;
    },PROFILE_IMAGE)},
    {provide: OUTFIT_MEDIA.repository, useClass: DrizzleOutfitMediaRepository},
    {provide: OUTFIT_MEDIA.storage, useFactory: () => new SupabaseImageStorage(OUTFIT_MEDIA)},
    {provide: OUTFIT_MEDIA.reader, useExisting: OutfitMediaService},
    {provide: OUTFIT_MEDIA.locator, useFactory: () => new MediaAssetLocator(() => {
      const origin = getEnv().MEDIA_PUBLIC_API_ORIGIN;
      if (!origin) throw new ServiceUnavailableException(OUTFIT_MEDIA.failure.configuration);
      return origin;
    }, OUTFIT_MEDIA)},
    {provide: PRODUCT_MEDIA.repository, useClass: DrizzleProductMediaRepository},
    {provide: PRODUCT_MEDIA.storage, useFactory: () => new SupabaseImageStorage(PRODUCT_MEDIA)},
    {provide: PRODUCT_MEDIA.reader, useExisting: ProductMediaService},
    {provide: PRODUCT_MEDIA.locator, useFactory: () => new MediaAssetLocator(() => {
      const origin = getEnv().MEDIA_PUBLIC_API_ORIGIN;
      if (!origin) throw new ServiceUnavailableException(PRODUCT_MEDIA.failure.configuration);
      return origin;
    }, PRODUCT_MEDIA)},
  ],
  exports: [PRODUCT_MEDIA.reader, OUTFIT_MEDIA.reader],
})
export class MediaModule {}

import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { SavedService } from './application/saved.service';
import { DrizzleSavedRepository } from './infrastructure/drizzle-saved.repository';
import { InMemorySavedRepository } from './infrastructure/in-memory-saved.repository';
import { SavedController } from './presentation/saved.controller';
import {SAVED_OUTFITS} from './domain/saved-outfits.contract';

@Module({
  imports: [IdentityModule],
  controllers: [SavedController],
  providers: [
    SavedService,
    { provide: SAVED_OUTFITS.repository, useExisting: DrizzleSavedRepository },
    DrizzleSavedRepository,
    InMemorySavedRepository
  ],
  exports: [SavedService]
})
export class SavedModule {}

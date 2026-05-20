import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { SavedService } from './application/saved.service';
import { DrizzleSavedRepository } from './infrastructure/drizzle-saved.repository';
import { InMemorySavedRepository } from './infrastructure/in-memory-saved.repository';
import { SavedController } from './presentation/saved.controller';

@Module({
  imports: [IdentityModule],
  controllers: [SavedController],
  providers: [
    SavedService,
    { provide: 'SavedRepository', useExisting: DrizzleSavedRepository },
    DrizzleSavedRepository,
    InMemorySavedRepository
  ],
  exports: [SavedService]
})
export class SavedModule {}

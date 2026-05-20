import { Module } from '@nestjs/common';
import { SavedService } from './application/saved.service';
import { InMemorySavedRepository } from './infrastructure/in-memory-saved.repository';
import { SavedController } from './presentation/saved.controller';

@Module({
  controllers: [SavedController],
  providers: [SavedService, { provide: 'SavedRepository', useExisting: InMemorySavedRepository }, InMemorySavedRepository],
  exports: [SavedService]
})
export class SavedModule {}

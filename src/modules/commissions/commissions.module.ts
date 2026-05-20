import { Module } from '@nestjs/common';
import { CommissionsService } from './application/commissions.service';
import { InMemoryCommissionRepository } from './infrastructure/in-memory-commissions.repository';
import { CommissionsController } from './presentation/commissions.controller';

@Module({
  controllers: [CommissionsController],
  providers: [
    CommissionsService,
    { provide: 'CommissionRepository', useExisting: InMemoryCommissionRepository },
    InMemoryCommissionRepository
  ],
  exports: [CommissionsService]
})
export class CommissionsModule {}

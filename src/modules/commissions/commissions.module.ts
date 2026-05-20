import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module';
import { IdentityModule } from '../identity/identity.module';
import { CommissionsService } from './application/commissions.service';
import { DrizzleCommissionRepository, DrizzleCommissionRuleResolver } from './infrastructure/drizzle-commissions.repository';
import { InMemoryCommissionRepository } from './infrastructure/in-memory-commissions.repository';
import { CommissionsController } from './presentation/commissions.controller';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [CommissionsController],
  providers: [
    CommissionsService,
    { provide: 'CommissionRepository', useExisting: DrizzleCommissionRepository },
    { provide: 'CommissionRuleResolver', useExisting: DrizzleCommissionRuleResolver },
    DrizzleCommissionRepository,
    DrizzleCommissionRuleResolver,
    InMemoryCommissionRepository
  ],
  exports: [CommissionsService, 'CommissionRuleResolver']
})
export class CommissionsModule {}

import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module';
import { IdentityModule } from '../identity/identity.module';
import { CommissionsService } from './application/commissions.service';
import { DrizzleCommissionRepository } from './infrastructure/drizzle-commissions.repository';
import { DrizzleCommissionRulesRepository, DrizzleCommissionRuleResolver } from './infrastructure/drizzle-commission-rules.repository';
import {CommissionRulesController} from './presentation/commission-rules.controller';
import {CommissionRulesService} from './application/commission-rules.service';
import {COMMISSION_RULE} from './domain/commission-rule.contract';
import { InMemoryCommissionRepository } from './infrastructure/in-memory-commissions.repository';
import { CommissionsController } from './presentation/commissions.controller';
import {CommissionLedgerController,CreatorCommissionLedgerController} from './presentation/commission-ledger.controller';
import {CommissionLedgerService} from './application/commission-ledger.service';
import {DrizzleCommissionLedgerRepository} from './infrastructure/drizzle-commission-ledger.repository';
import {COMMISSION_LEDGER} from './domain/commission-ledger.contract';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [CommissionsController, CommissionRulesController,CommissionLedgerController,CreatorCommissionLedgerController],
  providers: [
    CommissionsService,
    CommissionLedgerService,DrizzleCommissionLedgerRepository,
    {provide:COMMISSION_LEDGER.repository,useExisting:DrizzleCommissionLedgerRepository},
    CommissionRulesService,
    DrizzleCommissionRulesRepository,
    {provide: COMMISSION_RULE.token.repository, useExisting: DrizzleCommissionRulesRepository},
    { provide: COMMISSION_RULE.token.commissions, useExisting: DrizzleCommissionRepository },
    { provide: COMMISSION_RULE.token.resolver, useExisting: DrizzleCommissionRuleResolver },
    DrizzleCommissionRepository,
    DrizzleCommissionRuleResolver,
    InMemoryCommissionRepository
  ],
  exports: [CommissionsService, COMMISSION_RULE.token.resolver]
})
export class CommissionsModule {}

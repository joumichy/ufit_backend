import {Controller,Get,Header,Inject,Param,Query,UseGuards} from '@nestjs/common';
import {CurrentUser} from '../../../shared/presentation/decorators/current-user.decorator';
import {AuthGuard} from '../../../shared/presentation/guards/auth.guard';
import {AdminGuard} from '../../../shared/presentation/guards/admin.guard';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {COMMISSION_LEDGER as LEDGER} from '../domain/commission-ledger.contract';
import {CommissionLedgerService} from '../application/commission-ledger.service';
@Controller(LEDGER.route.root)
@UseGuards(AuthGuard,AdminGuard)
export class CommissionLedgerController{
  constructor(@Inject(CommissionLedgerService)private readonly ledger:CommissionLedgerService){}
  @Get()@Header(LEDGER.cache.header,LEDGER.cache.value)list(@CurrentUser()actor:AuthenticatedUser,@Query()query:unknown){return this.ledger.list(actor.id,query);}
  @Get(LEDGER.route.id)@Header(LEDGER.cache.header,LEDGER.cache.value)detail(@CurrentUser()actor:AuthenticatedUser,@Param(LEDGER.route.idParameter)id:string){return this.ledger.detail(actor.id,id);}
  @Get(LEDGER.route.returns)@Header(LEDGER.cache.header,LEDGER.cache.value)returns(@CurrentUser()actor:AuthenticatedUser,@Param(LEDGER.route.idParameter)id:string,@Query()query:unknown){return this.ledger.relatedReturns(actor.id,id,query);}
}
@Controller(LEDGER.route.creator)
@UseGuards(AuthGuard)
export class CreatorCommissionLedgerController{
  constructor(@Inject(CommissionLedgerService)private readonly ledger:CommissionLedgerService){}
  @Get()@Header(LEDGER.cache.header,LEDGER.cache.value)list(@CurrentUser()actor:AuthenticatedUser,@Query()query:unknown){return this.ledger.listCreator(actor.id,query);}
}

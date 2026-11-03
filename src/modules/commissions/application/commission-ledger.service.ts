import {BadRequestException,ForbiddenException,Inject,Injectable,NotFoundException} from '@nestjs/common';
import {z} from 'zod';
import {COMMISSION_RULE} from '../domain/commission-rule.contract';
import {COMMISSION_LEDGER as LEDGER,commissionLedgerQuerySchema,commissionRelatedQuerySchema,commissionLedgerIdSchema} from '../domain/commission-ledger.contract';
import type {CommissionLedgerRepository} from '../domain/commission-ledger.repository';
import {COMMISSION_RELEASE} from '../domain/commission-release';
@Injectable()
export class CommissionLedgerService{
  constructor(@Inject(LEDGER.repository)private readonly repository:CommissionLedgerRepository){}
  list(actorId:string,input:unknown){const query=parse(commissionLedgerQuerySchema,input);return this.read(actorId,repository=>repository.page({kind:COMMISSION_RELEASE.scope.administration},query));}
  listCreator(actorId:string,input:unknown){const query=parse(commissionLedgerQuerySchema,input);return this.repository.snapshot(async repository=>{
    const access=await repository.access(actorId);
    if(!access||access.status!==COMMISSION_RULE.status.activeUser||!access.roles.includes(LEDGER.creatorRole))throw new ForbiddenException(LEDGER.failure.access);
    const creatorId=await repository.creatorIdForUser(actorId);if(creatorId===undefined)throw new ForbiddenException(LEDGER.failure.access);
    return repository.page({kind:COMMISSION_RELEASE.scope.creator,creatorId},query);
  });}
  detail(actorId:string,input:unknown){const id=parse(commissionLedgerIdSchema,input);return this.read(actorId,async repository=>{
    const detail=await repository.detail(id);if(!detail)throw new NotFoundException(LEDGER.failure.missing);return detail;
  });}
  relatedReturns(actorId:string,input:unknown,raw:unknown){const id=parse(commissionLedgerIdSchema,input),query=parse(commissionRelatedQuerySchema,raw);return this.read(actorId,async repository=>{
    if(!await repository.detail(id))throw new NotFoundException(LEDGER.failure.missing);return repository.relatedReturns(id,query);
  });}
  private read<T>(actorId:string,operation:(repository:CommissionLedgerRepository)=>Promise<T>){
    return this.repository.snapshot(async repository=>{const access=await repository.access(actorId);
      if(!access||access.status!==COMMISSION_RULE.status.activeUser||!COMMISSION_RULE.roles.some(role=>access.roles.includes(role)))throw new ForbiddenException(LEDGER.failure.access);
      return operation(repository);
    });
  }
}
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(!result.success)throw new BadRequestException(LEDGER.failure.input);return result.data;}

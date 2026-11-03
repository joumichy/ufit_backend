import {BadRequestException,ForbiddenException,Inject,Injectable,NotFoundException,ServiceUnavailableException} from '@nestjs/common';
import {PaymentDisbursementsService} from './payment-disbursements.service';
import {STRIPE_COMMERCE} from './stripe-commerce';
import {isUserAdministrator} from '../../identity/domain/user-administration.policy';
import {paymentSettlementIDSchema} from '../domain/payment-settlement';
import {DISBURSEMENT_EXECUTION} from '../domain/payment-disbursement.repository';
import {DISBURSEMENT_ADMINISTRATION as C,disbursementResumeSchema,type DisbursementAdministrationRepository} from '../domain/payment-disbursement-administration';

@Injectable()
export class DisbursementAdministrationService {
  constructor(@Inject(DISBURSEMENT_EXECUTION.repository) private readonly repository:DisbursementAdministrationRepository,
    @Inject(PaymentDisbursementsService) private readonly execution:Pick<PaymentDisbursementsService,'canExecute'>) {}
  document(actorId:string,id:string){return this.authorized(actorId,id,false);}
  resume(actorId:string,id:string,raw:unknown){
    if(!disbursementResumeSchema.safeParse(raw).success)throw new BadRequestException(C.failure.invalid);
    return this.authorized(actorId,id,true);
  }
  private authorized(actorId:string,id:string,write:boolean){
    const parsed=paymentSettlementIDSchema.safeParse(id);
    if(!parsed.success)throw new BadRequestException(C.failure.invalid);
    return this.repository.administration(write,async session=>{
      if(write)await session.lockOrder(parsed.data);
      if(!isUserAdministrator(await session.access(actorId,write)))throw new ForbiddenException(C.failure.access);
      const document=await session.document(parsed.data);
      if(!document)throw new NotFoundException(C.failure.missing);
      if(!write)return document;
      if(!this.execution.canExecute)throw new ServiceUnavailableException(STRIPE_COMMERCE.configuration.paymentsUnavailable);
      await session.resume(parsed.data);
      return session.document(parsed.data);
    });
  }
}

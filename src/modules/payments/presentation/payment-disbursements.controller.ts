import {Body,Controller,Get,Header,HttpCode,Inject,Param,Post,UseGuards} from '@nestjs/common';
import {AuthGuard} from '../../../shared/presentation/guards/auth.guard';
import {AdminGuard} from '../../../shared/presentation/guards/admin.guard';
import {CurrentUser} from '../../../shared/presentation/decorators/current-user.decorator';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {DISBURSEMENT_ADMINISTRATION as C} from '../domain/payment-disbursement-administration';
import {DisbursementAdministrationService} from '../application/disbursement-administration.service';

@Controller(C.route.root)
@UseGuards(AuthGuard,AdminGuard)
export class PaymentDisbursementsController {
  constructor(@Inject(DisbursementAdministrationService) private readonly disbursements:DisbursementAdministrationService) {}
  @Get(C.route.document)
  @Header(C.cache.header,C.cache.value)
  document(@CurrentUser() actor:AuthenticatedUser,@Param(C.route.id) id:string){return this.disbursements.document(actor.id,id);}
  @Post(C.route.resume)
  @HttpCode(C.accepted)
  @Header(C.cache.header,C.cache.value)
  resume(@CurrentUser() actor:AuthenticatedUser,@Param(C.route.id) id:string,@Body() body:unknown){return this.disbursements.resume(actor.id,id,body);}
}

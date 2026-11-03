import {Body, Controller, Get, Header, Inject, Param, Put, Query, UseGuards} from '@nestjs/common';
import {AuthGuard} from '../../../shared/presentation/guards/auth.guard';
import {AdminGuard} from '../../../shared/presentation/guards/admin.guard';
import {CurrentUser} from '../../../shared/presentation/decorators/current-user.decorator';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {PAYMENT_DISTRIBUTION as C} from '../domain/payment-distribution';
import {PaymentDistributionService} from '../application/payment-distribution.service';

@Controller(C.route.root)
@UseGuards(AuthGuard, AdminGuard)
export class PaymentDistributionController {
  constructor(@Inject(PaymentDistributionService) private readonly distribution: PaymentDistributionService) {}
  @Get(C.route.brands) @Header(C.cache.header, C.cache.value)
  brands(@CurrentUser() actor: AuthenticatedUser, @Query() raw: unknown) { return this.distribution.brands(actor.id, raw); }
  @Get(C.route.brand) @Header(C.cache.header, C.cache.value)
  document(@CurrentUser() actor: AuthenticatedUser, @Param(C.route.brandId) id: string) { return this.distribution.document(actor.id, id); }
  @Put(C.route.brand) @Header(C.cache.header, C.cache.value)
  revise(@CurrentUser() actor: AuthenticatedUser, @Param(C.route.brandId) id: string, @Body() raw: unknown) { return this.distribution.revise(actor.id, id, raw); }
  @Get(C.route.history) @Header(C.cache.header, C.cache.value)
  history(@CurrentUser() actor: AuthenticatedUser, @Param(C.route.brandId) id: string, @Query() raw: unknown) { return this.distribution.history(actor.id, id, raw); }
  @Get(C.route.change) @Header(C.cache.header, C.cache.value)
  change(@CurrentUser() actor: AuthenticatedUser, @Param(C.route.brandId) id: string, @Param(C.route.requestId) requestId: string) {
    return this.distribution.change(actor.id, id, requestId);
  }
}

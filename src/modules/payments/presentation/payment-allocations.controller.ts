import {Body, Controller, Get, Header, HttpCode, Inject, Param, Post, UseGuards} from '@nestjs/common';
import {AuthGuard} from '../../../shared/presentation/guards/auth.guard';
import {AdminGuard} from '../../../shared/presentation/guards/admin.guard';
import {CurrentUser} from '../../../shared/presentation/decorators/current-user.decorator';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {PAYMENT_ALLOCATION as C} from '../domain/payment-allocation';
import {PaymentAllocationsService} from '../application/payment-allocations.service';

@Controller(C.route.root)
@UseGuards(AuthGuard, AdminGuard)
export class PaymentAllocationsController {
  constructor(@Inject(PaymentAllocationsService) private readonly allocations: PaymentAllocationsService) {}
  @Get(C.route.document) @Header(C.cache.header, C.cache.value)
  document(@CurrentUser() actor: AuthenticatedUser, @Param(C.route.id) id: string) { return this.allocations.document(actor.id, id); }
  @Post(C.route.prepare) @HttpCode(C.success) @Header(C.cache.header, C.cache.value)
  prepare(@CurrentUser() actor: AuthenticatedUser, @Param(C.route.id) id: string, @Body() raw: unknown) { return this.allocations.prepare(actor.id, id, raw); }
}

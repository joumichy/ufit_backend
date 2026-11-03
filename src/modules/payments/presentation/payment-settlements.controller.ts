import {Body, Controller, Get, Header, HttpCode, Inject, Param, Post, UseGuards} from '@nestjs/common';
import {AuthGuard} from '../../../shared/presentation/guards/auth.guard';
import {AdminGuard} from '../../../shared/presentation/guards/admin.guard';
import {CurrentUser} from '../../../shared/presentation/decorators/current-user.decorator';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {PAYMENT_SETTLEMENT as C} from '../domain/payment-settlement';
import {PaymentSettlementsService} from '../application/payment-settlements.service';

@Controller(C.route.root)
@UseGuards(AuthGuard, AdminGuard)
export class PaymentSettlementsController {
  constructor(@Inject(PaymentSettlementsService) private readonly settlements: PaymentSettlementsService) {}
  @Get(C.route.document) @Header(C.cache.header, C.cache.value)
  document(@CurrentUser() actor: AuthenticatedUser, @Param(C.route.id) id: string) { return this.settlements.document(actor.id, id); }
  @Post(C.route.synchronize) @HttpCode(C.accepted) @Header(C.cache.header, C.cache.value)
  synchronize(@CurrentUser() actor: AuthenticatedUser, @Param(C.route.id) id: string, @Body() raw: unknown) {
    return this.settlements.synchronize(actor.id, id, raw);
  }
}

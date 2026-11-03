import {Body, Controller, Get, Header, HttpCode, Inject, Param, Post, UseGuards} from '@nestjs/common';
import {AuthGuard} from '../../../shared/presentation/guards/auth.guard';
import {AdminGuard} from '../../../shared/presentation/guards/admin.guard';
import {CurrentUser} from '../../../shared/presentation/decorators/current-user.decorator';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {REFUND_SETTLEMENT as C} from '../domain/refund-settlement';
import {RefundSettlementsService} from '../application/refund-settlements.service';

@Controller(C.route.root)
@UseGuards(AuthGuard, AdminGuard)
export class RefundSettlementsController {
  constructor(@Inject(RefundSettlementsService) private readonly settlements: RefundSettlementsService) {}
  @Get(C.route.document)
  @Header(C.cache.header, C.cache.value)
  document(@CurrentUser() actor: AuthenticatedUser, @Param(C.route.id) id: string) { return this.settlements.document(actor.id, id); }
  @Post(C.route.synchronize)
  @HttpCode(C.accepted)
  @Header(C.cache.header, C.cache.value)
  synchronize(@CurrentUser() actor: AuthenticatedUser, @Param(C.route.id) id: string, @Body() body: unknown) { return this.settlements.synchronize(actor.id, id, body); }
}

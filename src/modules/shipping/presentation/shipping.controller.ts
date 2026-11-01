import {Body, Controller, Inject, Param, ParseUUIDPipe, Post, UseGuards} from '@nestjs/common';
import {Roles} from '../../../shared/presentation/decorators/roles.decorator';
import {CurrentUser} from '../../../shared/presentation/decorators/current-user.decorator';
import {AuthGuard} from '../../../shared/presentation/guards/auth.guard';
import {RoleGuard} from '../../../shared/presentation/guards/role.guard';
import type {AuthenticatedUser} from '../../identity/domain/user.types';
import {ShippingService} from '../application/shipping.service';
import {SHIPPING} from '../domain/shipping.contract';

@Controller(SHIPPING.route.root)
@UseGuards(AuthGuard, RoleGuard)
export class ShippingController {
  constructor(@Inject(ShippingService) private readonly shipping: ShippingService) {}
  @Post(SHIPPING.route.action)
  @Roles(...SHIPPING.roles)
  updateStatus(@CurrentUser() actor: AuthenticatedUser, @Param(SHIPPING.route.id, ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.shipping.updateForActor(actor, id, body);
  }
}

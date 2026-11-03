import {Controller, Get, Inject, Param, Query, UseGuards} from '@nestjs/common';
import {AuthGuard} from '../../../shared/presentation/guards/auth.guard';
import {RoleGuard} from '../../../shared/presentation/guards/role.guard';
import {Roles} from '../../../shared/presentation/decorators/roles.decorator';
import {REFUND_RECOVERY} from '../domain/refund-recovery.contract';
import {RefundRecoveryService} from '../application/refund-recovery.service';

@Controller(REFUND_RECOVERY.route.root)
@UseGuards(AuthGuard, RoleGuard)
@Roles(...REFUND_RECOVERY.roles)
export class RefundRecoveryController {
  constructor(@Inject(RefundRecoveryService) private readonly recovery: RefundRecoveryService) {}
  @Get()
  list(@Query() query: unknown) {return this.recovery.list(query);}
  @Get(REFUND_RECOVERY.route.detail)
  detail(@Param(REFUND_RECOVERY.route.kind) kind: string, @Param(REFUND_RECOVERY.route.id) id: string) {return this.recovery.detail(kind, id);}
}

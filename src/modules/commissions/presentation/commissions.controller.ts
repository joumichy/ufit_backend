import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../../../shared/presentation/decorators/roles.decorator';
import { AuthGuard } from '../../../shared/presentation/guards/auth.guard';
import { RoleGuard } from '../../../shared/presentation/guards/role.guard';
import {COMMISSION_RULE} from '../domain/commission-rule.contract';
import { CommissionsService } from '../application/commissions.service';

@Controller(COMMISSION_RULE.route.root)
@UseGuards(AuthGuard, RoleGuard)
export class CommissionsController {
  constructor(@Inject(CommissionsService) private readonly commissionsService: CommissionsService) {}

  @Post(COMMISSION_RULE.route.quote)
  @Roles(...COMMISSION_RULE.quoteRoles)
  quoteRate(@Body() body: unknown) {
    return { rateBps: this.commissionsService.calculateRateBps(body) };
  }
}

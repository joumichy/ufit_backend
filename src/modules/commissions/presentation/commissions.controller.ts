import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../../../shared/presentation/decorators/roles.decorator';
import { AuthGuard } from '../../../shared/presentation/guards/auth.guard';
import { RoleGuard } from '../../../shared/presentation/guards/role.guard';
import { CommissionsService, type CommissionRuleInput } from '../application/commissions.service';

@Controller('commissions')
@UseGuards(AuthGuard, RoleGuard)
export class CommissionsController {
  constructor(@Inject(CommissionsService) private readonly commissionsService: CommissionsService) {}

  @Post('quote-rate')
  @Roles('brand_owner', 'brand_manager', 'admin', 'super_admin')
  quoteRate(@Body() body: CommissionRuleInput) {
    return { commissionRate: this.commissionsService.calculateRate(body) };
  }
}

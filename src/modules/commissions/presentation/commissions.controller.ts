import { Body, Controller, Post } from '@nestjs/common';
import { CommissionsService, type CommissionRuleInput } from '../application/commissions.service';

@Controller('commissions')
export class CommissionsController {
  constructor(private readonly commissionsService: CommissionsService) {}

  @Post('quote-rate')
  quoteRate(@Body() body: CommissionRuleInput) {
    return { commissionRate: this.commissionsService.calculateRate(body) };
  }
}

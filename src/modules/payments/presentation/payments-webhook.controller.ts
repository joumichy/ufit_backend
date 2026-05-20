import { Controller, Headers, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { PaymentsService } from '../application/payments.service';

@Controller('payments/webhook')
export class PaymentsWebhookController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('stripe')
  handleStripeWebhook(@Req() request: Request, @Headers('stripe-signature') signature?: string) {
    return this.paymentsService.handleStripeWebhook(request.body as Buffer | string | Record<string, unknown>, signature);
  }
}

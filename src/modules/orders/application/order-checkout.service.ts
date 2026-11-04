import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { CartQuoteService, type CartQuote } from "../../cart/application/cart-quote.service";
import { PaymentsService } from "../../payments/application/payments.service";
import { OrdersService } from "./orders.service";
import {CHECKOUT_REQUEST as C, checkoutRequestSchema, checkoutOutcomeSchema, checkoutReviewRequestSchema} from '../domain/checkout-request';
import {CONNECT} from '../../payments/domain/connect-account';
import {COMMISSION_RULE} from '../../commissions/domain/commission-rule.contract';
import {PAYMENT_DISTRIBUTION} from '../../payments/domain/payment-distribution';
import {z} from 'zod';
const unavailableFailureSchema = z.object({code: z.enum([CONNECT.failure.sale.code, COMMISSION_RULE.failureCode.unavailable,
  COMMISSION_RULE.failureCode.creator, PAYMENT_DISTRIBUTION.failure.unavailable.code, PAYMENT_DISTRIBUTION.failure.budget.code])});
export interface CheckoutReview {quote: CartQuote; available: boolean;}
@Injectable()
export class OrderCheckoutService {
  constructor(
    @Inject(CartQuoteService) private readonly quotes: CartQuoteService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
  ) {}

  async review(customerId: string, raw: unknown): Promise<CheckoutReview> {
    const parsed = checkoutReviewRequestSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(C.failure.input);
    const {cart, quote} = await this.quotes.prepare(customerId, parsed.data.country);
    try {
      const sale = await this.orders.prepareCartSale(cart);
      await this.payments.assertNewSale(quote.brandId, quote.subtotalAmount, sale.creatorCommissionAmount,
        sale.items.flatMap(item => item.sourceCreatorId ? [item.sourceCreatorId] : []));
      return {quote, available: true};
    } catch (error) {
      if (error instanceof ConflictException && unavailableFailureSchema.safeParse(error.getResponse()).success) return {quote, available: false};
      throw error;
    }
  }

  async outcome(customerId: string, requestId: string) {
    const key = checkoutRequestSchema.shape.requestId.safeParse(requestId);
    if (!key.success) throw new BadRequestException(C.failure.input);
    const order = await this.orders.findCheckoutRequest(customerId, key.data);
    const parsed = checkoutOutcomeSchema.safeParse({requestId: key.data, orderId: order?.id ?? null});
    if (!parsed.success || order !== undefined && order.checkoutRequestId !== key.data)
      throw new ServiceUnavailableException(C.failure.outcome);
    return parsed.data;
  }

  async checkout(customerId: string, raw: unknown) {
    const parsed = checkoutRequestSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(C.failure.input);
    const input = parsed.data;
    const fingerprint = createHash(C.fingerprint.algorithm)
      .update(
        JSON.stringify({
          quote: input.quoteFingerprint,
          address: input.shippingAddress,
        }),
      )
      .digest(C.fingerprint.encoding);
    let order = await this.orders.findCheckoutRequest(
      customerId,
      input.requestId,
    );
    if (order && order.checkoutFingerprint !== fingerprint)
      throw new ConflictException(C.failure.reused);
    if (!order) {
      const { cart, quote } = await this.quotes.prepare(
        customerId,
        input.shippingAddress.country,
      );
      if (quote.fingerprint !== input.quoteFingerprint)
        throw new ConflictException(C.failure.changed);
      order = await this.orders.createPendingFromCart(
        cart,
        input.shippingAddress,
        { quote, requestId: input.requestId, fingerprint },
      );
    }
    return this.payments.createPaymentIntent(order);
  }
}

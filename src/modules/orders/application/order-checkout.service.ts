import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { CartQuoteService } from "../../cart/application/cart-quote.service";
import { PaymentsService } from "../../payments/application/payments.service";
import { OrdersService } from "./orders.service";
import {CHECKOUT_REQUEST as C, checkoutRequestSchema, checkoutOutcomeSchema} from '../domain/checkout-request';
@Injectable()
export class OrderCheckoutService {
  constructor(
    @Inject(CartQuoteService) private readonly quotes: CartQuoteService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
  ) {}

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

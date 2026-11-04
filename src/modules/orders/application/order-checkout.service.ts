import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CartQuoteService } from "../../cart/application/cart-quote.service";
import {shippingAddressSchema} from "../domain/shipping-address";
import { PaymentsService } from "../../payments/application/payments.service";
import { OrdersService } from "./orders.service";

export const checkoutRequestSchema = z
  .object({
    requestId: z.uuid(),
    quoteFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    shippingAddress: shippingAddressSchema,
  })
  .strict();
const CHECKOUT_FAILURE = {
  input: {
    code: "checkout_input_invalid",
    message: "Invalid checkout request",
  },
  changed: {
    code: "checkout_quote_changed",
    message: "Review the updated order total before payment",
  },
  reused: {
    code: "checkout_request_conflict",
    message: "Checkout request was already used for another purchase",
  },
} as const;
@Injectable()
export class OrderCheckoutService {
  constructor(
    @Inject(CartQuoteService) private readonly quotes: CartQuoteService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
  ) {}

  async checkout(customerId: string, raw: unknown) {
    const parsed = checkoutRequestSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(CHECKOUT_FAILURE.input);
    const input = parsed.data;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          quote: input.quoteFingerprint,
          address: input.shippingAddress,
        }),
      )
      .digest("hex");
    let order = await this.orders.findCheckoutRequest(
      customerId,
      input.requestId,
    );
    if (order && order.checkoutFingerprint !== fingerprint)
      throw new ConflictException(CHECKOUT_FAILURE.reused);
    if (!order) {
      const { cart, quote } = await this.quotes.prepare(
        customerId,
        input.shippingAddress.country,
      );
      if (quote.fingerprint !== input.quoteFingerprint)
        throw new ConflictException(CHECKOUT_FAILURE.changed);
      order = await this.orders.createPendingFromCart(
        cart,
        input.shippingAddress,
        { quote, requestId: input.requestId, fingerprint },
      );
    }
    return this.payments.createPaymentIntent(order);
  }
}

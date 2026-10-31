import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  forwardRef,
} from "@nestjs/common";
import type Stripe from "stripe";
type StripeSDK = InstanceType<typeof Stripe>;
import { getEnv } from "../../../config/env";
import {
  OrdersService,
  type Order,
} from "../../orders/application/orders.service";
import {
  STRIPE_PAYMENT_FINALIZER,
  type StripePaymentFinalizer,
} from "./stripe-payment-finalizer";

export const STRIPE_CLIENT = Symbol("STRIPE_CLIENT");
export type StripePaymentsClient = Pick<
  StripeSDK,
  "paymentIntents" | "webhooks"
>;
export interface NativePaymentIntentResult {
  orderId: string;
  paymentIntentId: string;
  clientSecret: string;
}

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripe: StripePaymentsClient | null,
    @Inject(STRIPE_PAYMENT_FINALIZER)
    private readonly finalizer: StripePaymentFinalizer,
    @Inject(forwardRef(() => OrdersService))
    private readonly orders: OrdersService,
  ) {}

  async createPaymentIntent(order: Order): Promise<NativePaymentIntentResult> {
    if (!this.stripe || !getEnv().STRIPE_SECRET_KEY)
      throw new ServiceUnavailableException(
        "Stripe payments are not configured",
      );
    const intent = order.stripePaymentIntentId
      ? await this.stripe.paymentIntents.retrieve(order.stripePaymentIntentId)
      : await this.stripe.paymentIntents.create(
          {
            amount: order.totalAmount,
            currency: order.currency.toLowerCase(),
            payment_method_types: ["card"],
            metadata: { order_id: order.id },
            transfer_group: `order:${order.id}`,
          },
          { idempotencyKey: `payment-intent:${order.id}` },
        );
    if (!intent.client_secret)
      throw new ServiceUnavailableException(
        "Stripe did not return a payment client secret",
      );
    await this.orders.attachPaymentIntent(order.id, intent.id);
    return {
      orderId: order.id,
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret,
    };
  }

  async handleStripeWebhook(
    payload: Buffer | string | Record<string, unknown>,
    signature?: string,
  ): Promise<{ received: true; duplicate: boolean }> {
    const secret = getEnv().STRIPE_WEBHOOK_SECRET;
    if (!secret || !this.stripe)
      throw new ServiceUnavailableException(
        "Stripe webhook verification is not configured",
      );
    if (!signature)
      throw new UnauthorizedException("Missing Stripe webhook signature");
    if (!Buffer.isBuffer(payload) && typeof payload !== "string")
      throw new BadRequestException("Stripe requires the raw webhook body");
    let event: ReturnType<StripeSDK["webhooks"]["constructEvent"]>;
    try {
      event = this.stripe.webhooks.constructEvent(payload, signature, secret);
    } catch {
      throw new UnauthorizedException("Invalid Stripe webhook signature");
    }
    if (event.type !== "payment_intent.succeeded")
      return { received: true, duplicate: false };
    const intent = event.data.object;
    const orderId = intent.metadata.order_id;
    if (!orderId) return { received: true, duplicate: false };
    if (
      !Number.isSafeInteger(intent.amount_received) ||
      intent.amount_received <= 0
    )
      throw new BadRequestException("Invalid paid amount");
    const result = await this.finalizer.confirm({
      eventId: event.id,
      orderId,
      paymentIntentId: intent.id,
      amount: intent.amount_received,
      currency: intent.currency.toUpperCase(),
    });
    return { received: true, ...result };
  }
}

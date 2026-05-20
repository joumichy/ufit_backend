import { BadRequestException, Inject, Injectable, ServiceUnavailableException, UnauthorizedException, forwardRef } from '@nestjs/common';
import { getEnv } from '../../../config/env';
import { OrdersService, type Order } from '../../orders/application/orders.service';

export const STRIPE_CLIENT = Symbol('STRIPE_CLIENT');
export const STRIPE_WEBHOOK_EVENTS = Symbol('STRIPE_WEBHOOK_EVENTS');

export interface StripeWebhookEventRecord {
  stripeEventId: string;
  type: string;
  payload: Record<string, unknown>;
  processedAt: Date;
}

export interface StripeWebhookEventRepository {
  insertIfNew(event: StripeWebhookEventRecord): Promise<boolean>;
}

export interface CheckoutSessionResult {
  orderId: string;
  checkoutSessionId: string;
  url: string;
}

interface StripeEventLike {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
}

interface StripeCheckoutSessionLike {
  id: string;
  url: string | null;
}

export interface StripeCheckoutClient {
  checkout: {
    sessions: {
      create(
        params: Record<string, unknown>,
        options: { idempotencyKey: string }
      ): Promise<StripeCheckoutSessionLike>;
    };
  };
  webhooks: {
    constructEvent(payload: Buffer | string, signature: string, secret: string): StripeEventLike;
  };
}

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(STRIPE_CLIENT)
    private readonly stripe: StripeCheckoutClient,
    @Inject(STRIPE_WEBHOOK_EVENTS)
    private readonly webhookEvents: StripeWebhookEventRepository,
    @Inject(forwardRef(() => OrdersService))
    private readonly orders: OrdersService
  ) {}

  async createCheckoutSession(order: Order): Promise<CheckoutSessionResult> {
    const env = getEnv();
    if (!env.STRIPE_SECRET_KEY) {
      throw new ServiceUnavailableException('Stripe checkout is not configured');
    }
    if (!env.STRIPE_CHECKOUT_SUCCESS_URL || !env.STRIPE_CHECKOUT_CANCEL_URL) {
      throw new ServiceUnavailableException('Stripe checkout return URLs are not configured');
    }

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        success_url: env.STRIPE_CHECKOUT_SUCCESS_URL,
        cancel_url: env.STRIPE_CHECKOUT_CANCEL_URL,
        client_reference_id: order.id,
        metadata: {
          order_id: order.id
        },
        payment_intent_data: {
          metadata: {
            order_id: order.id
          }
        },
        line_items: this.buildLineItems(order)
      },
      {
        idempotencyKey: `checkout:${order.id}`
      }
    );

    await this.orders.attachStripeCheckoutSession(order.id, session.id);

    if (!session.url) {
      throw new ServiceUnavailableException('Stripe did not return a Checkout Session URL');
    }

    return {
      orderId: order.id,
      checkoutSessionId: session.id,
      url: session.url
    };
  }

  async handleStripeWebhook(payload: Buffer | string | Record<string, unknown>, signature?: string): Promise<{ received: true; duplicate: boolean }> {
    const event = this.constructWebhookEvent(payload, signature);
    const inserted = await this.webhookEvents.insertIfNew({
      stripeEventId: event.id,
      type: event.type,
      payload: event as unknown as Record<string, unknown>,
      processedAt: new Date()
    });

    if (!inserted) {
      return { received: true, duplicate: true };
    }

    await this.applyEvent(event);
    return { received: true, duplicate: false };
  }

  private buildLineItems(order: Order): Array<Record<string, unknown>> {
    const productItems = order.items.map((item) => ({
      quantity: item.quantity,
      price_data: {
        currency: order.currency.toLowerCase(),
        unit_amount: item.unitPrice,
        product_data: {
          name: this.productName(item.productSnapshot),
          metadata: {
            product_id: item.productId,
            product_variant_id: item.productVariantId
          }
        }
      }
    }));

    if (order.shippingAmount <= 0) {
      return productItems;
    }

    return [
      ...productItems,
      {
        quantity: 1,
        price_data: {
          currency: order.currency.toLowerCase(),
          unit_amount: order.shippingAmount,
          product_data: {
            name: 'Shipping'
          }
        }
      }
    ];
  }

  private productName(snapshot: Record<string, unknown>): string {
    return typeof snapshot.name === 'string' && snapshot.name.trim().length > 0 ? snapshot.name : 'UFit item';
  }

  private constructWebhookEvent(payload: Buffer | string | Record<string, unknown>, signature?: string): StripeEventLike {
    const env = getEnv();
    if (env.STRIPE_WEBHOOK_SECRET) {
      if (!signature) {
        throw new UnauthorizedException('Missing Stripe webhook signature');
      }
      if (!Buffer.isBuffer(payload) && typeof payload !== 'string') {
        throw new BadRequestException('Stripe webhook signature verification requires the raw request body');
      }

      try {
        return this.stripe.webhooks.constructEvent(payload, signature, env.STRIPE_WEBHOOK_SECRET);
      } catch {
        throw new UnauthorizedException('Invalid Stripe webhook signature');
      }
    }

    const rawEvent = Buffer.isBuffer(payload) || typeof payload === 'string' ? JSON.parse(payload.toString()) : payload;
    return rawEvent as StripeEventLike;
  }

  private async applyEvent(event: StripeEventLike): Promise<void> {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const metadata = this.readMetadata(session);
      const orderId = metadata.order_id;
      if (orderId) {
        await this.confirmStripePayment(
          orderId,
          this.stringifyId(session.payment_intent),
          this.readAmount(session, 'amount_total'),
          this.readCurrency(session)
        );
      }
    }

    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object;
      const metadata = this.readMetadata(intent);
      const orderId = metadata.order_id;
      if (orderId && typeof intent.id === 'string') {
        await this.confirmStripePayment(orderId, intent.id, this.readAmount(intent, 'amount_received') ?? this.readAmount(intent, 'amount'), this.readCurrency(intent));
      }
    }
  }

  private async confirmStripePayment(orderId: string, paymentIntentId: string | undefined, amount: number | undefined, currency: string | undefined): Promise<void> {
    if (paymentIntentId && amount !== undefined && currency) {
      await this.orders.confirmStripePaymentSucceededFromWebhook?.({
        orderId,
        provider: 'stripe',
        providerPaymentIntentId: paymentIntentId,
        amount,
        currency
      });
      return;
    }

    await this.orders.markStripePaymentSucceeded(orderId, paymentIntentId);
  }

  private readMetadata(object: Record<string, unknown>): Record<string, string> {
    return object.metadata && typeof object.metadata === 'object' ? (object.metadata as Record<string, string>) : {};
  }

  private stringifyId(value: unknown): string | undefined {
    if (!value) {
      return undefined;
    }

    if (typeof value === 'string') {
      return value;
    }

    if (typeof value === 'object' && 'id' in value && typeof value.id === 'string') {
      return value.id;
    }

    return undefined;
  }

  private readAmount(object: Record<string, unknown>, key: string): number | undefined {
    return typeof object[key] === 'number' ? object[key] : undefined;
  }

  private readCurrency(object: Record<string, unknown>): string | undefined {
    return typeof object.currency === 'string' ? object.currency.toUpperCase() : undefined;
  }
}

import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  forwardRef,
} from "@nestjs/common";
import type Stripe from "stripe";
import { ConnectAccountsService } from "./connect-accounts.service";
import { CONNECT } from "../domain/connect-account";
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

import {
  CANCELLATION, CANCELLATION_REFUND,
  type CancellationRefundAttempt,
  type CancellationClaim,
} from "../../orders/domain/order-lifecycle";
import {
  reverseStripeCancellation,
  type StripeCancellationResult,
} from "../infrastructure/stripe-order-cancellation";
import { OrderCancellationService } from "../../orders/application/order-cancellation.service";
import { STRIPE_ORDER_METADATA, STRIPE_COMMERCE } from "./stripe-commerce";

export { STRIPE_CLIENT } from "./stripe-commerce";
import { STRIPE_CLIENT } from "./stripe-commerce";
import {refundStripeReturn, STRIPE_RETURN} from '../infrastructure/stripe-order-return';
import type {ReturnRefundClaim} from '../../orders/domain/return-refund';
import {RETURN_REFUND} from '../../orders/domain/return-refund';
import {ReturnRefundsService} from '../../orders/application/return-refunds.service';
import {PaymentDistributionService} from './payment-distribution.service';
import {z} from 'zod';
import {RefundSettlementsService} from './refund-settlements.service';
import {REFUND_SETTLEMENT} from '../domain/refund-settlement';
import {captureReceiptSchema} from '../domain/payment-settlement';
const cancellationReferenceSchema = z.object({orderId: z.uuid(), cancellationId: z.uuid(), attemptId: z.uuid(), refundId: z.string().nonempty()});
const refundReferenceSchema = z.object({orderId: z.uuid(), returnId: z.uuid(), attemptId: z.uuid(), refundId: z.string().nonempty()});
export type StripePaymentsClient = Pick<
  StripeSDK,
  | "paymentIntents"
  | "webhooks"
  | "refunds"
  | "accounts"
  | "accountLinks"
  | "countrySpecs"
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
    @Inject(forwardRef(() => OrderCancellationService))
    private readonly cancellations: OrderCancellationService,
    @Inject(ConnectAccountsService)
    private readonly connect: ConnectAccountsService,
    @Inject(forwardRef(() => ReturnRefundsService))
    private readonly returnRefunds: ReturnRefundsService,
    @Inject(PaymentDistributionService)
    private readonly distribution: PaymentDistributionService,
    @Inject(RefundSettlementsService)
    private readonly refundSettlements: RefundSettlementsService,
  ) {}

  async reverseCancellation(
    claim: CancellationClaim,
    prepareRefund: () => Promise<CancellationRefundAttempt>,
  ): Promise<StripeCancellationResult> {
    if (!claim.paymentIntentId)
      return { settlement: { outcome: CANCELLATION.outcome.notCharged } };
    if (!this.stripe || !getEnv().STRIPE_SECRET_KEY)
      throw new ServiceUnavailableException(
        STRIPE_COMMERCE.configuration.paymentsUnavailable,
      );
    return reverseStripeCancellation(this.stripe, claim, prepareRefund);
  }

  async refundReturn(claim: ReturnRefundClaim) {
    if (!this.stripe || !getEnv().STRIPE_SECRET_KEY) throw new ServiceUnavailableException(STRIPE_COMMERCE.configuration.paymentsUnavailable);
    return refundStripeReturn(this.stripe, claim);
  }

  async createPaymentIntent(order: Order): Promise<NativePaymentIntentResult> {
    if (!this.stripe || !getEnv().STRIPE_SECRET_KEY)
      throw new ServiceUnavailableException(
        STRIPE_COMMERCE.configuration.paymentsUnavailable,
      );
    await this.distribution.assertOrderTerms(order.id);
    await this.connect.assertSaleRecipients(
      order.brandId,
      order.items.flatMap((item) =>
        item.sourceCreatorId ? [item.sourceCreatorId] : [],
      ),
    );
    const intent = order.stripePaymentIntentId
      ? await this.stripe.paymentIntents.retrieve(order.stripePaymentIntentId)
      : await this.stripe.paymentIntents.create(
          {
            amount: order.totalAmount,
            currency: order.currency.toLowerCase(),
            payment_method_types: ["card"],
            metadata: { [STRIPE_ORDER_METADATA.orderId]: order.id },
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
    if (event.type === CONNECT.eventUpdated) {
      await this.connect.accountUpdated(event.data.object.id, event.livemode);
      return { received: true, duplicate: false };
    }
    if (event.type === REFUND_SETTLEMENT.event.chargeRefunded) {
      await this.refundSettlements.requestCharge(event.data.object.id, event.livemode);
      return {received: true, duplicate: false};
    }
    if (STRIPE_COMMERCE.refundEvents.some(type => type === event.type)) {
      const payloadRefund = event.data.object as Awaited<ReturnType<StripePaymentsClient['refunds']['retrieve']>>;
      const refund = await this.stripe.refunds.retrieve(payloadRefund.id);
      if (refund.id !== payloadRefund.id) throw new BadRequestException(CANCELLATION_REFUND.failure.mismatch);
      const charge = captureReceiptSchema.shape.chargeId.safeParse(refund.charge);
      if (charge.success) await this.refundSettlements.requestCharge(charge.data, event.livemode);
      const returnId = refund.metadata?.[STRIPE_RETURN.metadata.returnId];
      const attemptId = refund.metadata?.[STRIPE_RETURN.metadata.attemptId];
      const cancellationId = refund.metadata?.[STRIPE_ORDER_METADATA.cancellationId];
      const cancellationAttempt = refund.metadata?.[STRIPE_ORDER_METADATA.cancellationAttemptId];
      const hasReturn = returnId !== undefined || attemptId !== undefined;
      const hasCancellation = cancellationId !== undefined || cancellationAttempt !== undefined;
      if (hasReturn && hasCancellation) throw new BadRequestException(CANCELLATION_REFUND.failure.mismatch);
      if (hasCancellation) {
        const reference = cancellationReferenceSchema.safeParse({orderId: refund.metadata?.[STRIPE_ORDER_METADATA.orderId], cancellationId, attemptId: cancellationAttempt, refundId: refund.id});
        if (!reference.success) throw new BadRequestException(CANCELLATION_REFUND.failure.mismatch);
        const changed = await this.cancellations.reconcile(reference.data);
        return {received: true, duplicate: !changed};
      }
      if (!hasReturn) return {received: true, duplicate: false};
      const reference = refundReferenceSchema.safeParse({orderId: refund.metadata?.[STRIPE_ORDER_METADATA.orderId], returnId, attemptId, refundId: refund.id});
      if (!reference.success) throw new BadRequestException(RETURN_REFUND.failure.mismatch);
      const changed = await this.returnRefunds.reconcile(reference.data);
      return {received: true, duplicate: !changed};
    }
    if (event.type !== STRIPE_COMMERCE.paymentSucceeded)
      return { received: true, duplicate: false };
    const intent = event.data.object;
    const orderId = intent.metadata[STRIPE_ORDER_METADATA.orderId];
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
    if (result.reversalRequired) await this.cancellations.recoverOrder(orderId);
    return { received: true, duplicate: result.duplicate };
  }
}

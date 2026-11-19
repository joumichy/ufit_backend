import {
  BadRequestException,
  ConflictException,
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
import {CUSTOMER_PAYMENT as CUSTOMER, customerPaymentResumable, customerPaymentSessionSchema, type CustomerPaymentSession} from '../domain/customer-payment';
import {customerPaymentDocument, readCustomerPaymentIntent} from '../infrastructure/customer-payment-status';
import {ORDER_STATUS} from '../../orders/domain/order-lifecycle';
import {fromStripeAmount, toStripeAmount} from '../infrastructure/stripe-amount';
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

  private paymentMode(): boolean {
    const key = getEnv().STRIPE_SECRET_KEY;
    if (key && CONNECT.key.live.some(prefix => key.startsWith(prefix))) return true;
    if (key && CONNECT.key.test.some(prefix => key.startsWith(prefix))) return false;
    throw new ServiceUnavailableException(CUSTOMER.failure.unavailable);
  }

  async paymentStatus(order: Order) {
    if (order.status !== ORDER_STATUS.pendingPayment) return customerPaymentDocument(order, CUSTOMER.state.orderUpdated, null);
    if (order.stripePaymentIntentId === undefined) return customerPaymentDocument(order, CUSTOMER.state.notStarted, null);
    const intent = await this.readPaymentIntent(order.stripePaymentIntentId);
    return readCustomerPaymentIntent(order, intent, this.paymentMode()).payment;
  }

  private async readPaymentIntent(id: string) {
    if (!this.stripe) throw new ServiceUnavailableException(CUSTOMER.failure.unavailable);
    try { return await this.stripe.paymentIntents.retrieve(id); }
    catch { throw new ServiceUnavailableException(CUSTOMER.failure.unavailable); }
  }

  prepareChargeAmount(amount: number, currency: string): number {
    try { return toStripeAmount(amount, currency); }
    catch { throw new ConflictException(STRIPE_COMMERCE.amountUnrepresentable); }
  }

  async assertNewSale(brandId: string, subtotal: number, creatorCommission: number, creatorIds: string[]): Promise<void> {
    if (!this.stripe || !getEnv().STRIPE_SECRET_KEY) throw new ServiceUnavailableException(STRIPE_COMMERCE.configuration.paymentsUnavailable);
    this.paymentMode();
    await this.distribution.assertSaleTerms(brandId, subtotal, creatorCommission);
    await this.connect.assertSaleRecipients(brandId, creatorIds);
  }

  async createPaymentIntent(order: Order): Promise<CustomerPaymentSession> {
    if (order.status !== ORDER_STATUS.pendingPayment) {
      return customerPaymentSessionSchema.parse({payment: customerPaymentDocument(order, CUSTOMER.state.orderUpdated, null), clientSecret: null});
    }
    if (!this.stripe || !getEnv().STRIPE_SECRET_KEY)
      throw new ServiceUnavailableException(
        STRIPE_COMMERCE.configuration.paymentsUnavailable,
      );
    const liveMode = this.paymentMode();
    const chargeAmount = this.prepareChargeAmount(order.totalAmount, order.currency);
    let intent = order.stripePaymentIntentId === undefined ? undefined : await this.readPaymentIntent(order.stripePaymentIntentId);
    const resumable = intent === undefined || customerPaymentResumable(readCustomerPaymentIntent(order, intent, liveMode).payment.state);
    if (resumable) {
      await this.distribution.assertOrderTerms(order.id);
      await this.connect.assertSaleRecipients(order.brandId, order.items.flatMap(item => item.sourceCreatorId ? [item.sourceCreatorId] : []));
    }
    if (intent === undefined) {
      intent = await this.stripe.paymentIntents.create(
          {
            amount: chargeAmount,
            currency: order.currency.toLowerCase(),
            payment_method_types: [CUSTOMER.provider.card],
            metadata: { [STRIPE_ORDER_METADATA.orderId]: order.id },
            transfer_group: CUSTOMER.provider.groupPrefix + order.id,
          },
          { idempotencyKey: CUSTOMER.provider.keyPrefix + order.id },
        );
    }
    readCustomerPaymentIntent(order, intent, liveMode);
    const current = await this.orders.getForCustomer(order.customerId, order.id);
    if (current.status !== ORDER_STATUS.pendingPayment) {
      return customerPaymentSessionSchema.parse({payment: customerPaymentDocument(current, CUSTOMER.state.orderUpdated, null), clientSecret: null});
    }
    if (current.stripePaymentIntentId === undefined) await this.orders.attachPaymentIntent(order.id, intent.id);
    const result = readCustomerPaymentIntent({...current, stripePaymentIntentId: current.stripePaymentIntentId ?? intent.id}, intent, liveMode);
    const parsed = customerPaymentSessionSchema.safeParse({payment: result.payment,
      clientSecret: customerPaymentResumable(result.payment.state) ? result.clientSecret : null});
    if (!parsed.success) throw new ServiceUnavailableException(CUSTOMER.failure.invalid);
    return parsed.data;
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
    const amount = fromStripeAmount(intent.amount_received, intent.currency);
    if (amount === undefined) throw new BadRequestException(STRIPE_COMMERCE.amountUnrepresentable);
    const result = await this.finalizer.confirm({
      eventId: event.id,
      orderId,
      paymentIntentId: intent.id,
      amount,
      currency: intent.currency.toUpperCase(),
    });
    if (result.reversalRequired) await this.cancellations.recoverOrder(orderId);
    return { received: true, duplicate: result.duplicate };
  }
}

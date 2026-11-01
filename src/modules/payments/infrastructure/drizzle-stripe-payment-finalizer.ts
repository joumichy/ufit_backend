import {calculateCommissionAmount, parseStoredRate} from '../../commissions/domain/commission-rule.contract';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { DatabaseService } from "../../../shared/infrastructure/database/database.service";
import {
  cartItems,
  carts,
  commissions,
  orderCancellations,
  orderItems,
  orders,
  orderStatusHistory,
  payments,
  productVariants,
  shipments,
  stripeWebhookEvents,
} from "../../../shared/infrastructure/database/schema";
import type {
  StripePaidPayment,
  StripePaymentFinalizer,
  StripePaymentFinalization,
} from "../application/stripe-payment-finalizer";

import {
  CANCELLATION,
  ORDER_LIMIT,
  ORDER_PAYMENT,
  ORDER_STATUS,
  ORDER_COMMISSION,
} from "../../orders/domain/order-lifecycle";
import { STRIPE_COMMERCE } from "../application/stripe-commerce";

const FULFILLMENT = {
  lock: "update",
  shipmentPending: "pending",
  cartActive: "active",
  cartCheckedOut: "checked_out",
  cartLockPrefix: "ufit-cart:",
  lockSeed: 0,
  confirmed: "payment_confirmed",
  notFound: "Order not found",
  mismatch: "Payment confirmation does not match the order",
  linked: "Payment is linked to another operation",
  unavailable: "Order no longer accepts payment",
  empty: "Cannot fulfill an empty order",
} as const;
class PaidOrderStockUnavailable extends Error {}

@Injectable()
export class DrizzleStripePaymentFinalizer implements StripePaymentFinalizer {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async confirm(input: StripePaidPayment): Promise<StripePaymentFinalization> {
    return this.database.db.transaction(async (tx) => {
      // This event record rolls back with every fulfillment write on failure.
      const [event] = await tx
        .insert(stripeWebhookEvents)
        .values({
          stripeEventId: input.eventId,
          type: STRIPE_COMMERCE.paymentSucceeded,
          payload: {
            orderId: input.orderId,
            paymentIntentId: input.paymentIntentId,
            amount: input.amount,
            currency: input.currency,
          },
          processedAt: new Date(),
        })
        .onConflictDoNothing({ target: stripeWebhookEvents.stripeEventId })
        .returning({ id: stripeWebhookEvents.id });

      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .limit(ORDER_LIMIT.singleRow)
        .for(FULFILLMENT.lock);
      if (!order) throw new BadRequestException(FULFILLMENT.notFound);
      if (
        order.stripePaymentIntentId !== input.paymentIntentId ||
        order.totalAmount !== input.amount ||
        order.currency !== input.currency
      ) {
        throw new BadRequestException(FULFILLMENT.mismatch);
      }
      const [previous] = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.provider, ORDER_PAYMENT.provider),
            eq(payments.providerPaymentIntentId, input.paymentIntentId),
          ),
        )
        .limit(ORDER_LIMIT.singleRow);
      const [cancellation] = await tx
        .select()
        .from(orderCancellations)
        .where(eq(orderCancellations.orderId, order.id))
        .limit(ORDER_LIMIT.singleRow);
      if (previous) {
        if (
          previous.orderId !== order.id ||
          !(
            [
              ORDER_PAYMENT.status.succeeded,
              ORDER_PAYMENT.status.refunded,
            ] as readonly string[]
          ).includes(previous.status)
        )
          throw new ConflictException(FULFILLMENT.linked);
        return {
          duplicate: true,
          reversalRequired:
            cancellation?.status === CANCELLATION.status.requested,
        };
      }
      if (
        order.status === ORDER_STATUS.cancelling ||
        order.status === ORDER_STATUS.cancelled
      ) {
        if (!cancellation)
          throw new ConflictException(CANCELLATION.failures.changed);
        await tx.insert(payments).values({
          orderId: order.id,
          provider: ORDER_PAYMENT.provider,
          providerPaymentIntentId: input.paymentIntentId,
          status:
            cancellation.paymentOutcome === CANCELLATION.outcome.refunded
              ? ORDER_PAYMENT.status.refunded
              : ORDER_PAYMENT.status.succeeded,
          amount: input.amount,
          currency: input.currency,
        });
        return {
          duplicate: !event,
          reversalRequired:
            cancellation.status === CANCELLATION.status.requested,
        };
      }
      if (order.status !== ORDER_STATUS.pendingPayment)
        throw new ConflictException(FULFILLMENT.unavailable);
      const items = await tx
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, order.id));
      if (!items.length) throw new BadRequestException(FULFILLMENT.empty);
      // Consistent variant ordering avoids deadlocks between two paid orders.
      const quantities = new Map<string, number>();
      for (const item of items)
        quantities.set(
          item.productVariantId,
          (quantities.get(item.productVariantId) ??
            ORDER_LIMIT.initialQuantity) + item.quantity,
        );
      let stockUnavailable = false;
      try {
        // A savepoint restores all earlier variant changes when any piece cannot be fulfilled.
        await tx.transaction(async (inventory) => {
          for (const [variantId, quantity] of [...quantities].sort(([a], [b]) =>
            a.localeCompare(b),
          )) {
            const updated = await inventory
              .update(productVariants)
              .set({
                stockQuantity: sql`${productVariants.stockQuantity} - ${quantity}`,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(productVariants.id, variantId),
                  gte(productVariants.stockQuantity, quantity),
                ),
              )
              .returning({ id: productVariants.id });
            if (!updated.length) throw new PaidOrderStockUnavailable();
          }
        });
      } catch (error) {
        if (!(error instanceof PaidOrderStockUnavailable)) throw error;
        stockUnavailable = true;
      }
      if (stockUnavailable) {
        await tx.insert(orderCancellations).values({
          orderId: order.id,
          originalStatus: ORDER_STATUS.pendingPayment,
          status: CANCELLATION.status.requested,
          reason: CANCELLATION.reason.stockUnavailable,
        });
        await tx
          .update(orders)
          .set({ status: ORDER_STATUS.cancelling, updatedAt: new Date() })
          .where(eq(orders.id, order.id));
        await tx.insert(orderStatusHistory).values({
          orderId: order.id,
          fromStatus: ORDER_STATUS.pendingPayment,
          toStatus: ORDER_STATUS.cancelling,
          reason: CANCELLATION.reasons.stockUnavailable,
        });
        await tx.insert(payments).values({
          orderId: order.id,
          provider: ORDER_PAYMENT.provider,
          providerPaymentIntentId: input.paymentIntentId,
          status: ORDER_PAYMENT.status.succeeded,
          amount: input.amount,
          currency: input.currency,
        });
        return { duplicate: !event, reversalRequired: true };
      }
      await tx.insert(payments).values({
        orderId: order.id,
        provider: ORDER_PAYMENT.provider,
        providerPaymentIntentId: input.paymentIntentId,
        status: ORDER_PAYMENT.status.succeeded,
        amount: input.amount,
        currency: input.currency,
      });
      await tx.insert(shipments).values({
        orderId: order.id,
        brandId: order.brandId,
        status: FULFILLMENT.shipmentPending,
      });
      for (const item of items) {
        if (!item.sourceCreatorId || !item.sourceOutfitId) continue;
        const commissionAmount = calculateCommissionAmount(item.totalPrice, parseStoredRate(item.commissionRate));
        await tx.insert(commissions).values({
          orderItemId: item.id,
          creatorId: item.sourceCreatorId,
          brandId: order.brandId,
          sourceOutfitId: item.sourceOutfitId,
          baseAmount: item.totalPrice,
          commissionRate: item.commissionRate,
          commissionAmount,
          status: ORDER_COMMISSION.status.pending,
        });
      }
      await tx
        .update(orders)
        .set({
          status: ORDER_STATUS.paid,
          paymentProvider: ORDER_PAYMENT.provider,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, order.id));
      await tx.insert(orderStatusHistory).values({
        orderId: order.id,
        fromStatus: ORDER_STATUS.pendingPayment,
        toStatus: ORDER_STATUS.paid,
        reason: FULFILLMENT.confirmed,
      });
      if (order.cartId) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${FULFILLMENT.cartLockPrefix + order.customerId}, ${FULFILLMENT.lockSeed}))`,
        );
        const [cart] = await tx
          .select()
          .from(carts)
          .where(
            and(
              eq(carts.id, order.cartId),
              eq(carts.status, FULFILLMENT.cartActive),
            ),
          )
          .limit(ORDER_LIMIT.singleRow);
        if (cart) {
          const lines = await tx
            .select()
            .from(cartItems)
            .where(eq(cartItems.cartId, cart.id))
            .orderBy(asc(cartItems.id));
          const signature = (
            rows: Array<{
              productVariantId: string;
              quantity: number;
              sourceOutfitId: string | null;
            }>,
          ) =>
            JSON.stringify(
              rows
                .map((row) => [
                  row.productVariantId,
                  row.quantity,
                  row.sourceOutfitId,
                ])
                .sort(),
            );
          // A separately edited cart must not be silently discarded by a late webhook.
          if (signature(lines) === signature(items))
            await tx
              .update(carts)
              .set({
                status: FULFILLMENT.cartCheckedOut,
                updatedAt: new Date(),
              })
              .where(eq(carts.id, cart.id));
        }
      }
      return { duplicate: !event, reversalRequired: false };
    });
  }
}

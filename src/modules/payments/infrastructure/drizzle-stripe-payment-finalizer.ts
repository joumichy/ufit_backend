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
} from "../application/stripe-payment-finalizer";

import {
  CANCELLATION,
  ORDER_LIMIT,
  ORDER_PAYMENT,
  ORDER_STATUS,
} from "../../orders/domain/order-lifecycle";

@Injectable()
export class DrizzleStripePaymentFinalizer implements StripePaymentFinalizer {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async confirm(input: StripePaidPayment): Promise<{ duplicate: boolean }> {
    return this.database.db.transaction(async (tx) => {
      // This event record rolls back with every fulfillment write on failure.
      const [event] = await tx
        .insert(stripeWebhookEvents)
        .values({
          stripeEventId: input.eventId,
          type: "payment_intent.succeeded",
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
      if (!event) return { duplicate: true };
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .limit(1)
        .for("update");
      if (!order) throw new BadRequestException("Order not found");
      if (
        order.stripePaymentIntentId !== input.paymentIntentId ||
        order.totalAmount !== input.amount ||
        order.currency !== input.currency
      ) {
        throw new BadRequestException(
          "Payment confirmation does not match the order",
        );
      }
      const [previous] = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.provider, "stripe"),
            eq(payments.providerPaymentIntentId, input.paymentIntentId),
          ),
        )
        .limit(1);
      if (previous) {
        if (
          previous.orderId !== order.id ||
          !["succeeded", "refunded"].includes(previous.status)
        )
          throw new ConflictException("Payment is linked to another operation");
        return { duplicate: true };
      }
      if (
        order.status === ORDER_STATUS.cancelling ||
        order.status === ORDER_STATUS.cancelled
      ) {
        const [cancellation] = await tx
          .select()
          .from(orderCancellations)
          .where(eq(orderCancellations.orderId, order.id))
          .limit(ORDER_LIMIT.singleRow);
        if (!cancellation)
          throw new ConflictException(CANCELLATION.failures.changed);
        await tx
          .insert(payments)
          .values({
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
        return { duplicate: false };
      }
      if (order.status !== "pending_payment")
        throw new ConflictException("Order no longer accepts payment");
      const items = await tx
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, order.id));
      if (!items.length)
        throw new BadRequestException("Cannot fulfill an empty order");
      // Consistent variant ordering avoids deadlocks between two paid orders.
      const quantities = new Map<string, number>();
      for (const item of items)
        quantities.set(
          item.productVariantId,
          (quantities.get(item.productVariantId) ?? 0) + item.quantity,
        );
      for (const [variantId, quantity] of [...quantities].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const updated = await tx
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
        if (!updated.length)
          throw new ConflictException({
            code: "payment_stock_unavailable",
            message: "Stock is unavailable for this paid order",
          });
      }
      await tx.insert(payments).values({
        orderId: order.id,
        provider: "stripe",
        providerPaymentIntentId: input.paymentIntentId,
        status: "succeeded",
        amount: input.amount,
        currency: input.currency,
      });
      await tx.insert(shipments).values({
        orderId: order.id,
        brandId: order.brandId,
        status: "pending",
      });
      for (const item of items) {
        if (!item.sourceCreatorId || !item.sourceOutfitId) continue;
        const rateBasisPoints = Math.round(Number(item.commissionRate) * 10000);
        const commissionAmount = Number(
          (BigInt(item.totalPrice) * BigInt(rateBasisPoints) + 5000n) / 10000n,
        );
        await tx.insert(commissions).values({
          orderItemId: item.id,
          creatorId: item.sourceCreatorId,
          brandId: order.brandId,
          sourceOutfitId: item.sourceOutfitId,
          baseAmount: item.totalPrice,
          commissionRate: item.commissionRate,
          commissionAmount,
          status: "pending",
        });
      }
      await tx
        .update(orders)
        .set({
          status: "paid",
          paymentProvider: "stripe",
          updatedAt: new Date(),
        })
        .where(eq(orders.id, order.id));
      await tx.insert(orderStatusHistory).values({
        orderId: order.id,
        fromStatus: "pending_payment",
        toStatus: "paid",
        reason: "payment_confirmed",
      });
      if (order.cartId) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${"ufit-cart:" + order.customerId}, 0))`,
        );
        const [cart] = await tx
          .select()
          .from(carts)
          .where(and(eq(carts.id, order.cartId), eq(carts.status, "active")))
          .limit(1);
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
              .set({ status: "checked_out", updatedAt: new Date() })
              .where(eq(carts.id, cart.id));
        }
      }
      return { duplicate: false };
    });
  }
}

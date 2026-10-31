import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { DatabaseService } from "../../../shared/infrastructure/database/database.service";
import {
  commissions,
  orderCancellations,
  orderItems,
  orders,
  orderStatusHistory,
  payments,
  productVariants,
  shipments,
} from "../../../shared/infrastructure/database/schema";
import {
  CANCELLATION,
  ORDER_COMMISSION,
  ORDER_LIMIT,
  ORDER_PAYMENT,
  ORDER_STATUS,
  type CancellationClaim,
  type CancellationSettlement,
  type OrderCancellationRepository,
  type OrderStatus,
} from "../domain/order-lifecycle";

const SHIPMENT_CANCELLED = "cancelled";
const ROW_LOCK = "update";
const ORDER_NOT_FOUND = "Order not found";
@Injectable()
export class DrizzleOrderCancellationRepository
  implements OrderCancellationRepository
{
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}
  async claim(customerId: string, orderId: string): Promise<CancellationClaim> {
    return this.database.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId)))
        .limit(ORDER_LIMIT.singleRow)
        .for(ROW_LOCK);
      if (!order) throw new NotFoundException(ORDER_NOT_FOUND);
      const [existing] = await tx
        .select()
        .from(orderCancellations)
        .where(eq(orderCancellations.orderId, order.id))
        .limit(ORDER_LIMIT.singleRow);
      let cancellation = existing;
      if (!cancellation) {
        if (
          order.status !== ORDER_STATUS.pendingPayment &&
          order.status !== ORDER_STATUS.paid
        )
          throw new ConflictException(CANCELLATION.failures.unavailable);
        [cancellation] = await tx
          .insert(orderCancellations)
          .values({
            orderId: order.id,
            requestedBy: customerId,
            originalStatus: order.status,
            status: CANCELLATION.status.requested,
          })
          .returning();
        await tx
          .update(orders)
          .set({ status: ORDER_STATUS.cancelling, updatedAt: new Date() })
          .where(eq(orders.id, order.id));
        await tx
          .insert(orderStatusHistory)
          .values({
            orderId: order.id,
            fromStatus: order.status,
            toStatus: ORDER_STATUS.cancelling,
            changedBy: customerId,
            reason: CANCELLATION.reasons.requested,
          });
      }
      return {
        id: cancellation.id,
        orderId: order.id,
        originalStatus: cancellation.originalStatus as OrderStatus,
        status: cancellation.status as CancellationClaim["status"],
        amount: order.totalAmount,
        currency: order.currency,
        paymentIntentId: order.stripePaymentIntentId ?? undefined,
        refundId: cancellation.stripeRefundId ?? undefined,
      };
    });
  }
  async rememberRefund(
    claim: CancellationClaim,
    refundId: string,
  ): Promise<void> {
    await this.database.db
      .update(orderCancellations)
      .set({ stripeRefundId: refundId, updatedAt: new Date() })
      .where(
        and(
          eq(orderCancellations.id, claim.id),
          eq(orderCancellations.status, CANCELLATION.status.requested),
        ),
      );
  }
  async complete(
    claim: CancellationClaim,
    settlement: CancellationSettlement,
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, claim.orderId))
        .limit(ORDER_LIMIT.singleRow)
        .for(ROW_LOCK);
      const [cancellation] = await tx
        .select()
        .from(orderCancellations)
        .where(eq(orderCancellations.id, claim.id))
        .limit(ORDER_LIMIT.singleRow);
      if (cancellation?.status === CANCELLATION.status.succeeded) return;
      if (!order || !cancellation || order.status !== ORDER_STATUS.cancelling)
        throw new ConflictException(CANCELLATION.failures.changed);
      const items = await tx
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, order.id));
      const itemIds = items.map((item) => item.id);
      if (itemIds.length) {
        const paid = await tx
          .select({ id: commissions.id })
          .from(commissions)
          .where(
            and(
              inArray(commissions.orderItemId, itemIds),
              eq(commissions.status, ORDER_COMMISSION.status.paid),
            ),
          )
          .limit(ORDER_LIMIT.singleRow);
        if (paid.length)
          throw new ConflictException(CANCELLATION.failures.payout);
        await tx
          .update(commissions)
          .set({
            status: ORDER_COMMISSION.status.cancelled,
            updatedAt: new Date(),
          })
          .where(inArray(commissions.orderItemId, itemIds));
      }
      if (cancellation.originalStatus === ORDER_STATUS.paid) {
        const quantities = new Map<string, number>();
        for (const item of items)
          quantities.set(
            item.productVariantId,
            (quantities.get(item.productVariantId) ??
              ORDER_LIMIT.initialQuantity) + item.quantity,
          );
        for (const [variantId, quantity] of [...quantities].sort(([a], [b]) =>
          a.localeCompare(b),
        )) {
          await tx
            .update(productVariants)
            .set({
              stockQuantity: sql`${productVariants.stockQuantity} + ${quantity}`,
              updatedAt: new Date(),
            })
            .where(eq(productVariants.id, variantId));
        }
      }
      if (
        settlement.outcome === CANCELLATION.outcome.refunded &&
        order.stripePaymentIntentId
      ) {
        await tx
          .insert(payments)
          .values({
            orderId: order.id,
            provider: ORDER_PAYMENT.provider,
            providerPaymentIntentId: order.stripePaymentIntentId,
            status: ORDER_PAYMENT.status.refunded,
            amount: order.totalAmount,
            currency: order.currency,
          })
          .onConflictDoUpdate({
            target: [payments.provider, payments.providerPaymentIntentId],
            targetWhere: sql`${payments.providerPaymentIntentId} is not null`,
            set: {
              status: ORDER_PAYMENT.status.refunded,
              updatedAt: new Date(),
            },
          });
      }
      await tx
        .update(shipments)
        .set({ status: SHIPMENT_CANCELLED, updatedAt: new Date() })
        .where(eq(shipments.orderId, order.id));
      await tx
        .update(orders)
        .set({ status: ORDER_STATUS.cancelled, updatedAt: new Date() })
        .where(eq(orders.id, order.id));
      await tx
        .insert(orderStatusHistory)
        .values({
          orderId: order.id,
          fromStatus: ORDER_STATUS.cancelling,
          toStatus: ORDER_STATUS.cancelled,
          reason: CANCELLATION.reasons.completed,
        });
      await tx
        .update(orderCancellations)
        .set({
          status: CANCELLATION.status.succeeded,
          paymentOutcome: settlement.outcome,
          stripeRefundId: settlement.refundId,
          updatedAt: new Date(),
        })
        .where(eq(orderCancellations.id, claim.id));
    });
  }
}

import {findExternalRefundSettlement} from './refund-proof-projection';
import {REFUND_RECOVERY} from '../domain/refund-recovery.contract';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {DrizzleOrderNotifications} from './drizzle-order-notifications';
import {cancelledOrderNotification} from '../domain/order-notification';
import { SHIPPING, SHIPMENT_STATUS } from '../../shipping/domain/shipping.contract';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { alias } from "drizzle-orm/pg-core";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { DatabaseService } from "../../../shared/infrastructure/database/database.service";
import {
  commissions,
  orderCancellations,
  orderCancellationRefunds,
  orderItems,
  orders,
  orderStatusHistory,
  payments,
  productVariants,
  shipments,
} from "../../../shared/infrastructure/database/schema";
import {
  CANCELLATION, CANCELLATION_REFUND, acceptsCancellationRefund, cancellationRefundOutcome,
  type CancellationRefundAttempt, type CancellationRefundReference, type CancellationRefundResult,
  ORDER_COMMISSION,
  ORDER_LIMIT,
  ORDER_PAYMENT,
  ORDER_STATUS,
  type CancellationClaim,
  type CancellationSettlement,
  type OrderCancellationRepository,
  type OrderStatus,
} from "../domain/order-lifecycle";

const ROW_LOCK = "update";
const RECOVERY_ROW = "cancellation_recovery";
const ORDER_NOT_FOUND = "Order not found";
@Injectable()
export class DrizzleOrderCancellationRepository
  implements OrderCancellationRepository
{
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseSession,
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
            reason: CANCELLATION.reason.customer,
            status: CANCELLATION.status.requested,
          })
          .returning();
        await tx
          .update(orders)
          .set({ status: ORDER_STATUS.cancelling, updatedAt: new Date() })
          .where(eq(orders.id, order.id));
        await tx.insert(orderStatusHistory).values({
          orderId: order.id,
          fromStatus: order.status,
          toStatus: ORDER_STATUS.cancelling,
          changedBy: customerId,
          reason: CANCELLATION.reasons.requested,
        });
      }
      let refund = await this.latestRefund(tx, cancellation.id);
      if (cancellation.status === CANCELLATION.status.failed && refund?.providerStatus === CANCELLATION_REFUND.providerStatus.cancelled) {
        const [inserted] = await tx.insert(orderCancellationRefunds).values({
          cancellationId: cancellation.id, attemptNumber: refund.attemptNumber + CANCELLATION_REFUND.attempt.step,
          paymentIntentId: refund.paymentIntentId, amount: refund.amount, currency: refund.currency, state: CANCELLATION_REFUND.state.queued,
        }).returning();
        refund = this.toRefund(inserted);
        [cancellation] = await tx.update(orderCancellations).set({status: CANCELLATION.status.requested, paymentOutcome: null, nextRecoveryAt: new Date(), updatedAt: new Date()})
          .where(eq(orderCancellations.id, cancellation.id)).returning();
      }
      return {
        id: cancellation.id,
        orderId: order.id,
        originalStatus: cancellation.originalStatus as OrderStatus,
        reason: cancellation.reason as CancellationClaim["reason"],
        status: cancellation.status as CancellationClaim["status"],
        amount: order.totalAmount,
        currency: order.currency,
        paymentIntentId: order.stripePaymentIntentId ?? undefined,
        refund,
      };
    });
  }
  async findPending(orderId: string): Promise<CancellationClaim | null> {
    const [row] = await this.database.db
      .select({ cancellation: orderCancellations, order: orders })
      .from(orderCancellations)
      .innerJoin(orders, eq(orders.id, orderCancellations.orderId))
      .where(
        and(
          eq(orderCancellations.orderId, orderId),
          eq(orderCancellations.status, CANCELLATION.status.requested),
        ),
      )
      .limit(ORDER_LIMIT.singleRow);
    return row ? this.toClaim(row, await this.latestRefund(this.database.db, row.cancellation.id)) : null;
  }
  async claimRecoverable(): Promise<CancellationClaim[]> {
    const queue = alias(orderCancellations, RECOVERY_ROW);
    return this.database.db.transaction(async (tx) => {
      const rows = await tx
        .select({ cancellation: queue, order: orders })
        .from(queue)
        .innerJoin(orders, eq(orders.id, queue.orderId))
        .where(
          and(
            eq(queue.status, CANCELLATION.status.requested),
            lte(queue.nextRecoveryAt, new Date()),
          ),
        )
        .orderBy(asc(queue.nextRecoveryAt), asc(queue.id))
        .limit(CANCELLATION.recovery.batchSize)
        .for(ROW_LOCK, { of: queue, skipLocked: true });
      if (rows.length)
        await tx
          .update(orderCancellations)
          .set({
            nextRecoveryAt: new Date(
              Date.now() + CANCELLATION.recovery.leaseMilliseconds,
            ),
          })
          .where(
            inArray(
              orderCancellations.id,
              rows.map((row) => row.cancellation.id),
            ),
          );
      return Promise.all(rows.map(async row => this.toClaim(row, await this.latestRefund(tx, row.cancellation.id))));
    });
  }
  private toClaim({order, cancellation}: {
    order: typeof orders.$inferSelect; cancellation: typeof orderCancellations.$inferSelect;
  }, refund: CancellationRefundAttempt | null): CancellationClaim {
    return {
      id: cancellation.id,
      orderId: order.id,
      originalStatus: cancellation.originalStatus as OrderStatus,
      reason: cancellation.reason as CancellationClaim["reason"],
      status: cancellation.status as CancellationClaim["status"],
      amount: order.totalAmount,
      currency: order.currency,
      paymentIntentId: order.stripePaymentIntentId ?? undefined,
      refund,
    };
  }
  private toRefund(row: typeof orderCancellationRefunds.$inferSelect): CancellationRefundAttempt {
    return {id: row.id, cancellationId: row.cancellationId, attemptNumber: row.attemptNumber,
      paymentIntentId: row.paymentIntentId, amount: row.amount, currency: row.currency,
      state: row.state as CancellationRefundAttempt['state'], providerStatus: row.providerStatus as CancellationRefundAttempt['providerStatus'], refundId: row.stripeRefundId};
  }
  private async latestRefund(db: DatabaseSession['db'], cancellationId: string): Promise<CancellationRefundAttempt | null> {
    const [row] = await db.select().from(orderCancellationRefunds).where(eq(orderCancellationRefunds.cancellationId, cancellationId))
      .orderBy(desc(orderCancellationRefunds.attemptNumber)).limit(ORDER_LIMIT.singleRow);
    return row ? this.toRefund(row) : null;
  }
  async prepareRefund(claim: CancellationClaim): Promise<CancellationRefundAttempt> {
    return this.database.db.transaction(async tx => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, claim.orderId)).limit(ORDER_LIMIT.singleRow).for(ROW_LOCK);
      const [cancellation] = await tx.select().from(orderCancellations).where(and(eq(orderCancellations.id, claim.id), eq(orderCancellations.orderId, claim.orderId))).limit(ORDER_LIMIT.singleRow);
      if (!order || !cancellation || !claim.paymentIntentId || order.stripePaymentIntentId !== claim.paymentIntentId || order.totalAmount !== claim.amount || order.currency !== claim.currency)
        throw new ConflictException(CANCELLATION_REFUND.failure.mismatch);
      if (claim.refund) {
        const [row] = await tx.select().from(orderCancellationRefunds).where(and(eq(orderCancellationRefunds.id, claim.refund.id), eq(orderCancellationRefunds.cancellationId, claim.id))).limit(ORDER_LIMIT.singleRow);
        if (!row || (row.stripeRefundId !== null && row.stripeRefundId !== claim.refund.refundId)) throw new ConflictException(CANCELLATION_REFUND.failure.mismatch);
        return {...this.toRefund(row), refundId: claim.refund.refundId};
      }
      const latest = await this.latestRefund(tx, claim.id);
      if (latest) return latest;
      if (cancellation.status !== CANCELLATION.status.requested) throw new ConflictException(CANCELLATION.failures.changed);
      const [row] = await tx.insert(orderCancellationRefunds).values({cancellationId: claim.id, attemptNumber: CANCELLATION_REFUND.attempt.initial,
        paymentIntentId: claim.paymentIntentId, amount: claim.amount, currency: claim.currency, state: CANCELLATION_REFUND.state.queued}).returning();
      return this.toRefund(row);
    });
  }
  async findRefund(reference: CancellationRefundReference): Promise<CancellationClaim> {
    const [row] = await this.database.db.select({order: orders, cancellation: orderCancellations, refund: orderCancellationRefunds})
      .from(orders).innerJoin(orderCancellations, eq(orderCancellations.orderId, orders.id))
      .innerJoin(orderCancellationRefunds, eq(orderCancellationRefunds.cancellationId, orderCancellations.id))
      .where(and(eq(orders.id, reference.orderId), eq(orderCancellations.id, reference.cancellationId), eq(orderCancellationRefunds.id, reference.attemptId))).limit(ORDER_LIMIT.singleRow);
    if (!row || (row.refund.stripeRefundId !== null && row.refund.stripeRefundId !== reference.refundId)) throw new ConflictException(CANCELLATION_REFUND.failure.mismatch);
    return this.toClaim(row, {...this.toRefund(row.refund), refundId: reference.refundId});
  }
  async recordRefund(claim: CancellationClaim, attempt: CancellationRefundAttempt, result: CancellationRefundResult): Promise<boolean> {
    return this.database.db.transaction(async tx => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, claim.orderId)).limit(ORDER_LIMIT.singleRow).for(ROW_LOCK);
      const [cancellation] = await tx.select().from(orderCancellations).where(and(eq(orderCancellations.id, claim.id), eq(orderCancellations.orderId, claim.orderId))).limit(ORDER_LIMIT.singleRow);
      const [row] = await tx.select().from(orderCancellationRefunds).where(and(eq(orderCancellationRefunds.id, attempt.id), eq(orderCancellationRefunds.cancellationId, claim.id))).limit(ORDER_LIMIT.singleRow);
      if (!order || !cancellation || !row || row.paymentIntentId !== order.stripePaymentIntentId || row.amount !== order.totalAmount || row.currency !== order.currency
        || (row.stripeRefundId !== null && row.stripeRefundId !== result.refundId)) throw new ConflictException(CANCELLATION_REFUND.failure.mismatch);
      const current = this.toRefund(row);
      if (!acceptsCancellationRefund(current, result) || (current.state === result.state && current.providerStatus === result.providerStatus && current.refundId === result.refundId)) return false;
      await tx.update(orderCancellationRefunds).set({state: result.state, providerStatus: result.providerStatus, stripeRefundId: result.refundId, updatedAt: new Date()}).where(eq(orderCancellationRefunds.id, row.id));
      const latest = await this.latestRefund(tx, claim.id);
      if (latest?.id !== row.id) return true;
      const external=await findExternalRefundSettlement({db:tx},{kind:REFUND_RECOVERY.kind.cancellation,id:claim.id});
      const outcome = external?CANCELLATION.outcome.refundedExternally:cancellationRefundOutcome(result);
      const status = external?CANCELLATION.status.succeeded:!cancellation.effectsApplied || outcome === null ? CANCELLATION.status.requested
        : result.state === CANCELLATION_REFUND.state.succeeded ? CANCELLATION.status.succeeded : CANCELLATION.status.failed;
      await tx.update(orderCancellations).set({status, paymentOutcome: outcome, updatedAt: new Date()}).where(eq(orderCancellations.id, claim.id));
      const [payment] = await tx.select().from(payments).where(and(eq(payments.provider, ORDER_PAYMENT.provider), eq(payments.providerPaymentIntentId, row.paymentIntentId))).limit(ORDER_LIMIT.singleRow);
      if (payment && (payment.orderId !== order.id || payment.amount !== order.totalAmount || payment.currency !== order.currency)) throw new ConflictException(CANCELLATION_REFUND.failure.mismatch);
      await tx.insert(payments).values({orderId: order.id, provider: ORDER_PAYMENT.provider, providerPaymentIntentId: row.paymentIntentId,
        status: result.state === CANCELLATION_REFUND.state.succeeded ? ORDER_PAYMENT.status.refunded : ORDER_PAYMENT.status.succeeded,
        amount: order.totalAmount, currency: order.currency}).onConflictDoUpdate({target: [payments.provider, payments.providerPaymentIntentId],
        targetWhere: sql`${payments.providerPaymentIntentId} is not null`, set: {status: result.state === CANCELLATION_REFUND.state.succeeded ? ORDER_PAYMENT.status.refunded : ORDER_PAYMENT.status.succeeded, updatedAt: new Date()}});
      return true;
    });
  }
  async complete(
    claim: CancellationClaim,
    settlement?: CancellationSettlement,
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
      if (cancellation?.effectsApplied) return;
      if (!order || !cancellation || order.status !== ORDER_STATUS.cancelling)
        throw new ConflictException(CANCELLATION.failures.changed);
      const refund = await this.latestRefund(tx, claim.id);
      const outcome = refund ? cancellationRefundOutcome(refund) : settlement?.outcome;
      if (!outcome) return;
      if (outcome === CANCELLATION.outcome.notCharged) {
        const [captured] = await tx.select({id: payments.id}).from(payments).where(eq(payments.orderId, order.id)).limit(ORDER_LIMIT.singleRow);
        // A captured webhook may race with the provider cancellation response.
        if (captured || cancellation.originalStatus === ORDER_STATUS.paid) throw new ConflictException(CANCELLATION.failures.changed);
      }
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
      await tx
        .update(shipments)
        .set({ status: SHIPMENT_STATUS.cancelled, version: sql`${shipments.version} + ${SHIPPING.revision.step}`, updatedAt: new Date() })
        .where(eq(shipments.orderId, order.id));
      await tx
        .update(orders)
        .set({ status: ORDER_STATUS.cancelled, updatedAt: new Date() })
        .where(eq(orders.id, order.id));
      await tx.insert(orderStatusHistory).values({
        orderId: order.id,
        fromStatus: ORDER_STATUS.cancelling,
        toStatus: ORDER_STATUS.cancelled,
        reason: CANCELLATION.reasons.completed,
      });
      await tx
        .update(orderCancellations)
        .set({
          status: outcome === CANCELLATION.outcome.notCharged || outcome === CANCELLATION.outcome.refunded ? CANCELLATION.status.succeeded : CANCELLATION.status.failed,
          paymentOutcome: outcome,
          effectsApplied: true,
          updatedAt: new Date(),
        })
        .where(eq(orderCancellations.id, claim.id));
      await new DrizzleOrderNotifications({db: tx}).record(cancelledOrderNotification(order.id, outcome === CANCELLATION.outcome.refunded), true);
    });
  }
}

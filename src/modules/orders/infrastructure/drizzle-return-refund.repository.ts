import {ReturnRefundFinancials} from './return-refund-financials';
import {DrizzleOrderNotifications} from './drizzle-order-notifications';
import {returnRefundNotification} from '../domain/return-notification';
import {ConflictException, Inject, Injectable} from '@nestjs/common';
import {and, asc, eq, inArray, lte} from 'drizzle-orm';
import {alias} from 'drizzle-orm/pg-core';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {orders} from '../../../shared/infrastructure/database/schema';
import {orderReturns, orderReturnRefunds} from '../../../shared/infrastructure/database/schema.returns';
import {ORDER_RETURN, RETURN_STATUS} from '../domain/order-return.contract';
import {ORDER_PAYMENT, ORDER_STATUS} from '../domain/order-lifecycle';
import {RETURN_REFUND, RETURN_REFUND_ATTEMPT, acceptsRefundResult, type ReturnRefundClaim, type ReturnRefundResult, type ReturnRefundRepository, type ReturnRefundReference} from '../domain/return-refund';
import {allocateReturnRefund, assertSameRefundAmounts} from '../domain/return-refund-policy';
import {DrizzleOrderReturnRepository} from './drizzle-order-return.repository';
import {latestReturnRefund} from './return-records';

const activeAttempts = [RETURN_REFUND_ATTEMPT.queued, RETURN_REFUND_ATTEMPT.pending];
const REFUND_QUEUE_ALIAS = 'return_refund_recovery';
@Injectable()
export class DrizzleReturnRefundRepository implements ReturnRefundRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  async claimRecoverable(): Promise<ReturnRefundClaim[]> {
    return this.database.db.transaction(async tx => {
      const queue = alias(orderReturnRefunds, REFUND_QUEUE_ALIAS);
      const rows = await tx.select({attempt: queue, order: orders}).from(queue)
        .innerJoin(orderReturns, eq(orderReturns.id, queue.returnId)).innerJoin(orders, eq(orders.id, orderReturns.orderId))
        .where(and(inArray(queue.state, activeAttempts), eq(orderReturns.status, RETURN_STATUS.refundPending), lte(queue.nextRecoveryAt, new Date())))
        .orderBy(asc(queue.nextRecoveryAt), asc(queue.id)).limit(RETURN_REFUND.recovery.batchSize)
        .for(ORDER_RETURN.persistence.lock, {of: queue, skipLocked: true});
      if (rows.length) await tx.update(orderReturnRefunds).set({nextRecoveryAt: new Date(Date.now() + RETURN_REFUND.recovery.leaseMilliseconds)})
        .where(inArray(orderReturnRefunds.id, rows.map(row => row.attempt.id)));
      return rows.map(({attempt, order}) => {
        if (!order.stripePaymentIntentId || order.paymentProvider !== ORDER_PAYMENT.provider || order.status !== ORDER_STATUS.delivered) throw new ConflictException(RETURN_REFUND.failure.unavailable);
        return {returnId: attempt.returnId, orderId: order.id, attemptId: attempt.id, paymentIntentId: order.stripePaymentIntentId,
          originalAmount: order.totalAmount, amount: attempt.amount, currency: order.currency, refundId: attempt.stripeRefundId};
      });
    });
  }
  async findAttempt(reference: ReturnRefundReference): Promise<ReturnRefundClaim> {
    const [row] = await this.database.db.select({attempt: orderReturnRefunds, order: orders}).from(orderReturnRefunds)
      .innerJoin(orderReturns, eq(orderReturns.id, orderReturnRefunds.returnId)).innerJoin(orders, eq(orders.id, orderReturns.orderId))
      .where(and(eq(orderReturnRefunds.id, reference.attemptId), eq(orderReturns.id, reference.returnId), eq(orders.id, reference.orderId))).limit(ORDER_RETURN.persistence.singleRow);
    if (!row || !row.order.stripePaymentIntentId || row.order.paymentProvider !== ORDER_PAYMENT.provider || (row.attempt.stripeRefundId !== null && row.attempt.stripeRefundId !== reference.refundId)) throw new ConflictException(RETURN_REFUND.failure.mismatch);
    return {orderId: row.order.id, returnId: row.attempt.returnId, attemptId: row.attempt.id, paymentIntentId: row.order.stripePaymentIntentId,
      originalAmount: row.order.totalAmount, amount: row.attempt.amount, currency: row.order.currency, refundId: reference.refundId};
  }
  async settle(claim: ReturnRefundClaim, result: ReturnRefundResult): Promise<boolean> {
    return this.database.db.transaction(async tx => {
      const database: DatabaseSession = {db: tx}, returns = new DrizzleOrderReturnRepository(database);
      const order = await returns.order(claim.orderId, true);
      const stored = await returns.find(claim.returnId, true);
      const [attempt] = await tx.select().from(orderReturnRefunds).where(eq(orderReturnRefunds.id, claim.attemptId)).limit(ORDER_RETURN.persistence.singleRow).for(ORDER_RETURN.persistence.lock);
      if (!order || !stored || !attempt || attempt.returnId !== claim.returnId || stored.document.orderId !== order.id || attempt.amount !== claim.amount || order.amounts.totalAmount !== claim.originalAmount || order.currency !== claim.currency || order.paymentIntentId !== claim.paymentIntentId || order.paymentProvider !== ORDER_PAYMENT.provider) throw new ConflictException(RETURN_REFUND.failure.mismatch);
      if ((attempt.stripeRefundId !== null && attempt.stripeRefundId !== result.refundId) || (claim.refundId !== null && claim.refundId !== result.refundId)) throw new ConflictException(RETURN_REFUND.failure.mismatch);
      if (!acceptsRefundResult(attempt.state as typeof RETURN_REFUND_ATTEMPT[keyof typeof RETURN_REFUND_ATTEMPT], result.state)) return false;
      const latest = await latestReturnRefund(database, claim.returnId);
      if (latest?.id !== attempt.id) throw new ConflictException(RETURN_REFUND.failure.mismatch);
      if (![RETURN_STATUS.refundPending, RETURN_STATUS.refunded].some(status => stored.document.status === status)
        || ![ORDER_STATUS.delivered, ORDER_STATUS.refunded].some(status => order.status === status) || stored.allocationNumber === null) throw new ConflictException(RETURN_REFUND.failure.mismatch);
      const now = new Date();
      const changed = attempt.state !== result.state || attempt.stripeRefundId !== result.refundId || attempt.providerStatus !== result.providerStatus;
      if (result.state === RETURN_REFUND.state.succeeded) {
        const previous = await returns.returnedQuantities(order.id, stored.allocationNumber);
        const plan = allocateReturnRefund(order.amounts, order.items, previous, stored.document.items), expected = stored.document.amounts;
        assertSameRefundAmounts(plan, expected);
        if (plan.totalAmount !== claim.amount) throw new ConflictException(ORDER_RETURN.failure.persisted);
        await new ReturnRefundFinancials(database).adjustCommissions(order, stored.document, new Map(previous.map(item => [item.orderItemId, item.quantity])), now);
      }
      await tx.update(orderReturnRefunds).set({state: result.state, stripeRefundId: result.refundId, providerStatus: result.providerStatus,
        nextRecoveryAt: new Date(now.getTime() + RETURN_REFUND.recovery.leaseMilliseconds), updatedAt: changed ? now : attempt.updatedAt}).where(eq(orderReturnRefunds.id, attempt.id));
      const failed = result.state === RETURN_REFUND.state.failed || result.state === RETURN_REFUND.state.blocked;
      if (changed) await tx.update(orderReturns).set({status: result.state === RETURN_REFUND.state.succeeded ? RETURN_STATUS.refunded : failed ? RETURN_STATUS.refundFailed : RETURN_STATUS.refundPending,
        // Commands are closed at the revision ceiling; provider facts must still be reconciled.
        version: Math.min(stored.document.version + ORDER_RETURN.revision.step, ORDER_RETURN.revision.maximum), updatedAt: now,
        refundedAt: result.state === RETURN_REFUND.state.succeeded ? now : null}).where(eq(orderReturns.id, claim.returnId));
      if (changed) await new ReturnRefundFinancials(database).reconcile(order, now);
      if (changed && (result.state === RETURN_REFUND.state.succeeded || failed)) {
        const status = result.state === RETURN_REFUND.state.succeeded ? RETURN_STATUS.refunded : RETURN_STATUS.refundFailed;
        await new DrizzleOrderNotifications(database).record(returnRefundNotification(order.id, claim.returnId, claim.attemptId, status), true);
      }
      return changed;
    });
  }
}

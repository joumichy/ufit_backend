import {ConflictException} from '@nestjs/common';
import {desc, eq} from 'drizzle-orm';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {orderReturnRefunds, type OrderReturnRow, type OrderReturnItemRow, type OrderReturnRefundRow} from '../../../shared/infrastructure/database/schema.returns';
import {ORDER_RETURN, RETURN_STATUS, type ReturnStatus} from '../domain/order-return.contract';
import type {ReturnDecision} from '../domain/order-return';
import type {StoredOrderReturn} from '../domain/order-return.repository';
import {RETURN_REFUND, RETURN_REFUND_ATTEMPT, type ReturnRefundAttemptState, type ReturnRefundProviderStatus} from '../domain/return-refund';

export async function latestReturnRefund(database: DatabaseSession, returnId: string): Promise<OrderReturnRefundRow | undefined> {
  const [row] = await database.db.select().from(orderReturnRefunds).where(eq(orderReturnRefunds.returnId, returnId))
    .orderBy(desc(orderReturnRefunds.attemptNumber)).limit(ORDER_RETURN.persistence.singleRow);
  return row;
}
export function projectReturnRecord(row: OrderReturnRow, brandId: string, items: OrderReturnItemRow[], refund: OrderReturnRefundRow | undefined): StoredOrderReturn {
  if (!Object.values(RETURN_STATUS).some(status => status === row.status) || row.refundPolicyCode !== ORDER_RETURN.policy.code || !items.length || items.some(item => item.orderId !== row.orderId || item.returnId !== row.id)) throw new ConflictException(ORDER_RETURN.failure.persisted);
  const received = row.receivedAt !== null;
  if (items.some(item => (item.restockQuantity !== null) !== received)) throw new ConflictException(ORDER_RETURN.failure.persisted);
  if ([RETURN_STATUS.refundPending, RETURN_STATUS.refundFailed, RETURN_STATUS.refunded].some(status => row.status === status) && !refund) throw new ConflictException(ORDER_RETURN.failure.persisted);
  if (refund && (!Object.values(RETURN_REFUND_ATTEMPT).some(state => state === refund.state) || (refund.providerStatus !== null && !Object.values(RETURN_REFUND.providerStatus).some(status => status === refund.providerStatus)))) throw new ConflictException(ORDER_RETURN.failure.persisted);
  return {requestId: row.requestId, requestFingerprint: row.requestFingerprint, returnPolicy: row.returnPolicy,
    refund: refund ? {attemptNumber: refund.attemptNumber, amount: refund.amount, state: refund.state as ReturnRefundAttemptState, providerStatus: refund.providerStatus as ReturnRefundProviderStatus | null, updatedAt: refund.updatedAt.toISOString()} : null,
    document: {id: row.id, orderId: row.orderId, brandId, version: row.version, status: row.status as ReturnStatus,
      reason: row.reason, items: items.map(item => ({orderItemId: item.orderItemId, quantity: item.quantity})),
      amounts: {refundPolicyCode: row.refundPolicyCode, merchandiseAmount: row.merchandiseAmount, taxAmount: row.taxAmount, shippingAmount: row.shippingAmount, totalAmount: row.totalAmount, completesOrder: row.completesOrder},
      requestedAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), deadline: row.deadline.toISOString(), refundedAt: row.refundedAt?.toISOString() ?? null,
      brandDecision: decision(row.brandDecision, row.brandReason, row.brandInstructions, row.brandDecidedAt),
      dispute: row.disputedAt ? {reason: row.disputeReason!, at: row.disputedAt.toISOString()} : null,
      adminDecision: decision(row.adminDecision, row.adminReason, row.adminInstructions, row.adminDecidedAt),
      tracking: row.sentAt ? {carrier: row.carrier!, trackingNumber: row.trackingNumber!, trackingUrl: row.trackingUrl, sentAt: row.sentAt.toISOString()} : null,
      reception: row.receivedAt ? {at: row.receivedAt.toISOString(), items: items.map(item => ({orderItemId: item.orderItemId, restockQuantity: item.restockQuantity!}))} : null,
    }};
}
function decision(status: string | null, reason: string | null, instructions: string | null, at: Date | null): ReturnDecision | null {
  if (status === null) return null;
  if ((status !== RETURN_STATUS.approved && status !== RETURN_STATUS.rejected) || !at) throw new ConflictException(ORDER_RETURN.failure.persisted);
  return {decision: status, reason, instructions, at: at.toISOString()};
}

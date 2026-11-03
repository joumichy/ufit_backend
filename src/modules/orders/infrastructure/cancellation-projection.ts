import {ConflictException} from '@nestjs/common';
import {CANCELLATION,CANCELLATION_REFUND} from '../domain/order-lifecycle';
import type {ExternalRefundSettlement} from '../domain/refund-proof-review';
import type {orderCancellations, orderCancellationRefunds} from '../../../shared/infrastructure/database/schema';
import type {CancellationProjection} from '../domain/order-lifecycle';

export function projectCancellationRefund(row: typeof orderCancellationRefunds.$inferSelect): NonNullable<CancellationProjection['refund']> {
  return {state: row.state as NonNullable<CancellationProjection['refund']>['state'], providerStatus: row.providerStatus as NonNullable<CancellationProjection['refund']>['providerStatus']};
}
export function projectCancellation(cancellation: typeof orderCancellations.$inferSelect, refund: typeof orderCancellationRefunds.$inferSelect|undefined,externalSettlement:ExternalRefundSettlement|null): CancellationProjection {
  if((cancellation.paymentOutcome===CANCELLATION.outcome.refundedExternally)!==(externalSettlement!==null)
    || (externalSettlement && (!cancellation.effectsApplied || cancellation.status!==CANCELLATION.status.succeeded)))throw new ConflictException(CANCELLATION_REFUND.failure.mismatch);
  return {id: cancellation.id,externalSettlement, status: cancellation.status as CancellationProjection['status'], reason: cancellation.reason as CancellationProjection['reason'],
    outcome: cancellation.paymentOutcome as CancellationProjection['outcome'], refund: refund ? projectCancellationRefund(refund) : null};
}

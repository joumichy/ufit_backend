import type {orderCancellations, orderCancellationRefunds} from '../../../shared/infrastructure/database/schema';
import type {CancellationProjection} from '../domain/order-lifecycle';

export function projectCancellationRefund(row: typeof orderCancellationRefunds.$inferSelect): NonNullable<CancellationProjection['refund']> {
  return {state: row.state as NonNullable<CancellationProjection['refund']>['state'], providerStatus: row.providerStatus as NonNullable<CancellationProjection['refund']>['providerStatus']};
}
export function projectCancellation(cancellation: typeof orderCancellations.$inferSelect, refund?: typeof orderCancellationRefunds.$inferSelect): CancellationProjection {
  return {status: cancellation.status as CancellationProjection['status'], reason: cancellation.reason as CancellationProjection['reason'],
    outcome: cancellation.paymentOutcome as CancellationProjection['outcome'], refund: refund ? projectCancellationRefund(refund) : null};
}

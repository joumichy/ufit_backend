import {z} from 'zod';
import {CURRENCY_CODES} from '../../../shared/domain/currencies';
import {captureReceiptSchema, paymentSettlementIDSchema} from './payment-settlement';

export const REFUND_SETTLEMENT = {
  repository: Symbol('RefundSettlementRepository'),
  state: {queued: 'queued', processing: 'processing', synced: 'synced', review: 'needs_review'},
  result: {observed: 'observed', retry: 'retry', review: 'review'},
  status: {succeeded: 'succeeded', pending: 'pending', action: 'requires_action', failed: 'failed', cancelled: 'canceled'},
  kind: {debit: 'refund', failure: 'refund_failure'},
  failure: {missing: 'refund_source_missing', changed: 'refund_source_changed', invalid: 'refund_settlement_invalid',
    pending: 'refund_balance_pending', unavailable: 'refund_provider_unavailable', linked: 'refund_balance_already_linked'},
  limits: {zero: 0, one: 1, maximum: 2_147_483_647, batch: 2, pollMs: 15_000, leaseMs: 120_000,
    firstRetryMs: 30_000, maximumRetryMs: 900_000, retryFactor: 2, millisecondsPerSecond: 1000, page: 100, timeoutMs: 10_000},
  provider: {refundPattern: /^re_[A-Za-z0-9]+$/, intentPattern: /^pi_[A-Za-z0-9]+$/, missing: 'resource_missing',
    refundObject: 'refund', chargeSucceeded: 'succeeded', referenceType: 'string',
    chargeExpansion: ['balance_transaction'], refundExpansion: ['data.balance_transaction', 'data.failure_balance_transaction']},
  route: {root: 'admin/payments', document: ':id/refund-settlement', synchronize: ':id/refund-settlement-sync', id: 'id'},
  event: {chargeRefunded: 'charge.refunded'},
  request: {invalid: {code: 'refund_settlement_request_invalid', message: 'Invalid refund settlement request'},
    missing: {code: 'refund_settlement_not_found', message: 'The capture receipt is not available'},
    access: {code: 'refund_settlement_access_required', message: 'Active administration access is required'},
    persisted: {code: 'refund_settlement_persisted_invalid', message: 'The refund settlement requires verification'}},
  validation: {snapshot: 'Refund observations must match their capture and balance movements'},
  cache: {header: 'Cache-Control', value: 'private, no-store'}, lock: 'update', accepted: 202,
} as const;
const C = REFUND_SETTLEMENT;
const nonnegative = z.number().int().min(C.limits.zero).max(C.limits.maximum);
const signed = z.number().int().min(-C.limits.maximum).max(C.limits.maximum);
const currency = z.enum(CURRENCY_CODES);
export const refundSourceSchema = z.object({paymentId: paymentSettlementIDSchema, orderId: paymentSettlementIDSchema,
  paymentIntentId: z.string().regex(C.provider.intentPattern), capture: captureReceiptSchema}).strict();
export type RefundSource = z.infer<typeof refundSourceSchema>;
export const refundBalanceSchema = z.object({id: captureReceiptSchema.shape.balanceTransactionId,
  refundId: z.string().regex(C.provider.refundPattern), kind: z.enum(Object.values(C.kind)),
  amount: signed, currency, feeAmount: signed, netAmount: signed, createdAt: z.iso.datetime(), availableAt: z.iso.datetime(),
}).strict().refine(value => BigInt(value.amount) - BigInt(value.feeAmount) === BigInt(value.netAmount)
  && (value.kind === C.kind.debit ? value.amount < C.limits.zero : value.amount > C.limits.zero), C.validation.snapshot);
export type RefundBalance = z.infer<typeof refundBalanceSchema>;
export const refundObservationSchema = z.object({refundId: z.string().regex(C.provider.refundPattern), amount: nonnegative.min(C.limits.one), currency,
  status: z.enum(Object.values(C.status)), createdAt: z.iso.datetime(), debit: refundBalanceSchema.nullable(), failure: refundBalanceSchema.nullable(),
}).strict().refine(value => (value.debit === null || value.debit.refundId === value.refundId && value.debit.kind === C.kind.debit)
  && (value.failure === null || value.debit !== null && value.failure.refundId === value.refundId && value.failure.kind === C.kind.failure
    && value.failure.id !== value.debit.id && (value.status === C.status.failed || value.status === C.status.cancelled)), C.validation.snapshot);
export type RefundObservation = z.infer<typeof refundObservationSchema>;
export const refundSnapshotSchema = z.object({source: refundSourceSchema, observedAt: z.iso.datetime(), amountRefunded: nonnegative,
  disputed: z.boolean(), items: z.array(refundObservationSchema),
}).strict().refine(value => {
  const ids = value.items.flatMap(row => [row.debit, row.failure].flatMap(balance => balance ? [balance.id] : []));
  const active = value.items.filter(row => row.status !== C.status.failed && row.status !== C.status.cancelled)
    .reduce((sum, row) => sum + BigInt(row.amount), BigInt(C.limits.zero));
  const movements = value.items.flatMap(row => [row.debit, row.failure].flatMap(balance => balance ? [balance] : []));
  const bounded = (field: 'amount' | 'feeAmount' | 'netAmount') => {
    const total = movements.reduce((sum, row) => sum + BigInt(row[field]), BigInt(C.limits.zero));
    return total >= BigInt(-C.limits.maximum) && total <= BigInt(C.limits.maximum);
  };
  return new Set(value.items.map(row => row.refundId)).size === value.items.length && new Set(ids).size === ids.length
    && value.amountRefunded <= value.source.capture.chargeAmount && active <= BigInt(value.source.capture.chargeAmount)
    && value.items.every(row => row.amount <= value.source.capture.chargeAmount && row.currency === value.source.capture.chargeCurrency
      && [row.debit, row.failure].every(balance => balance === null || balance.currency === value.source.capture.settlementCurrency))
    && bounded('amount') && bounded('feeAmount') && bounded('netAmount');
}, C.validation.snapshot);
export type RefundSnapshot = z.infer<typeof refundSnapshotSchema>;
export function refundSnapshotComplete(value: RefundSnapshot): boolean {
  const succeeded = value.items.filter(row => row.status === C.status.succeeded);
  return value.items.every(row => row.status === C.status.succeeded ? row.debit !== null && row.failure === null
    : (row.status === C.status.failed || row.status === C.status.cancelled) && (row.debit === null && row.failure === null || row.debit !== null && row.failure !== null))
    && succeeded.reduce((sum, row) => sum + BigInt(row.amount), BigInt(C.limits.zero)) === BigInt(value.amountRefunded);
}
export function refundBalanceTotals(value: RefundSnapshot) {
  const movements = value.items.flatMap(row => [row.debit, row.failure].flatMap(balance => balance ? [balance] : []));
  const total = (field: 'amount' | 'feeAmount' | 'netAmount') => Number(movements.reduce((sum, row) => sum + BigInt(row[field]), BigInt(C.limits.zero)));
  return {amount: total('amount'), feeAmount: total('feeAmount'), netAmount: total('netAmount')};
}
export type RefundReadResult = {kind: typeof C.result.observed; snapshot: RefundSnapshot}
  | {kind: typeof C.result.retry | typeof C.result.review; reason: typeof C.failure[keyof typeof C.failure]};
export interface RefundReservation {source: RefundSource; leaseToken: string; attempts: number; generation: number;}
export const refundDocumentSchema = z.object({source: refundSourceSchema, state: z.enum(Object.values(C.state)), asOf: z.iso.datetime(),
  generation: nonnegative.min(C.limits.one), observedGeneration: nonnegative, failureCode: z.enum(Object.values(C.failure)).nullable(),
  nextAttemptAt: z.iso.datetime().nullable(), snapshot: refundSnapshotSchema.safeExtend({id: paymentSettlementIDSchema,
    generation: nonnegative.min(C.limits.one), recordedAt: z.iso.datetime()}).nullable(),
}).strict().refine(value => value.observedGeneration <= value.generation && (value.state === C.state.queued) === (value.nextAttemptAt !== null)
  && (value.state !== C.state.review || value.failureCode !== null)
  && (value.snapshot === null ? value.observedGeneration === C.limits.zero : value.observedGeneration > C.limits.zero
    && value.snapshot.generation === value.observedGeneration && JSON.stringify(value.snapshot.source) === JSON.stringify(value.source))
  && (value.state !== C.state.synced || value.snapshot !== null && value.observedGeneration === value.generation && refundSnapshotComplete(value.snapshot)), C.validation.snapshot);
export type RefundDocument = z.infer<typeof refundDocumentSchema>;

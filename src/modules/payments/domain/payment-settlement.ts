import {z} from 'zod';
import {CURRENCY_CODES} from '../../../shared/domain/currencies';
import {ORDER_PAYMENT} from '../../orders/domain/order-lifecycle';

export const PAYMENT_SETTLEMENT = {
  repository: Symbol('PaymentSettlementRepository'),
  route: {root: 'admin/payments', document: ':id/settlement', synchronize: ':id/settlement-sync', id: 'id'},
  state: {notRequested: 'not_requested', queued: 'queued', processing: 'processing', recorded: 'recorded', needsReview: 'needs_review'},
  result: {receipt: 'receipt', retry: 'retry', review: 'review'},
  failure: {
    missing: 'stripe_capture_missing', mismatch: 'stripe_capture_mismatch', invalid: 'stripe_capture_invalid',
    balancePending: 'stripe_balance_pending', unavailable: 'stripe_temporarily_unavailable',
    linked: 'stripe_capture_already_linked', changed: 'payment_capture_changed',
  },
  requestFailure: {
    access: {code: 'payment_settlement_access_required', message: 'Active administration access is required'},
    missing: {code: 'payment_settlement_not_found', message: 'Payment not found'},
    invalid: {code: 'payment_settlement_invalid', message: 'Invalid payment settlement request'},
    unsupported: {code: 'payment_settlement_unsupported', message: 'This payment has no confirmed Stripe capture'},
    persisted: {code: 'payment_settlement_document_invalid', message: 'Stored payment settlement requires correction'},
  },
  provider: {
    succeeded: 'succeeded', charge: 'charge', missing: 'resource_missing', referenceType: 'string',
    expansion: ['latest_charge.balance_transaction'],
    chargePattern: /^ch_[A-Za-z0-9]+$/, transactionPattern: /^txn_[A-Za-z0-9]+$/,
  },
  limits: {zero: 0, one: 1, maximumAmount: 2_147_483_647, millisecondsPerSecond: 1_000,
    batch: 2, pollMs: 15_000, leaseMs: 120_000, firstRetryMs: 30_000, maximumRetryMs: 900_000, retryFactor: 2},
  cache: {header: 'Cache-Control', value: 'private, no-store'},
  lock: 'update', accepted: 202,
} as const;
const C = PAYMENT_SETTLEMENT;
const amount = z.number().int().min(C.limits.zero).max(C.limits.maximumAmount);
const currency = z.string().refine(value => CURRENCY_CODES.includes(value));
const failure = z.enum(Object.values(C.failure));
export const paymentSettlementIDSchema = z.uuid().toLowerCase();
export const paymentSettlementSyncSchema = z.object({}).strict();
export const captureReceiptSchema = z.object({
  chargeId: z.string().regex(C.provider.chargePattern), balanceTransactionId: z.string().regex(C.provider.transactionPattern),
  chargeAmount: amount.min(C.limits.one), chargeCurrency: currency,
  settlementAmount: amount.min(C.limits.one), settlementCurrency: currency, feeAmount: amount,
  netAmount: z.number().int().min(-C.limits.maximumAmount).max(C.limits.maximumAmount),
  capturedAt: z.iso.datetime(), availableAt: z.iso.datetime(), liveMode: z.boolean(),
}).strict().refine(value => value.settlementAmount - value.feeAmount === value.netAmount);
export type CaptureReceipt = z.infer<typeof captureReceiptSchema>;
export const settlementPaymentSchema = z.object({id: z.uuid(), orderId: z.uuid(), orderNumber: z.string().trim().min(C.limits.one),
  status: z.enum(Object.values(ORDER_PAYMENT.status)), amount: amount.min(C.limits.one), currency,
  providerPaymentIntentId: z.string().trim().min(C.limits.one), createdAt: z.iso.datetime()}).strict();
export type SettlementPayment = z.infer<typeof settlementPaymentSchema>;
export const paymentSettlementDocumentSchema = z.object({
  payment: settlementPaymentSchema, state: z.enum(Object.values(C.state)), asOf: z.iso.datetime(),
  receipt: captureReceiptSchema.safeExtend({recordedAt: z.iso.datetime()}).nullable(),
  failureCode: failure.nullable(), nextAttemptAt: z.iso.datetime().nullable(),
}).strict().refine(value => (value.state === C.state.recorded) === (value.receipt !== null)
  && (value.state !== C.state.needsReview || value.failureCode !== null)
  && (value.failureCode === null || value.state === C.state.queued || value.state === C.state.needsReview)
  && (value.state === C.state.queued) === (value.nextAttemptAt !== null)
  && (value.receipt === null || value.receipt.chargeAmount === value.payment.amount && value.receipt.chargeCurrency === value.payment.currency));
export type PaymentSettlementDocument = z.infer<typeof paymentSettlementDocumentSchema>;
export type CaptureReadResult = {kind: typeof C.result.receipt; receipt: CaptureReceipt}
  | {kind: typeof C.result.retry | typeof C.result.review; reason: z.infer<typeof failure>};
export interface CaptureReservation {payment: SettlementPayment; leaseToken: string; attempts: number;}

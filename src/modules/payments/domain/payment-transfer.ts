import {z} from 'zod';
import {CURRENCY_CODES} from '../../../shared/domain/currencies';
import {CONNECT, type ConnectAccountRecord} from './connect-account';
import {PAYMENT_ALLOCATION, allocationIDSchema, allocationStoredPlanSchema, allocationRecipientKey, type StoredAllocationPlan} from './payment-allocation';
import {captureReceiptSchema, type CaptureReceipt} from './payment-settlement';
import {refundSnapshotSchema, refundSnapshotComplete, type RefundSnapshot} from './refund-settlement';

export const PAYMENT_TRANSFER = {
  zero: 0, one: 1, maximumAmount: 2_147_483_647,
  kind: {brand: 'brand', creator: 'creator'},
  funding: {charge: 'charge', balance: 'available_balance'},
  result: {found: 'found', absent: 'absent', recorded: 'recorded', blocked: 'blocked', retry: 'retry', review: 'review'},
  reason: {
    invalid: 'transfer_instruction_invalid', unavailable: 'transfer_provider_unavailable', mismatch: 'transfer_provider_mismatch',
    mode: 'transfer_mode_mismatch', account: 'transfer_account_incomplete', capture: 'transfer_capture_changed',
    refund: 'transfer_refund_open', dispute: 'transfer_disputed', remaining: 'transfer_reversal_exceeds_remaining',
    local: 'transfer_local_state_unavailable', delivery: 'transfer_awaiting_delivery', returnWindow: 'transfer_return_window',
    returnOpen: 'transfer_return_open', cancellation: 'transfer_cancellation_open', profile: 'transfer_profile_inactive',
    adjustment: 'transfer_adjustment_pending', stale: 'transfer_instruction_superseded',
    arm: 'transfer_execution_not_armed', uncertain: 'transfer_creation_unconfirmed',
  },
  validation: {instruction: 'The transfer must match its frozen allocation and capture', receipt: 'The transfer receipt is inconsistent'},
  provider: {
    transferPrefix: 'tr_', reversalPrefix: 'trr_', intentPrefix: 'pi_', accountPrefix: 'acct_',
    transferObject: 'transfer', reversalObject: 'transfer_reversal', referenceType: 'string',
    identifierPattern: /^[A-Za-z0-9_]+$/, missing: 'resource_missing',
    balanceType: 'charge', succeeded: 'succeeded', failedRefund: 'failed', cancelledRefund: 'canceled',
    pageLimit: 100, timeoutMs: 10_000, networkRetries: 0, millisecondsPerSecond: 1000,
    groupPrefix: 'order:', transferKeyPrefix: 'ufit-transfer:', reversalKeyPrefix: 'ufit-transfer-reversal:',
    metadata: {operation: 'ufit_transfer_operation_id', payment: 'ufit_payment_id', allocation: 'ufit_allocation_key', funding: 'ufit_transfer_funding', reversal: 'ufit_reversal_operation_id'},
    expansion: ['balance_transaction'],
  },
} as const;
const C = PAYMENT_TRANSFER;
const positive = z.number().int().min(C.one).max(C.maximumAmount);
const nonnegative = z.number().int().min(C.zero).max(C.maximumAmount);
const providerID = (prefix: string) => z.string().startsWith(prefix).min(prefix.length + C.one).regex(C.provider.identifierPattern);
const recipient = z.discriminatedUnion('kind', [
  z.object({kind: z.literal(C.kind.brand), beneficiaryId: allocationIDSchema}).strict(),
  z.object({kind: z.literal(C.kind.creator), beneficiaryId: allocationIDSchema, commissionId: allocationIDSchema}).strict(),
]);
export const transferInstructionSchema = z.object({
  id: allocationIDSchema, paymentId: allocationIDSchema, orderId: allocationIDSchema,
  paymentIntentId: providerID(C.provider.intentPrefix), allocationKey: z.string().nonempty(), recipient,
  amount: positive, currency: z.enum(CURRENCY_CODES), capture: captureReceiptSchema,
  funding: z.enum(Object.values(C.funding)), refunds: refundSnapshotSchema,
  account: z.object({id: allocationIDSchema, kind: z.enum(Object.values(C.kind)), profileId: allocationIDSchema,
    country: z.string().regex(CONNECT.countryPattern), liveMode: z.boolean(), stripeAccountId: providerID(C.provider.accountPrefix)}).strict(),
}).strict().refine(value => value.allocationKey === allocationRecipientKey(value.recipient)
  && value.account.kind === value.recipient.kind && value.account.profileId === value.recipient.beneficiaryId
  && value.account.liveMode === value.capture.liveMode && value.currency === value.capture.settlementCurrency
  && refundSnapshotComplete(value.refunds) && !value.refunds.disputed
  && value.refunds.source.paymentId === value.paymentId && value.refunds.source.orderId === value.orderId
  && value.refunds.source.paymentIntentId === value.paymentIntentId
  && JSON.stringify(value.refunds.source.capture) === JSON.stringify(value.capture), C.validation.instruction);
export type TransferInstruction = z.infer<typeof transferInstructionSchema>;

/** Called from the durable owner, never from a client-provided amount. */
export function makeTransferInstruction(id: string, paymentIntentId: string, plan: StoredAllocationPlan,
  capture: CaptureReceipt, allocationKey: string, account: ConnectAccountRecord, refunds: RefundSnapshot): TransferInstruction {
  plan = allocationStoredPlanSchema.parse(plan);
  capture = captureReceiptSchema.parse(capture);
  const line = plan.lines.find(row => allocationRecipientKey(row.recipient) === allocationKey);
  if (refunds.amountRefunded !== C.zero || refunds.items.length !== C.zero || !line || line.recipient.kind === PAYMENT_ALLOCATION.kind.platform || plan.lines.some(row => row.netAmount < C.zero)
    || plan.chargeId !== capture.chargeId || plan.balanceTransactionId !== capture.balanceTransactionId
    || plan.presentmentAmount !== capture.chargeAmount || plan.presentmentCurrency !== capture.chargeCurrency
    || plan.settlementAmount !== capture.settlementAmount || plan.settlementCurrency !== capture.settlementCurrency
    || plan.feeAmount !== capture.feeAmount || plan.netAmount !== capture.netAmount) throw new Error(C.reason.invalid);
  // Snapshot is deliberately excluded: eligibility must be reread, not copied from onboarding.
  const {snapshot, ...reference} = account;
  return transferInstructionSchema.parse({id, paymentId: plan.paymentId, orderId: plan.orderId, paymentIntentId,
    allocationKey, recipient: line.recipient, amount: line.netAmount, currency: plan.settlementCurrency, capture, funding: C.funding.charge, refunds, account: reference});
}
export const transferSnapshotSchema = z.object({
  id: providerID(C.provider.transferPrefix), amount: positive, currency: z.enum(CURRENCY_CODES),
  destination: providerID(C.provider.accountPrefix), sourceChargeId: captureReceiptSchema.shape.chargeId.nullable(),
  transferGroup: z.string().nonempty(), liveMode: z.boolean(), createdAt: z.iso.datetime(), reversedAmount: nonnegative,
}).strict().refine(value => value.reversedAmount <= value.amount, C.validation.receipt);
export type TransferSnapshot = z.infer<typeof transferSnapshotSchema>;
export const reversalInstructionSchema = z.object({
  id: allocationIDSchema, original: transferInstructionSchema, transferId: providerID(C.provider.transferPrefix), amount: positive,
  expectedReversedAmount: nonnegative,
}).strict().refine(value => BigInt(value.amount) + BigInt(value.expectedReversedAmount) <= BigInt(value.original.amount)
  && value.id !== value.original.id, C.validation.instruction);
export type ReversalInstruction = z.infer<typeof reversalInstructionSchema>;
export const reversalSnapshotSchema = z.object({id: providerID(C.provider.reversalPrefix), transferId: providerID(C.provider.transferPrefix),
  amount: positive, currency: z.enum(CURRENCY_CODES), createdAt: z.iso.datetime()}).strict();
export type ReversalSnapshot = z.infer<typeof reversalSnapshotSchema>;
export type TransferReason = typeof C.reason[keyof typeof C.reason];
export type TransferFailure = {kind: typeof C.result.retry | typeof C.result.review; reason: TransferReason};
export type TransferRead<T> = {kind: typeof C.result.found; snapshot: T} | {kind: typeof C.result.absent} | TransferFailure;
export type TransferExecution<T> = {kind: typeof C.result.recorded; snapshot: T}
  | {kind: typeof C.result.blocked; reason: TransferReason} | TransferFailure;
export const transferAuthorizationSchema = z.discriminatedUnion('allowed', [z.object({allowed: z.literal(true)}).strict(),
  z.object({allowed: z.literal(false), reason: z.enum(Object.values(C.reason))}).strict()]);
export type TransferAuthorization = z.infer<typeof transferAuthorizationSchema>;
export type RevalidateTransfer = () => Promise<TransferAuthorization>;
export function transferGroup(instruction: TransferInstruction): string { return C.provider.groupPrefix + instruction.orderId; }
export function transferMetadata(instruction: TransferInstruction): Record<string, string> {
  return {[C.provider.metadata.operation]: instruction.id, [C.provider.metadata.payment]: instruction.paymentId,
    [C.provider.metadata.allocation]: instruction.allocationKey, [C.provider.metadata.funding]: instruction.funding};
}

/** Compare financial observations, not the time or ordering of their independent reads. */
export function sameTransferRefunds(left: RefundSnapshot, right: RefundSnapshot): boolean {
  const canonical = (value: RefundSnapshot) => ({source: value.source, amountRefunded: value.amountRefunded, disputed: value.disputed,
    items: [...value.items].sort((a, b) => a.refundId.localeCompare(b.refundId))});
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

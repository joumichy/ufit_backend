import {z} from 'zod';
import {CURRENCY_CODES} from '../../../shared/domain/currencies';
import {captureReceiptSchema} from './payment-settlement';
import {PAYMENT_DISTRIBUTION, platformCommissionAmount} from './payment-distribution';

export const PAYMENT_ALLOCATION = {
  repository: Symbol('PaymentAllocationRepository'),
  algorithm: 'source_gross_largest_remainder_v1',
  kind: {brand: 'brand', creator: 'creator', platform: 'platform'},
  state: {notPrepared: 'not_prepared', blocked: 'blocked', recorded: 'recorded'},
  block: {terms: 'purchased_terms_missing', settlement: 'capture_receipt_missing', fulfillment: 'fulfillment_missing', basis: 'allocation_basis_invalid'},
  route: {root: 'admin/payments', document: ':id/allocation', prepare: ':id/allocation-prepare', id: 'id'},
  limit: {zero: 0, one: 1, maximum: 2_147_483_647},
  key: {separator: '/', platform: 'platform'},
  failure: {
    access: {code: 'payment_allocation_access_required', message: 'Active administration access is required'},
    input: {code: 'payment_allocation_request_invalid', message: 'Invalid payment allocation request'},
    missing: {code: 'payment_allocation_missing', message: 'Payment not found'},
    unavailable: {code: 'payment_allocation_unavailable', message: 'The payment allocation sources are incomplete'},
    persisted: {code: 'payment_allocation_persisted_invalid', message: 'The recorded allocation requires verification'},
  },
  cache: {header: 'Cache-Control', value: 'private, no-store'},
  lock: 'update', success: 200,
  validation: {sum: 'Allocation totals do not match their source', recipients: 'Allocation recipients are inconsistent'},
} as const;
const C = PAYMENT_ALLOCATION;
export const allocationIDSchema = z.uuid().toLowerCase();
export const allocationPrepareSchema = z.object({}).strict();
const amount = z.number().int().min(C.limit.zero).max(C.limit.maximum);
const signedAmount = z.number().int().min(-C.limit.maximum).max(C.limit.maximum);
const currency = z.enum(CURRENCY_CODES);
const recipient = z.discriminatedUnion('kind', [
  z.object({kind: z.literal(C.kind.brand), beneficiaryId: allocationIDSchema}).strict(),
  z.object({kind: z.literal(C.kind.creator), beneficiaryId: allocationIDSchema, commissionId: allocationIDSchema}).strict(),
  z.object({kind: z.literal(C.kind.platform), beneficiaryId: z.null()}).strict(),
]);
export type AllocationRecipient = z.infer<typeof recipient>;
export const allocationBasisSchema = z.object({
  paymentId: allocationIDSchema, orderId: allocationIDSchema, brandId: allocationIDSchema,
  policyId: allocationIDSchema, platformRateBps: amount.max(PAYMENT_DISTRIBUTION.limits.basisPoints),
  feeBearer: z.enum(Object.values(PAYMENT_DISTRIBUTION.feeBearer)),
  subtotal: amount, shipping: amount, tax: amount, total: amount.min(C.limit.one), currency,
  creatorCommissions: z.array(z.object({creatorId: allocationIDSchema, commissionId: allocationIDSchema, amount}).strict()), receipt: captureReceiptSchema,
}).strict().refine(value => BigInt(value.subtotal) + BigInt(value.shipping) + BigInt(value.tax) === BigInt(value.total)
  && value.receipt.chargeAmount === value.total && value.receipt.chargeCurrency === value.currency
  && (value.receipt.chargeCurrency !== value.receipt.settlementCurrency || value.receipt.settlementAmount === value.total)
  && new Set(value.creatorCommissions.map(row => row.commissionId)).size === value.creatorCommissions.length, C.validation.sum);
export type AllocationBasis = z.infer<typeof allocationBasisSchema>;
export const allocationLineSchema = z.object({
  recipient, presentmentAmount: amount, grossAmount: amount, feeAmount: amount, netAmount: signedAmount,
}).strict().refine(value => value.grossAmount - value.feeAmount === value.netAmount, C.validation.sum);
export type AllocationLine = z.infer<typeof allocationLineSchema>;
export const allocationPlanSchema = z.object({
  paymentId: allocationIDSchema, orderId: allocationIDSchema, brandId: allocationIDSchema, policyId: allocationIDSchema,
  algorithm: z.literal(C.algorithm), chargeId: captureReceiptSchema.shape.chargeId,
  balanceTransactionId: captureReceiptSchema.shape.balanceTransactionId,
  presentmentAmount: amount.min(C.limit.one), presentmentCurrency: currency,
  settlementAmount: amount.min(C.limit.one), settlementCurrency: currency, feeAmount: amount, netAmount: signedAmount,
  feeBearer: z.enum(Object.values(PAYMENT_DISTRIBUTION.feeBearer)), lines: z.array(allocationLineSchema),
}).strict().refine(value => {
  const sum = (field: keyof Pick<AllocationLine, 'presentmentAmount' | 'grossAmount' | 'feeAmount' | 'netAmount'>) =>
    value.lines.reduce((total, line) => total + BigInt(line[field]), BigInt(C.limit.zero));
  const kinds = C.kind;
  const balanced = sum('presentmentAmount') === BigInt(value.presentmentAmount) && sum('grossAmount') === BigInt(value.settlementAmount)
    && sum('feeAmount') === BigInt(value.feeAmount) && sum('netAmount') === BigInt(value.netAmount)
    && value.settlementAmount - value.feeAmount === value.netAmount
    && value.lines.filter(line => line.recipient.kind === kinds.platform).length === C.limit.one
    && value.lines.filter(line => line.recipient.kind === kinds.brand).length === C.limit.one
    && value.lines.every(line => line.recipient.kind !== kinds.brand || line.recipient.beneficiaryId === value.brandId)
    && new Set(value.lines.map(line => allocationRecipientKey(line.recipient))).size === value.lines.length
    && new Set(value.lines.flatMap(line => line.recipient.kind === kinds.creator ? [line.recipient.commissionId] : [])).size === value.lines.filter(line => line.recipient.kind === kinds.creator).length
    && value.lines.every(line => line.feeAmount === (line.recipient.kind === value.feeBearer ? value.feeAmount : C.limit.zero));
  if (!balanced) return false;
  const settled = apportionSettlement(value.lines, value.presentmentAmount, value.settlementAmount);
  return value.lines.every(line => line.grossAmount === settled.get(allocationRecipientKey(line.recipient)));
}, C.validation.recipients);
export type AllocationPlan = z.infer<typeof allocationPlanSchema>;
export const allocationStoredPlanSchema = allocationPlanSchema.safeExtend({createdAt: z.iso.datetime()});
export type StoredAllocationPlan = z.infer<typeof allocationStoredPlanSchema>;
export const allocationDocumentSchema = z.object({
  paymentId: allocationIDSchema, orderId: allocationIDSchema, asOf: z.iso.datetime(),
  state: z.enum(Object.values(C.state)), blockReason: z.enum(Object.values(C.block)).nullable(), plan: allocationStoredPlanSchema.nullable(),
}).strict().refine(value => (value.state === C.state.recorded) === (value.plan !== null)
  && (value.state === C.state.blocked) === (value.blockReason !== null)
  && (value.plan === null || value.plan.paymentId === value.paymentId && value.plan.orderId === value.orderId), C.validation.sum);
export type AllocationDocument = z.infer<typeof allocationDocumentSchema>;
export function allocationRecipientKey(value: AllocationRecipient): string {
  const key = value.kind === C.kind.platform ? C.key.platform : value.kind + C.key.separator + value.beneficiaryId;
  return value.kind === C.kind.creator ? key + C.key.separator + value.commissionId : key;
}
export function calculatePaymentAllocation(raw: AllocationBasis): AllocationPlan {
  const basis = allocationBasisSchema.parse(raw), zero = BigInt(C.limit.zero);
  const creatorTotal = basis.creatorCommissions.reduce((sum, row) => sum + BigInt(row.amount), zero);
  if (creatorTotal > BigInt(basis.subtotal)) throw new Error(C.failure.persisted.code);
  const platform = platformCommissionAmount(basis.subtotal, Number(creatorTotal), basis.platformRateBps);
  const shares: Array<{recipient: AllocationRecipient; presentmentAmount: number}> = [
    {recipient: {kind: C.kind.brand, beneficiaryId: basis.brandId}, presentmentAmount: basis.total - platform - Number(creatorTotal)},
    ...basis.creatorCommissions.map(row => ({recipient: {kind: C.kind.creator, beneficiaryId: row.creatorId, commissionId: row.commissionId} as const, presentmentAmount: row.amount})),
    {recipient: {kind: C.kind.platform, beneficiaryId: null}, presentmentAmount: platform},
  ];
  const settled = apportionSettlement(shares, basis.total, basis.receipt.settlementAmount);
  const lines = shares.map((row): AllocationLine => {
    const grossAmount = settled.get(allocationRecipientKey(row.recipient))!;
    const feeAmount = row.recipient.kind === basis.feeBearer ? basis.receipt.feeAmount : C.limit.zero;
    return {...row, grossAmount, feeAmount, netAmount: grossAmount - feeAmount};
  }).sort((left, right) => compareKeys(allocationRecipientKey(left.recipient), allocationRecipientKey(right.recipient)));
  return allocationPlanSchema.parse({paymentId: basis.paymentId, orderId: basis.orderId, brandId: basis.brandId,
    policyId: basis.policyId, algorithm: C.algorithm, chargeId: basis.receipt.chargeId, balanceTransactionId: basis.receipt.balanceTransactionId,
    presentmentAmount: basis.total, presentmentCurrency: basis.currency, settlementAmount: basis.receipt.settlementAmount,
    settlementCurrency: basis.receipt.settlementCurrency, feeAmount: basis.receipt.feeAmount, netAmount: basis.receipt.netAmount,
    feeBearer: basis.feeBearer, lines});
}
function apportionSettlement(shares: ReadonlyArray<{recipient: AllocationRecipient; presentmentAmount: number}>, total: number, settlement: number): Map<string, number> {
  const denominator = BigInt(total), gross = BigInt(settlement), zero = BigInt(C.limit.zero), one = BigInt(C.limit.one);
  const quotas = shares.map(share => ({key: allocationRecipientKey(share.recipient),
    amountFloor: BigInt(share.presentmentAmount) * gross / denominator, remainder: BigInt(share.presentmentAmount) * gross % denominator}));
  const remainder = gross - quotas.reduce((sum, row) => sum + row.amountFloor, zero);
  // Stable identities decide equal fractional remainders; input/DB row order never does.
  quotas.sort((left, right) => left.remainder === right.remainder ? compareKeys(left.key, right.key) : left.remainder > right.remainder ? -C.limit.one : C.limit.one);
  return new Map(quotas.map((row, index) => [row.key, Number(row.amountFloor + (BigInt(index) < remainder ? one : zero))]));
}
function compareKeys(left: string, right: string): number { return left < right ? -C.limit.one : left > right ? C.limit.one : C.limit.zero; }

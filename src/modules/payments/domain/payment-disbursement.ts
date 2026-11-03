import {z} from 'zod';
import {PAYMENT_ALLOCATION, allocationIDSchema, allocationStoredPlanSchema, allocationRecipientKey, type AllocationLine} from './payment-allocation';
import {platformCommissionAmount, PAYMENT_DISTRIBUTION, DistributionBudgetExceeded} from './payment-distribution';
import {REFUND_SETTLEMENT, refundDocumentSchema, refundSnapshotComplete, refundBalanceTotals} from './refund-settlement';

export const PAYMENT_DISBURSEMENT = {
  algorithm: 'original_share_cumulative_return_v1',
  phase: {reserved: 'return_reservation', settled: 'settled', review: 'needs_review'},
  reason: {sources: 'disbursement_sources_invalid', unmatchedRefund: 'disbursement_refunds_unmatched',
    missingRefund: 'disbursement_refund_observation_missing',
    refundReading: 'disbursement_refund_read_pending', refundOutstanding: 'disbursement_refund_outstanding'},
  zero: 0, one: 1, maximum: 2_147_483_647,
  validation: {basis: 'Disbursement facts must match their frozen allocation', targets: 'Disbursement amounts must conserve actual source money'},
} as const;
const C = PAYMENT_DISBURSEMENT;
const amount = z.number().int().min(C.zero).max(C.maximum);
const signed = z.number().int().min(-C.maximum).max(C.maximum);
export const disbursementBasisSchema = z.object({
  plan: allocationStoredPlanSchema, subtotal: amount, platformRateBps: amount.max(PAYMENT_DISTRIBUTION.limits.basisPoints),
  refunds: refundDocumentSchema, merchandiseRemaining: amount, refundLiability: amount,
  remainingCommissions: z.array(z.object({commissionId: allocationIDSchema, amount}).strict()),
  expectedStripeRefunds: z.array(z.object({refundId: z.string().regex(REFUND_SETTLEMENT.provider.refundPattern), amount: amount.min(C.one)}).strict()),
  refundOutstanding: z.boolean(),
}).strict().refine(value => {
  const plan = value.plan, source = value.refunds.source, capture = source.capture;
  const creators = plan.lines.filter(line => line.recipient.kind === PAYMENT_ALLOCATION.kind.creator);
  const creatorAmount = creators.reduce((sum, line) => sum + BigInt(line.presentmentAmount), BigInt(C.zero));
  const platform = plan.lines.find(line => line.recipient.kind === PAYMENT_ALLOCATION.kind.platform);
  return source.paymentId === plan.paymentId && source.orderId === plan.orderId
    && capture.chargeId === plan.chargeId && capture.balanceTransactionId === plan.balanceTransactionId
    && capture.chargeAmount === plan.presentmentAmount && capture.chargeCurrency === plan.presentmentCurrency
    && capture.settlementAmount === plan.settlementAmount && capture.settlementCurrency === plan.settlementCurrency
    && capture.feeAmount === plan.feeAmount && capture.netAmount === plan.netAmount
    && value.subtotal <= plan.presentmentAmount && value.merchandiseRemaining <= value.subtotal && value.refundLiability <= plan.presentmentAmount
    && platform?.presentmentAmount === platformCommissionAmount(value.subtotal, Number(creatorAmount), value.platformRateBps)
    && new Set(value.remainingCommissions.map(row => row.commissionId)).size === value.remainingCommissions.length
    && creators.length === value.remainingCommissions.length && creators.every(line => line.recipient.kind === PAYMENT_ALLOCATION.kind.creator
      && value.remainingCommissions.some(row => line.recipient.kind === PAYMENT_ALLOCATION.kind.creator && row.commissionId === line.recipient.commissionId && row.amount <= line.presentmentAmount))
    && new Set(value.expectedStripeRefunds.map(row => row.refundId)).size === value.expectedStripeRefunds.length
    && value.expectedStripeRefunds.reduce((sum, row) => sum + BigInt(row.amount), BigInt(C.zero)) <= BigInt(value.refundLiability);
}, C.validation.basis);
export type DisbursementBasis = z.infer<typeof disbursementBasisSchema>;
export const disbursementLineSchema = z.object({key: z.string().nonempty(), recipient: allocationStoredPlanSchema.shape.lines.element.shape.recipient,
  remainingPurchaseAmount: amount, grossAmount: signed, feeAmount: signed, netAmount: signed,
}).strict().refine(value => value.key === allocationRecipientKey(value.recipient)
  && BigInt(value.grossAmount) - BigInt(value.feeAmount) === BigInt(value.netAmount), C.validation.targets);
export type DisbursementLine = z.infer<typeof disbursementLineSchema>;
const targetFields = {
  algorithm: z.literal(C.algorithm), paymentId: allocationIDSchema, orderId: allocationIDSchema, brandId: allocationIDSchema, policyId: allocationIDSchema,
  currency: allocationStoredPlanSchema.shape.settlementCurrency, purchaseCurrency: allocationStoredPlanSchema.shape.presentmentCurrency,
  lines: z.array(disbursementLineSchema),
};
export const disbursementAssessmentSchema = z.discriminatedUnion('phase', [
  z.object({...targetFields, phase: z.literal(C.phase.reserved), reason: z.enum([C.reason.refundReading, C.reason.refundOutstanding])}).strict(),
  z.object({...targetFields, phase: z.literal(C.phase.settled), refundScanId: allocationIDSchema,
    sourceGrossAmount: signed, sourceFeeAmount: signed, sourceNetAmount: signed}).strict(),
  z.object({phase: z.literal(C.phase.review), reason: z.enum([C.reason.sources, C.reason.unmatchedRefund, C.reason.missingRefund])}).strict(),
]).refine(value => {
  if (value.phase === C.phase.review) return true;
  if (new Set(value.lines.map(line => line.key)).size !== value.lines.length
    || value.lines.filter(line => line.recipient.kind === PAYMENT_ALLOCATION.kind.brand).length !== C.one
    || value.lines.filter(line => line.recipient.kind === PAYMENT_ALLOCATION.kind.platform).length !== C.one
    || value.lines.some(line => line.recipient.kind === PAYMENT_ALLOCATION.kind.brand && line.recipient.beneficiaryId !== value.brandId)) return false;
  if (value.phase === C.phase.reserved) return true;
  const sum = (field: 'grossAmount' | 'feeAmount' | 'netAmount') => value.lines.reduce((total, line) => total + BigInt(line[field]), BigInt(C.zero));
  return sum('grossAmount') === BigInt(value.sourceGrossAmount) && sum('feeAmount') === BigInt(value.sourceFeeAmount)
    && sum('netAmount') === BigInt(value.sourceNetAmount) && BigInt(value.sourceGrossAmount) - BigInt(value.sourceFeeAmount) === BigInt(value.sourceNetAmount);
}, C.validation.targets);
export type DisbursementAssessment = z.infer<typeof disbursementAssessmentSchema>;

/** A cumulative reversal returns only whole source-currency units; the last return recovers the exact original share. */
function retainedGross(line: AllocationLine, remaining: number): number {
  if (remaining < C.zero || remaining > line.presentmentAmount) throw new Error(C.reason.sources);
  if (line.presentmentAmount === C.zero) {
    if (line.grossAmount !== C.zero) throw new Error(C.reason.sources);
    return C.zero;
  }
  const reversed = BigInt(line.grossAmount) * BigInt(line.presentmentAmount - remaining) / BigInt(line.presentmentAmount);
  return line.grossAmount - Number(reversed);
}
export function calculateDisbursement(raw: DisbursementBasis): DisbursementAssessment {
  try {
    const basis = disbursementBasisSchema.parse(raw), plan = basis.plan;
    const original = plan.lines, zero = BigInt(C.zero);
    const creatorRemaining = basis.remainingCommissions.reduce((sum, row) => sum + BigInt(row.amount), zero);
    const platformRemaining = platformCommissionAmount(basis.merchandiseRemaining, Number(creatorRemaining), basis.platformRateBps);
    const brandRemaining = plan.presentmentAmount - basis.refundLiability - Number(creatorRemaining) - platformRemaining;
    if (brandRemaining < C.zero) return {phase: C.phase.review, reason: C.reason.sources};
    const remaining = (line: AllocationLine): number => line.recipient.kind === PAYMENT_ALLOCATION.kind.platform ? platformRemaining
      : line.recipient.kind === PAYMENT_ALLOCATION.kind.brand ? brandRemaining
      : basis.remainingCommissions.find(row => line.recipient.kind === PAYMENT_ALLOCATION.kind.creator && row.commissionId === line.recipient.commissionId)!.amount;
    const snapshot = basis.refunds.snapshot;
    const settled = !basis.refundOutstanding && basis.refunds.state === REFUND_SETTLEMENT.state.synced && snapshot !== null && refundSnapshotComplete(snapshot);
    if (settled) {
      const succeeded = snapshot.items.filter(row => row.status === REFUND_SETTLEMENT.status.succeeded);
      if (!succeeded.every(row => basis.expectedStripeRefunds.some(expected => expected.refundId === row.refundId && expected.amount === row.amount))) {
        return {phase: C.phase.review, reason: C.reason.unmatchedRefund};
      }
      if (succeeded.length !== basis.expectedStripeRefunds.length) return {phase: C.phase.review, reason: C.reason.missingRefund};
    }
    const movements = settled ? refundBalanceTotals(snapshot!) : {amount: C.zero, feeAmount: C.zero, netAmount: C.zero};
    const gross = plan.settlementAmount + movements.amount, fee = plan.feeAmount + movements.feeAmount, net = plan.netAmount + movements.netAmount;
    const retainedOthers = original.filter(line => line.recipient.kind !== PAYMENT_ALLOCATION.kind.brand)
      .reduce((sum, line) => sum + BigInt(retainedGross(line, remaining(line))), zero);
    const lines = original.map((line): DisbursementLine => {
      const grossAmount = settled && line.recipient.kind === PAYMENT_ALLOCATION.kind.brand ? Number(BigInt(gross) - retainedOthers) : retainedGross(line, remaining(line));
      const feeAmount = line.recipient.kind === plan.feeBearer ? fee : C.zero;
      return {key: allocationRecipientKey(line.recipient), recipient: line.recipient, remainingPurchaseAmount: remaining(line), grossAmount,
        feeAmount, netAmount: grossAmount - feeAmount};
    });
    const common = {algorithm: C.algorithm, paymentId: plan.paymentId, orderId: plan.orderId, brandId: plan.brandId, policyId: plan.policyId, currency: plan.settlementCurrency,
      purchaseCurrency: plan.presentmentCurrency, lines};
    return disbursementAssessmentSchema.parse(settled ? {...common, phase: C.phase.settled, refundScanId: snapshot!.id,
      sourceGrossAmount: gross, sourceFeeAmount: fee, sourceNetAmount: net}
      : {...common, phase: C.phase.reserved, reason: basis.refundOutstanding ? C.reason.refundOutstanding : C.reason.refundReading});
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof RangeError || error instanceof DistributionBudgetExceeded
      || error instanceof Error && error.message === C.reason.sources) return {phase: C.phase.review, reason: C.reason.sources};
    throw error;
  }
}

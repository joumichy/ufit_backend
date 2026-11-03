import {describe, expect, it} from 'vitest';
import {PAYMENT_DISBURSEMENT as C, calculateDisbursement, disbursementAssessmentSchema, type DisbursementBasis} from '../../src/modules/payments/domain/payment-disbursement';
import {refundDocumentSchema, type RefundDocument} from '../../src/modules/payments/domain/refund-settlement';
import {calculatePaymentAllocation} from '../../src/modules/payments/domain/payment-allocation';
import {F, transferFixture} from './payment-transfer.fixtures';

const D = {scan: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', refund: 're_DisbursementReturn', debit: 'txn_DisbursementReturn',
  half: {merchandise: 5000, liability: 5100, commission: 500, debit: -6107, creatorGross: 600, platformGross: 300, brandNet: 5843, net: 6743},
  full: {debit: -13197, net: -347}, small: {total: 3, gross: 4, fee: 0, creator: 1},
} as const;
function basis(): DisbursementBasis {
  const f = transferFixture(), source = {paymentId: f.plan.paymentId, orderId: f.plan.orderId, paymentIntentId: F.provider.intent, capture: f.capture};
  const refunds = refundDocumentSchema.parse({source, state: 'synced', asOf: F.date.created, generation: C.one, observedGeneration: C.one,
    failureCode: null, nextAttemptAt: null, snapshot: {source, id: D.scan, generation: C.one, observedAt: F.date.created,
      recordedAt: F.date.created, amountRefunded: C.zero, disputed: false, items: []}});
  return {plan: f.plan, subtotal: F.money.subtotal, platformRateBps: F.money.platformBps, refunds, merchandiseRemaining: F.money.subtotal,
    refundLiability: C.zero, remainingCommissions: [{commissionId: F.id.commission, amount: F.money.creator}], expectedStripeRefunds: [], refundOutstanding: false};
}
function settledRefund(value: DisbursementBasis, amount: number, debit: number): RefundDocument {
  const doc = structuredClone(value.refunds), snapshot = doc.snapshot!;
  snapshot.amountRefunded = amount;
  snapshot.items = [{refundId: D.refund, amount, currency: F.currency.purchase, status: 'succeeded', createdAt: F.date.created, failure: null,
    debit: {id: D.debit, refundId: D.refund, kind: 'refund', amount: debit, feeAmount: C.zero, netAmount: debit,
      currency: F.currency.settlement, createdAt: F.date.created, availableAt: F.date.created}}];
  return refundDocumentSchema.parse(doc);
}
describe('signed disbursement targets and return reservations', () => {
  it('retains the exact initial plan when nothing was refunded', () => {
    const value = basis(), result = calculateDisbursement(value); expect(result.phase).toBe(C.phase.settled);
    if (result.phase !== C.phase.settled) return;
    expect(result.sourceNetAmount).toBe(F.money.net);
    expect(result.lines.map(line => [line.recipient, line.grossAmount, line.feeAmount, line.netAmount]))
      .toEqual(value.plan.lines.map(line => [line.recipient, line.grossAmount, line.feeAmount, line.netAmount]));
  });
  it('uses actual refund FX and preserves original creator/platform source shares after a partial return', () => {
    const value = basis(); Object.assign(value, {merchandiseRemaining: D.half.merchandise, refundLiability: D.half.liability,
      remainingCommissions: [{commissionId: F.id.commission, amount: D.half.commission}], expectedStripeRefunds: [{refundId: D.refund, amount: D.half.liability}]});
    value.refunds = settledRefund(value, D.half.liability, D.half.debit);
    const result = calculateDisbursement(value); expect(result.phase).toBe(C.phase.settled);
    if (result.phase !== C.phase.settled) return;
    expect(result.sourceNetAmount).toBe(D.half.net);
    expect(result.lines.find(x => x.recipient.kind === 'creator')?.grossAmount).toBe(D.half.creatorGross);
    expect(result.lines.find(x => x.recipient.kind === 'platform')?.grossAmount).toBe(D.half.platformGross);
    expect(result.lines.find(x => x.recipient.kind === 'brand')?.netAmount).toBe(D.half.brandNet);
  });
  it('keeps the signed cost deficit after a full refund instead of clipping it into a balanced zero', () => {
    const value = basis(); Object.assign(value, {merchandiseRemaining: C.zero, refundLiability: F.money.total,
      remainingCommissions: [{commissionId: F.id.commission, amount: C.zero}], expectedStripeRefunds: [{refundId: D.refund, amount: F.money.total}]});
    value.refunds = settledRefund(value, F.money.total, D.full.debit);
    const result = calculateDisbursement(value); expect(result.phase).toBe(C.phase.settled);
    if (result.phase !== C.phase.settled) return;
    expect(result.sourceNetAmount).toBe(D.full.net); expect(result.lines.find(x => x.recipient.kind === 'brand')?.netAmount).toBe(D.full.net);
    expect(result.lines.filter(x => x.recipient.kind !== 'brand').every(x => x.netAmount === C.zero)).toBe(true);
  });
  it('uses reservation ceilings to recover original shares while a return refund is still outstanding', () => {
    const value = basis(); Object.assign(value, {merchandiseRemaining: C.zero, refundLiability: F.money.total,
      remainingCommissions: [{commissionId: F.id.commission, amount: C.zero}], refundOutstanding: true});
    const result = calculateDisbursement(value); expect(result.phase).toBe(C.phase.reserved);
    if (result.phase !== C.phase.reserved) return;
    expect(result.reason).toBe(C.reason.refundOutstanding); expect(result.lines.every(x => x.netAmount <= C.zero)).toBe(true);
    expect(result).not.toHaveProperty('sourceNetAmount');
  });
  it('does not expose a cash target before a current refund observation exists', () => {
    const value = basis(); value.refunds = {...value.refunds, state: 'queued', nextAttemptAt: F.date.created, snapshot: null, observedGeneration: C.zero};
    const result = calculateDisbursement(value); expect(result.phase).toBe(C.phase.reserved);
    if (result.phase === C.phase.reserved) expect(result.reason).toBe(C.reason.refundReading);
  });
  it('keeps external repayments separate from Stripe cash and reduces the other economic shares', () => {
    const value = basis(); Object.assign(value, {merchandiseRemaining: C.zero, refundLiability: F.money.total,
      remainingCommissions: [{commissionId: F.id.commission, amount: C.zero}]});
    const result = calculateDisbursement(value); expect(result.phase).toBe(C.phase.settled);
    if (result.phase !== C.phase.settled) return;
    const brand = result.lines.find(x => x.recipient.kind === 'brand')!;
    expect(brand.remainingPurchaseAmount).toBe(C.zero); expect(brand.netAmount).toBe(F.money.net);
    expect(result.lines.filter(x => x.recipient.kind !== 'brand').every(x => x.netAmount === C.zero)).toBe(true);
  });
  it('holds unknown provider refunds and distinguishes an expected observation still missing', () => {
    const value = basis(); value.refunds = settledRefund(value, D.half.liability, D.half.debit);
    expect(calculateDisbursement(value)).toEqual({phase: C.phase.review, reason: C.reason.unmatchedRefund});
    const missing = basis(); missing.refundLiability = D.half.liability; missing.expectedStripeRefunds = [{refundId: D.refund, amount: D.half.liability}];
    expect(calculateDisbursement(missing)).toEqual({phase: C.phase.review, reason: C.reason.missingRefund});
  });
  it('refuses a changed capture, rate or missing commission instead of guessing a target', () => {
    const changed = basis(); changed.refunds.source.capture.feeAmount += C.one;
    expect(calculateDisbursement(changed)).toEqual({phase: C.phase.review, reason: C.reason.sources});
    const rate = basis(); rate.platformRateBps = C.zero;
    expect(calculateDisbursement(rate)).toEqual({phase: C.phase.review, reason: C.reason.sources});
    const missing = basis(); missing.remainingCommissions = [];
    expect(calculateDisbursement(missing)).toEqual({phase: C.phase.review, reason: C.reason.sources});
  });
  it('rejects retained commissions exceeding remaining merchandise and duplicate identities', () => {
    const value = basis(); value.merchandiseRemaining = C.zero;
    expect(calculateDisbursement(value)).toEqual({phase: C.phase.review, reason: C.reason.sources});
    const duplicate = basis(); duplicate.remainingCommissions.push(duplicate.remainingCommissions[C.zero]);
    expect(calculateDisbursement(duplicate)).toEqual({phase: C.phase.review, reason: C.reason.sources});
  });
  it('conserves exact original rounding and the final minor unit across cumulative returns', () => {
    const value = basis(), capture = {...value.refunds.source.capture, chargeAmount: D.small.total, settlementAmount: D.small.gross, feeAmount: C.zero, netAmount: D.small.gross};
    value.plan = {...calculatePaymentAllocation({paymentId: F.id.payment, orderId: F.id.order, brandId: F.id.brand, policyId: F.id.policy,
      platformRateBps: C.zero, feeBearer: 'brand', subtotal: D.small.total, shipping: C.zero, tax: C.zero, total: D.small.total, currency: F.currency.purchase,
      creatorCommissions: [{creatorId: F.id.creator, commissionId: F.id.commission, amount: D.small.creator}], receipt: capture}), createdAt: F.date.created};
    value.subtotal = D.small.total; value.platformRateBps = C.zero; value.merchandiseRemaining = C.zero; value.refundLiability = D.small.total;
    value.remainingCommissions = [{commissionId: F.id.commission, amount: C.zero}]; value.refundOutstanding = true;
    const source = {...value.refunds.source, capture}; value.refunds = refundDocumentSchema.parse({...value.refunds, source, snapshot: {...value.refunds.snapshot, source}});
    const result = calculateDisbursement(value); expect(result.phase).toBe(C.phase.reserved);
    if (result.phase === C.phase.reserved) expect(result.lines.every(line => line.netAmount === C.zero)).toBe(true);
  });
  it('does not accept a settled response whose sums or brand identity disagree', () => {
    const result = calculateDisbursement(basis()); if (result.phase !== C.phase.settled) throw Error(C.validation.targets);
    expect(disbursementAssessmentSchema.safeParse({...result, sourceNetAmount: C.zero}).success).toBe(false);
    expect(disbursementAssessmentSchema.safeParse({...result, brandId: F.id.other}).success).toBe(false);
  });
});

import {COMMISSION_RELEASE} from '../../commissions/domain/commission-release';
import {PAYMENT_ALLOCATION as A, allocationRecipientKey} from './payment-allocation';
import {PAYMENT_DISBURSEMENT as D} from './payment-disbursement';
import {DISBURSEMENT_EXECUTION as C, type DisbursementContext, type DisbursementTransfer} from './payment-disbursement.repository';
import {PAYMENT_TRANSFER as T, sameTransferRefunds, transferInstructionSchema, transferSnapshotSchema, reversalSnapshotSchema,
  type TransferInstruction, type ReversalInstruction, type TransferSnapshot} from './payment-transfer';
import type {ConnectAccountRecord} from './connect-account';
import type {RefundSnapshot} from './refund-settlement';

export type DisbursementDecision = {kind: typeof C.decision.idle}
  | {kind: typeof C.decision.hold; reason: string} | {kind: typeof C.decision.review; reason: string}
  | {kind: typeof C.decision.transfer; key: string; amount: number; funding: TransferInstruction['funding'];
      account: ConnectAccountRecord; refunds: RefundSnapshot}
  | {kind: typeof C.decision.reversal; original: TransferInstruction; snapshot: TransferSnapshot; amount: number; expectedReversedAmount: number};

/** Reject a broken ledger rather than interpreting a missing receipt or unknown adjustment as zero. */
export function validDisbursementLedger(context: DisbursementContext, transfers: DisbursementTransfer[]): boolean {
  const ids = new Set<string>(), providerIds = new Set<string>();
  for (const row of transfers) {
    const i = row.instruction, s = row.snapshot;
    if (!transferInstructionSchema.safeParse(i).success || !transferSnapshotSchema.safeParse(s).success
      || ids.has(i.id) || providerIds.has(s.id) || i.paymentId !== context.plan.paymentId || i.orderId !== context.plan.orderId
      || i.capture.chargeId !== context.plan.chargeId || i.capture.balanceTransactionId !== context.plan.balanceTransactionId
      || i.currency !== context.plan.settlementCurrency || !context.plan.lines.some(line => allocationRecipientKey(line.recipient) === i.allocationKey)
      || s.amount !== i.amount || s.currency !== i.currency || s.liveMode !== i.capture.liveMode || s.destination !== i.account.stripeAccountId
      || s.sourceChargeId !== (i.funding === T.funding.charge ? i.capture.chargeId : null)) return false;
    ids.add(i.id); providerIds.add(s.id);
    for (const reversal of row.reversals) {
      if (!reversalSnapshotSchema.safeParse(reversal).success || providerIds.has(reversal.id)
        || reversal.transferId !== s.id || reversal.currency !== s.currency) return false;
      providerIds.add(reversal.id);
    }
    const reversed = row.reversals.reduce((sum, reversal) => sum + BigInt(reversal.amount), BigInt(C.limits.zero));
    if (reversed > BigInt(s.amount) || BigInt(s.reversedAmount) > reversed) return false;
  }
  // A historical 'paid' flag is not evidence that our new ledger can safely send the same commission again.
  if (context.assessment.phase!==D.phase.review) for (const availability of context.availability) {
    if (availability.releaseState!==COMMISSION_RELEASE.state.paid) continue;
    const rows=transfers.filter(row=>row.instruction.allocationKey===availability.key);
    const target=context.assessment.lines.find(line=>line.key===availability.key);
    const net=rows.reduce((sum,row)=>sum+BigInt(row.snapshot.amount)-row.reversals.reduce((n,r)=>n+BigInt(r.amount),BigInt(C.limits.zero)),BigInt(C.limits.zero));
    if (!rows.length || !target || net<BigInt(Math.max(C.limits.zero,target.netAmount))) return false;
  }
  return true;
}
export function planDisbursement(context: DisbursementContext, transfers: DisbursementTransfer[]): DisbursementDecision {
  const assessment = context.assessment;
  if (assessment.phase === D.phase.review) return {kind: C.decision.review, reason: assessment.reason};
  if (!validDisbursementLedger(context, transfers)) return {kind: C.decision.review, reason: C.reason.ledger};
  const lines = [...assessment.lines].filter(line => line.recipient.kind !== A.kind.platform).sort((a,b) => a.key.localeCompare(b.key));
  const reversed = (row: DisbursementTransfer) => row.reversals.reduce((sum, item) => sum + item.amount, C.limits.zero as number);
  const sent = (key: string) => transfers.filter(row => row.instruction.allocationKey === key)
    .reduce((sum, row) => sum + BigInt(row.snapshot.amount - reversed(row)), BigInt(C.limits.zero));
  // Recover excess first, including while the customer refund is still pending for lack of funds.
  for (const line of lines) {
    const excess = sent(line.key) - BigInt(Math.max(C.limits.zero, line.netAmount));
    if (excess <= BigInt(C.limits.zero)) continue;
    const originals = transfers.filter(row => row.instruction.allocationKey === line.key && row.snapshot.amount > reversed(row))
      .sort((a,b) => b.snapshot.createdAt.localeCompare(a.snapshot.createdAt) || a.instruction.id.localeCompare(b.instruction.id));
    const original = originals[C.limits.zero];
    if (!original) return {kind: C.decision.review, reason: C.reason.ledger};
    const expectedReversedAmount = reversed(original);
    return {kind: C.decision.reversal, original: original.instruction, snapshot: original.snapshot, expectedReversedAmount,
      amount: Math.min(Number(excess), original.snapshot.amount - expectedReversedAmount)};
  }
  if (context.basis.refunds.snapshot?.disputed) return {kind: C.decision.hold, reason: T.reason.dispute};
  if (assessment.phase !== D.phase.settled || assessment.lines.some(line => line.netAmount < C.limits.zero)) return {kind: C.decision.hold, reason: T.reason.adjustment};
  const snapshot = context.basis.refunds.snapshot;
  if (!snapshot) return {kind: C.decision.review, reason: C.reason.ledger};
  const {id, generation, recordedAt, ...refunds} = snapshot;
  const committed = transfers.reduce((sum, row) => sum + BigInt(row.snapshot.amount - reversed(row)), BigInt(C.limits.zero));
  let hold: string | undefined;
  for (const line of lines) {
    const difference = BigInt(line.netAmount) - sent(line.key);
    if (difference <= BigInt(C.limits.zero)) continue;
    const availability = context.availability.find(row => row.key === line.key);
    if (!availability || !availability.allowed || !availability.account) {hold ??= availability?.reason ?? C.reason.ledger; continue;}
    if (committed + difference > BigInt(assessment.sourceNetAmount)) return {kind: C.decision.review, reason: C.reason.ledger};
    const originalChargeTransfers = transfers.filter(row => row.instruction.funding === T.funding.charge)
      .reduce((sum, row) => sum + BigInt(row.snapshot.amount), BigInt(C.limits.zero));
    return {kind: C.decision.transfer, key: line.key, amount: Number(difference), account: availability.account, refunds,
      funding: originalChargeTransfers + difference <= BigInt(context.plan.settlementAmount) ? T.funding.charge : T.funding.balance};
  }
  return hold ? {kind: C.decision.hold, reason: hold} : {kind: C.decision.idle};
}

export function matchesDisbursementDecision(decision: DisbursementDecision, instruction: TransferInstruction | ReversalInstruction): boolean {
  if (decision.kind === C.decision.transfer && !('original' in instruction)) return decision.key === instruction.allocationKey
    && decision.amount === instruction.amount && decision.funding === instruction.funding && decision.account.id === instruction.account.id
    && decision.account.stripeAccountId === instruction.account.stripeAccountId && decision.account.country === instruction.account.country
    && decision.account.liveMode === instruction.account.liveMode && sameTransferRefunds(decision.refunds, instruction.refunds);
  if (decision.kind === C.decision.reversal && 'original' in instruction) return decision.original.id === instruction.original.id
    && decision.snapshot.id === instruction.transferId && decision.amount === instruction.amount && decision.expectedReversedAmount === instruction.expectedReversedAmount;
  return false;
}

export function fundedCommissionIds(context: DisbursementContext, transfers: DisbursementTransfer[]): string[] {
  if (context.assessment.phase !== D.phase.settled || context.basis.refunds.snapshot?.disputed
    || context.assessment.lines.some(line => line.netAmount < C.limits.zero) || !validDisbursementLedger(context, transfers)) return [];
  return context.assessment.lines.flatMap(line => {
    if (line.recipient.kind !== A.kind.creator || line.netAmount <= C.limits.zero
      || !context.availability.some(row => row.key === line.key && row.allowed)) return [];
    const sent = transfers.filter(row => row.instruction.allocationKey === line.key).reduce((sum,row) =>
      sum + BigInt(row.snapshot.amount) - row.reversals.reduce((n,r) => n + BigInt(r.amount), BigInt(C.limits.zero)), BigInt(C.limits.zero));
    return sent === BigInt(line.netAmount) ? [line.recipient.commissionId] : [];
  });
}

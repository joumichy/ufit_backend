import {CONNECT} from '../domain/connect-account';
import {readStripeRefundSettlement} from './stripe-refund-settlement';
import {REFUND_SETTLEMENT, refundSnapshotComplete} from '../domain/refund-settlement';
import {connectSnapshot} from './stripe-connect-accounts';
import {PAYMENT_TRANSFER as C, transferInstructionSchema, transferAuthorizationSchema, sameTransferRefunds, transferGroup, transferMetadata,
  type TransferInstruction, type TransferExecution, type TransferSnapshot, type RevalidateTransfer} from '../domain/payment-transfer';
import {type StripeTransferClient, transferRequestOptions, recoverStripeTransfer, projectTransfer} from './stripe-transfer-reconciliation';

/** The durable caller holds the order lock throughout recovery, authorization and creation. */
export async function executeStripeTransfer(stripe: StripeTransferClient, raw: TransferInstruction, liveMode: boolean,
  knownId: string | null, revalidate: RevalidateTransfer): Promise<TransferExecution<TransferSnapshot>> {
  const parsed = transferInstructionSchema.safeParse(raw);
  if (!parsed.success) return {kind: C.result.review, reason: C.reason.invalid};
  const instruction = parsed.data;
  if (instruction.capture.liveMode !== liveMode) return {kind: C.result.review, reason: C.reason.mode};
  // Recover a previous side effect even if a return now makes a new transfer ineligible.
  const recovered = await recoverStripeTransfer(stripe, instruction, knownId);
  if (recovered.kind === C.result.found) return {kind: C.result.recorded, snapshot: recovered.snapshot};
  if (recovered.kind !== C.result.absent) return recovered;
  try {
    const account = await stripe.accounts.retrieve(instruction.account.stripeAccountId, {}, transferRequestOptions);
    if (account.id !== instruction.account.stripeAccountId || account.country !== instruction.account.country
      || account.metadata?.[CONNECT.metadata.associationId] !== instruction.account.id
      || account.metadata?.[CONNECT.metadata.profileId] !== instruction.recipient.beneficiaryId
      || account.metadata?.[CONNECT.metadata.kind] !== instruction.recipient.kind) return {kind: C.result.review, reason: C.reason.mismatch};
    if (connectSnapshot(account, {...instruction.account, snapshot: null}).stage !== CONNECT.stage.ready) return {kind: C.result.blocked, reason: C.reason.account};
    const observed = await readStripeRefundSettlement(stripe, instruction.refunds.source, liveMode);
    if (observed.kind !== REFUND_SETTLEMENT.result.observed) return {kind: observed.kind === REFUND_SETTLEMENT.result.retry ? C.result.retry : C.result.review,
      reason: observed.reason === REFUND_SETTLEMENT.failure.unavailable ? C.reason.unavailable : C.reason.capture};
    if (observed.snapshot.disputed) return {kind: C.result.blocked, reason: C.reason.dispute};
    if (!refundSnapshotComplete(observed.snapshot) || !sameTransferRefunds(instruction.refunds, observed.snapshot)) return {kind: C.result.blocked, reason: C.reason.refund};
    let authorization;
    try { authorization = transferAuthorizationSchema.safeParse(await revalidate()); } catch { return {kind: C.result.retry, reason: C.reason.local}; }
    if (!authorization.success) return {kind: C.result.review, reason: C.reason.local};
    if (!authorization.data.allowed) return {kind: C.result.blocked, reason: authorization.data.reason};
    const created = await stripe.transfers.create({amount: instruction.amount, currency: instruction.currency.toLowerCase(),
      destination: instruction.account.stripeAccountId,
      ...(instruction.funding === C.funding.charge ? {source_transaction: instruction.capture.chargeId} : {}),
      transfer_group: transferGroup(instruction), metadata: transferMetadata(instruction)},
    {...transferRequestOptions, idempotencyKey: C.provider.transferKeyPrefix + instruction.id});
    const snapshot = projectTransfer(created, instruction);
    return snapshot ? {kind: C.result.recorded, snapshot} : {kind: C.result.review, reason: C.reason.mismatch};
  } catch { return {kind: C.result.retry, reason: C.reason.unavailable}; }
}

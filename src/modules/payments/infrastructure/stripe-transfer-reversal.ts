import {toStripeAmount, StripeAmountError} from './stripe-amount';
import {PAYMENT_TRANSFER as C, reversalInstructionSchema, transferAuthorizationSchema, transferMetadata,
  type ReversalInstruction, type TransferExecution, type ReversalSnapshot, type RevalidateTransfer} from '../domain/payment-transfer';
import {type StripeTransferClient, transferRequestOptions, recoverStripeReversal, projectTransfer, projectReversal} from './stripe-transfer-reconciliation';

/** Reversals remain possible when the recipient's onboarding subsequently becomes restricted. */
export async function executeStripeTransferReversal(stripe: StripeTransferClient, raw: ReversalInstruction, liveMode: boolean,
  knownId: string | null, revalidate: RevalidateTransfer): Promise<TransferExecution<ReversalSnapshot>> {
  const parsed = reversalInstructionSchema.safeParse(raw);
  if (!parsed.success) return {kind: C.result.review, reason: C.reason.invalid};
  const instruction = parsed.data;
  if (instruction.original.capture.liveMode !== liveMode) return {kind: C.result.review, reason: C.reason.mode};
  const recovered = await recoverStripeReversal(stripe, instruction, knownId);
  if (recovered.kind === C.result.found) return {kind: C.result.recorded, snapshot: recovered.snapshot};
  if (recovered.kind !== C.result.absent) return recovered;
  try {
    const transfer = projectTransfer(await stripe.transfers.retrieve(instruction.transferId, {}, transferRequestOptions), instruction.original);
    if (!transfer || transfer.id !== instruction.transferId) return {kind: C.result.review, reason: C.reason.mismatch};
    if (transfer.amount - transfer.reversedAmount < instruction.amount) return {kind: C.result.blocked, reason: C.reason.remaining};
    if (transfer.reversedAmount !== instruction.expectedReversedAmount) return {kind: C.result.review, reason: C.reason.mismatch};
    let authorization;
    try { authorization = transferAuthorizationSchema.safeParse(await revalidate()); } catch { return {kind: C.result.retry, reason: C.reason.local}; }
    if (!authorization.success) return {kind: C.result.review, reason: C.reason.local};
    if (!authorization.data.allowed) return {kind: C.result.blocked, reason: authorization.data.reason};
    const created = await stripe.transfers.createReversal(instruction.transferId, {amount: toStripeAmount(instruction.amount, instruction.original.currency),
      metadata: {...transferMetadata(instruction.original), [C.provider.metadata.reversal]: instruction.id}},
    {...transferRequestOptions, idempotencyKey: C.provider.reversalKeyPrefix + instruction.id});
    const snapshot = projectReversal(created, instruction);
    return snapshot ? {kind: C.result.recorded, snapshot} : {kind: C.result.review, reason: C.reason.mismatch};
  } catch (error) { return error instanceof StripeAmountError
    ? {kind: C.result.review, reason: C.reason.invalid} : {kind: C.result.retry, reason: C.reason.unavailable}; }
}

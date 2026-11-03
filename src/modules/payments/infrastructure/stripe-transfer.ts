import {CONNECT} from '../domain/connect-account';
import {STRIPE_ORDER_METADATA} from '../application/stripe-commerce';
import {connectSnapshot} from './stripe-connect-accounts';
import {PAYMENT_TRANSFER as C, transferInstructionSchema, transferAuthorizationSchema, transferGroup, transferMetadata,
  type TransferInstruction, type TransferExecution, type TransferSnapshot, type RevalidateTransfer} from '../domain/payment-transfer';
import {type StripeTransferClient, transferRequestOptions, recoverStripeTransfer, projectTransfer, providerCurrency, providerInstant, providerString} from './stripe-transfer-reconciliation';

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
    const charge = await stripe.charges.retrieve(instruction.capture.chargeId, {expand: [...C.provider.expansion]}, transferRequestOptions);
    const balance = charge.balance_transaction, capture = instruction.capture;
    if (charge.id !== capture.chargeId || charge.payment_intent !== instruction.paymentIntentId
      || charge.metadata?.[STRIPE_ORDER_METADATA.orderId] !== instruction.orderId || charge.livemode !== liveMode
      || !charge.paid || !charge.captured || charge.status !== C.provider.succeeded
      || charge.amount !== capture.chargeAmount || charge.amount_captured !== capture.chargeAmount
      || providerCurrency(charge.currency) !== capture.chargeCurrency || !balance || providerString(balance)
      || balance.id !== capture.balanceTransactionId || balance.source !== capture.chargeId || balance.type !== C.provider.balanceType
      || balance.amount !== capture.settlementAmount || balance.net !== capture.netAmount || balance.fee !== capture.feeAmount
      || providerCurrency(balance.currency) !== capture.settlementCurrency || providerInstant(charge.created) !== capture.capturedAt
      || providerInstant(balance.available_on) !== capture.availableAt) return {kind: C.result.review, reason: C.reason.capture};
    if (charge.disputed) return {kind: C.result.blocked, reason: C.reason.dispute};
    if (charge.refunded || charge.amount_refunded !== C.zero) return {kind: C.result.blocked, reason: C.reason.refund};
    // Pending refunds can precede amount_refunded. Inspect them before authorizing a new side effect.
    for await (const refund of stripe.refunds.list({charge: charge.id, limit: C.provider.pageLimit}, transferRequestOptions)) {
      if (refund.charge !== charge.id || providerCurrency(refund.currency) !== capture.chargeCurrency) return {kind: C.result.review, reason: C.reason.capture};
      if (refund.status !== C.provider.failedRefund && refund.status !== C.provider.cancelledRefund) return {kind: C.result.blocked, reason: C.reason.refund};
    }
    let authorization;
    try { authorization = transferAuthorizationSchema.safeParse(await revalidate()); } catch { return {kind: C.result.retry, reason: C.reason.local}; }
    if (!authorization.success) return {kind: C.result.review, reason: C.reason.local};
    if (!authorization.data.allowed) return {kind: C.result.blocked, reason: authorization.data.reason};
    const created = await stripe.transfers.create({amount: instruction.amount, currency: instruction.currency.toLowerCase(),
      destination: instruction.account.stripeAccountId, source_transaction: instruction.capture.chargeId,
      transfer_group: transferGroup(instruction), metadata: transferMetadata(instruction)},
    {...transferRequestOptions, idempotencyKey: C.provider.transferKeyPrefix + instruction.id});
    const snapshot = projectTransfer(created, instruction);
    return snapshot ? {kind: C.result.recorded, snapshot} : {kind: C.result.review, reason: C.reason.mismatch};
  } catch { return {kind: C.result.retry, reason: C.reason.unavailable}; }
}

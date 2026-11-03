import type Stripe from 'stripe';
import {PAYMENT_TRANSFER as C, transferInstructionSchema, reversalInstructionSchema, transferSnapshotSchema, reversalSnapshotSchema, transferGroup, transferMetadata,
  type TransferInstruction, type ReversalInstruction, type TransferSnapshot, type ReversalSnapshot, type TransferRead, type TransferFailure} from '../domain/payment-transfer';

export type StripeTransferClient = Pick<InstanceType<typeof Stripe>, 'transfers' | 'accounts' | 'charges' | 'refunds'>;
export const transferRequestOptions = {timeout: C.provider.timeoutMs, maxNetworkRetries: C.provider.networkRetries};
export const providerRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const providerString = (value: unknown): value is string => typeof value === C.provider.referenceType;
function providerReadFailure(error: unknown): TransferFailure {
  return providerRecord(error) && error.code === C.provider.missing
    ? {kind: C.result.review, reason: C.reason.mismatch} : {kind: C.result.retry, reason: C.reason.unavailable};
}
export function providerInstant(seconds: unknown): string | undefined {
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < C.zero) return undefined;
  const date = new Date(seconds * C.provider.millisecondsPerSecond);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
export function providerCurrency(value: unknown): string | undefined { return providerString(value) ? value.toUpperCase() : undefined; }
function metadataMatches(value: unknown, expected: Record<string, string>): boolean {
  return providerRecord(value) && Object.entries(expected).every(([key, item]) => value[key] === item);
}
export function projectTransfer(value: unknown, instruction: TransferInstruction): TransferSnapshot | undefined {
  if (!providerRecord(value) || value.object !== C.provider.transferObject || !metadataMatches(value.metadata, transferMetadata(instruction))) return undefined;
  const parsed = transferSnapshotSchema.safeParse({id: value.id, amount: value.amount, currency: providerCurrency(value.currency),
    destination: value.destination, sourceChargeId: value.source_transaction, transferGroup: value.transfer_group,
    liveMode: value.livemode, createdAt: providerInstant(value.created), reversedAmount: value.amount_reversed});
  if (!parsed.success) return undefined;
  const row = parsed.data;
  return row.amount === instruction.amount && row.currency === instruction.currency && row.destination === instruction.account.stripeAccountId
    && row.sourceChargeId === instruction.capture.chargeId && row.transferGroup === transferGroup(instruction)
    && row.liveMode === instruction.capture.liveMode && value.reversed === (row.reversedAmount === row.amount) ? row : undefined;
}
export function projectReversal(value: unknown, instruction: ReversalInstruction): ReversalSnapshot | undefined {
  const expected = {...transferMetadata(instruction.original), [C.provider.metadata.reversal]: instruction.id};
  if (!providerRecord(value) || value.object !== C.provider.reversalObject || !metadataMatches(value.metadata, expected)) return undefined;
  const parsed = reversalSnapshotSchema.safeParse({id: value.id, transferId: value.transfer, amount: value.amount,
    currency: providerCurrency(value.currency), createdAt: providerInstant(value.created)});
  return parsed.success && parsed.data.transferId === instruction.transferId && parsed.data.amount === instruction.amount
    && parsed.data.currency === instruction.original.currency ? parsed.data : undefined;
}

/** Exhaust every page before deciding absence; neither a failed read nor a second match permits a POST. */
async function findOperation<T>(readPage: (cursor?: string) => Promise<unknown>, operationKey: string, operationId: string,
  project: (value: unknown) => T | undefined): Promise<TransferRead<T>> {
  let cursor: string | undefined, found: T | undefined;
  const seen = new Set<string>();
  try {
    do {
      const page = await readPage(cursor);
      if (!providerRecord(page) || !Array.isArray(page.data) || typeof page.has_more !== 'boolean') return {kind: C.result.review, reason: C.reason.mismatch};
      for (const row of page.data) {
        if (!providerRecord(row) || !providerString(row.id) || !row.id.length || seen.has(row.id)
          || !providerRecord(row.metadata)) return {kind: C.result.review, reason: C.reason.mismatch};
        seen.add(row.id);
        if (row.metadata[operationKey] !== operationId) continue;
        const candidate = project(row);
        if (!candidate || found !== undefined) return {kind: C.result.review, reason: C.reason.mismatch};
        found = candidate;
      }
      const last = page.data.at(-C.one);
      if (page.has_more && (!providerRecord(last) || !providerString(last.id) || last.id === cursor)) return {kind: C.result.review, reason: C.reason.mismatch};
      cursor = page.has_more && providerRecord(last) && providerString(last.id) ? last.id : undefined;
    } while (cursor !== undefined);
    return found === undefined ? {kind: C.result.absent} : {kind: C.result.found, snapshot: found};
  } catch (error) { return providerReadFailure(error); }
}
export async function recoverStripeTransfer(stripe: StripeTransferClient, instruction: TransferInstruction, knownId: string | null): Promise<TransferRead<TransferSnapshot>> {
  if (!transferInstructionSchema.safeParse(instruction).success || knownId !== null && !transferSnapshotSchema.shape.id.safeParse(knownId).success) return {kind: C.result.review, reason: C.reason.invalid};
  if (knownId !== null) {
    try {
      const row = projectTransfer(await stripe.transfers.retrieve(knownId, {}, transferRequestOptions), instruction);
      return row && row.id === knownId ? {kind: C.result.found, snapshot: row} : {kind: C.result.review, reason: C.reason.mismatch};
    } catch (error) { return providerReadFailure(error); }
  }
  return findOperation(cursor => stripe.transfers.list({transfer_group: transferGroup(instruction), destination: instruction.account.stripeAccountId,
    limit: C.provider.pageLimit, starting_after: cursor}, transferRequestOptions), C.provider.metadata.operation, instruction.id, row => projectTransfer(row, instruction));
}
export async function recoverStripeReversal(stripe: StripeTransferClient, instruction: ReversalInstruction, knownId: string | null): Promise<TransferRead<ReversalSnapshot>> {
  if (!reversalInstructionSchema.safeParse(instruction).success || knownId !== null && !reversalSnapshotSchema.shape.id.safeParse(knownId).success) return {kind: C.result.review, reason: C.reason.invalid};
  if (knownId !== null) {
    try {
      const row = projectReversal(await stripe.transfers.retrieveReversal(instruction.transferId, knownId, {}, transferRequestOptions), instruction);
      return row && row.id === knownId ? {kind: C.result.found, snapshot: row} : {kind: C.result.review, reason: C.reason.mismatch};
    } catch (error) { return providerReadFailure(error); }
  }
  return findOperation(cursor => stripe.transfers.listReversals(instruction.transferId, {limit: C.provider.pageLimit, starting_after: cursor}, transferRequestOptions),
    C.provider.metadata.reversal, instruction.id, row => projectReversal(row, instruction));
}

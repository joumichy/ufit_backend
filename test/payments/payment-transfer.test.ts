import {describe, expect, it} from 'vitest';
import {PAYMENT_TRANSFER as C, makeTransferInstruction, transferInstructionSchema, reversalInstructionSchema, type RevalidateTransfer} from '../../src/modules/payments/domain/payment-transfer';
import {allocationRecipientKey, calculatePaymentAllocation} from '../../src/modules/payments/domain/payment-allocation';
import {CONNECT} from '../../src/modules/payments/domain/connect-account';
import {executeStripeTransfer} from '../../src/modules/payments/infrastructure/stripe-transfer';
import {executeStripeTransferReversal} from '../../src/modules/payments/infrastructure/stripe-transfer-reversal';
import {recoverStripeTransfer, recoverStripeReversal} from '../../src/modules/payments/infrastructure/stripe-transfer-reconciliation';
import {F, transferFixture, stripeFixture, providerTransfer, providerReversal} from './payment-transfer.fixtures';

describe('frozen transfer instruction', () => {
  it('uses the exact creator settlement share and the corresponding Connect association', () => {
    const {instruction} = transferFixture(); expect(instruction.amount).toBe(F.money.creatorSettled);
    expect(instruction.currency).toBe(F.currency.settlement); expect(instruction.recipient.kind).toBe(C.kind.creator);
    expect(instruction.account.profileId).toBe(F.id.creator); expect(instruction.account).not.toHaveProperty('snapshot');
  });
  it('uses the brand share after its frozen fee, without transferring the platform share', () => {
    const f = transferFixture(C.kind.brand); expect(f.instruction.amount).toBe(F.money.brandSettled);
    const platform = f.plan.lines.find(row => row.recipient.kind === 'platform')!;
    expect(() => makeTransferInstruction(F.id.operation, F.provider.intent, f.plan, f.capture, allocationRecipientKey(platform.recipient), f.account)).toThrow();
  });
  it('rejects mixed capture currencies and balances rather than applying an inferred FX rate', () => {
    const f = transferFixture();
    expect(() => makeTransferInstruction(F.id.operation, F.provider.intent, f.plan, {...f.capture, settlementCurrency: F.currency.different}, f.instruction.allocationKey, f.account)).toThrow();
    expect(() => makeTransferInstruction(F.id.operation, F.provider.intent, {...f.plan, feeAmount: C.zero}, f.capture, f.instruction.allocationKey, f.account)).toThrow();
  });
  it('rejects wrong recipient, mode, allocation identity and client fields', () => {
    const {instruction: i} = transferFixture();
    for (const value of [{...i, account: {...i.account, profileId: F.id.other}}, {...i, account: {...i.account, liveMode: true}},
      {...i, allocationKey: F.unrelated}, {...i, currency: F.currency.purchase}, {...i, [F.unknown]: true}]) expect(transferInstructionSchema.safeParse(value).success).toBe(false);
  });
  it('requires canonical fields, positive minor amounts and distinct reversal identity', () => {
    const {instruction: i} = transferFixture(), {currency, ...missing} = i;
    expect(transferInstructionSchema.safeParse(missing).success).toBe(false);
    for (const amount of [C.zero, -C.one, C.maximumAmount + C.one]) expect(transferInstructionSchema.safeParse({...i, amount}).success).toBe(false);
    expect(reversalInstructionSchema.safeParse({id: i.id, original: i, transferId: F.provider.transfer, amount: F.money.reversal}).success).toBe(false);
  });
  it('refuses transfers when any initial share fails to cover its fee', () => {
    const f = transferFixture(), deficit = {...calculatePaymentAllocation({paymentId: F.id.payment, orderId: F.id.order,
      brandId: F.id.brand, policyId: F.id.policy, platformRateBps: C.zero, feeBearer: 'platform', subtotal: F.money.subtotal,
      shipping: F.money.shipping, tax: F.money.tax, total: F.money.total, currency: F.currency.purchase,
      creatorCommissions: [{creatorId: F.id.creator, commissionId: F.id.commission, amount: F.money.creator}], receipt: f.capture}), createdAt: F.date.created};
    expect(() => makeTransferInstruction(F.id.operation, F.provider.intent, deficit, f.capture, f.instruction.allocationKey, f.account)).toThrow();
  });
});
describe('transfer recovery and creation', () => {
  it('creates the exact source-linked transfer only after fresh provider reads and local authorization', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i);
    expect((await executeStripeTransfer(s.client, i, false, null, s.authorize)).kind).toBe(C.result.recorded);
    expect(s.methods()).toEqual([F.calls.list, F.calls.account, F.calls.charge, F.calls.refunds, F.calls.authorize, F.calls.create]);
  });
  it('recovers a lost accepted response without repeating a POST even when eligibility changed', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i); s.state.loseTransferResponse = true;
    expect((await executeStripeTransfer(s.client, i, false, null, s.authorize)).kind).toBe(C.result.retry);
    const result = await executeStripeTransfer(s.client, i, false, null, async () => { throw new Error(F.failure); });
    expect(result.kind).toBe(C.result.recorded); expect(s.count(F.calls.create)).toBe(C.one); expect(s.count(F.calls.authorize)).toBe(C.one);
  });
  it('exhausts pagination and recovers an old metadata match without relying on idempotency-key retention', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i), other = {...providerTransfer(i), id: F.provider.otherTransfer, metadata: {ufit_transfer_operation_id: F.unrelated}};
    s.state.pages = [{data: [other], has_more: true}, {data: [s.state.transfer], has_more: false}];
    expect((await executeStripeTransfer(s.client, i, false, null, s.authorize)).kind).toBe(C.result.recorded);
    expect(s.calls.filter(row => row.method === F.calls.list).map(row => (row.args[C.zero] as {starting_after?: string}).starting_after)).toEqual([undefined, F.provider.otherTransfer]);
    expect(s.count(F.calls.create)).toBe(C.zero);
  });
  it('does not mistake a failed recovery read for absence', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i); s.state.failures.add(F.calls.list);
    expect((await executeStripeTransfer(s.client, i, false, null, s.authorize)).kind).toBe(C.result.retry); expect(s.count(F.calls.create)).toBe(C.zero);
  });
  it('does not accept a first-page match if a later page cannot rule out duplicates', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i);
    s.state.pages = [{data: [s.state.transfer], has_more: true}]; s.state.failAtCursor = F.provider.transfer;
    expect((await executeStripeTransfer(s.client, i, false, null, s.authorize)).kind).toBe(C.result.retry);
    expect(s.count(F.calls.create)).toBe(C.zero);
  });
  it('rejects duplicate matches on later pages', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i);
    s.state.pages = [{data: [s.state.transfer], has_more: true}, {data: [{...s.state.transfer, id: F.provider.otherTransfer}], has_more: false}];
    expect((await recoverStripeTransfer(s.client, i, null)).kind).toBe(C.result.review);
  });
  it('rejects an empty continuing page or repeated cursor instead of declaring absence', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i); s.state.pages = [{data: [], has_more: true}];
    expect((await recoverStripeTransfer(s.client, i, null)).kind).toBe(C.result.review);
    const other = {...s.state.transfer, id: F.provider.otherTransfer, metadata: {}};
    s.state.pages = [{data: [other], has_more: true}, {data: [other], has_more: true}];
    expect((await recoverStripeTransfer(s.client, i, null)).kind).toBe(C.result.review);
  });
  it('rejects a matching operation attached to another amount or destination', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i);
    for (const row of [{...s.state.transfer, amount: C.one}, {...s.state.transfer, destination: F.provider.otherAccount}]) {
      s.state.pages = [{data: [row], has_more: false}]; expect((await recoverStripeTransfer(s.client, i, null)).kind).toBe(C.result.review);
    }
  });
  it('rereads a known transfer directly and never replaces it if retrieval fails', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i);
    expect((await executeStripeTransfer(s.client, i, false, F.provider.transfer, s.authorize)).kind).toBe(C.result.recorded);
    s.state.failures.add(F.calls.retrieve);
    expect((await executeStripeTransfer(s.client, i, false, F.provider.transfer, s.authorize)).kind).toBe(C.result.retry);
    expect(s.count(F.calls.list)).toBe(C.zero); expect(s.count(F.calls.create)).toBe(C.zero);
  });
  it('requires fresh Connect readiness and the exact profile association', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i); s.state.account.payouts_enabled = false;
    expect(await executeStripeTransfer(s.client, i, false, null, s.authorize)).toEqual({kind: C.result.blocked, reason: C.reason.account});
    s.state.account.payouts_enabled = true; s.state.account.metadata[CONNECT.metadata.profileId] = F.id.other;
    expect((await executeStripeTransfer(s.client, i, false, null, s.authorize)).kind).toBe(C.result.review); expect(s.count(F.calls.create)).toBe(C.zero);
  });
  it('rejects a changed source balance or payment intent', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i); s.state.charge.balance_transaction.net -= C.one;
    expect(await executeStripeTransfer(s.client, i, false, null, s.authorize)).toEqual({kind: C.result.review, reason: C.reason.capture});
    expect(s.count(F.calls.create)).toBe(C.zero);
  });
  it('blocks a refund or dispute before any new transfer', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i); s.state.charge.amount_refunded = C.one;
    expect(await executeStripeTransfer(s.client, i, false, null, s.authorize)).toEqual({kind: C.result.blocked, reason: C.reason.refund});
    s.state.charge.amount_refunded = C.zero; s.state.charge.disputed = true;
    expect(await executeStripeTransfer(s.client, i, false, null, s.authorize)).toEqual({kind: C.result.blocked, reason: C.reason.dispute});
  });
  it('blocks a pending refund even before amount_refunded changes', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i);
    s.state.refunds = [{charge: F.provider.charge, currency: 'chf', status: 'pending'}];
    expect(await executeStripeTransfer(s.client, i, false, null, s.authorize)).toEqual({kind: C.result.blocked, reason: C.reason.refund}); expect(s.count(F.calls.create)).toBe(C.zero);
  });
  it('rereads local eligibility immediately before POST and preserves its blocking reason', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i);
    expect(await executeStripeTransfer(s.client, i, false, null, async () => ({allowed: false, reason: C.reason.returnOpen}))).toEqual({kind: C.result.blocked, reason: C.reason.returnOpen});
    expect(s.count(F.calls.create)).toBe(C.zero);
  });
  it('does not create when the final local read fails', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i);
    expect(await executeStripeTransfer(s.client, i, false, null, async () => { throw new Error(F.failure); })).toEqual({kind: C.result.retry, reason: C.reason.local});
    expect(s.count(F.calls.create)).toBe(C.zero);
  });
  it('rejects malformed local authorization rather than treating a string as permission', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i);
    const invalid = (async () => ({allowed: 'false'})) as unknown as RevalidateTransfer;
    expect(await executeStripeTransfer(s.client, i, false, null, invalid)).toEqual({kind: C.result.review, reason: C.reason.local});
    expect(s.count(F.calls.create)).toBe(C.zero);
  });
  it('treats a missing known provider identity as review rather than permission to recreate', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i);
    s.client.transfers.retrieve = async () => { throw Object.assign(new Error(F.failure), {code: C.provider.missing}); };
    expect(await recoverStripeTransfer(s.client, i, F.provider.transfer)).toEqual({kind: C.result.review, reason: C.reason.mismatch});
    expect(s.count(F.calls.create)).toBe(C.zero);
  });
  it('rejects live/test mismatch and malformed instructions before any provider call', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i);
    expect((await executeStripeTransfer(s.client, i, true, null, s.authorize)).kind).toBe(C.result.review);
    expect((await executeStripeTransfer(s.client, {...i, amount: C.zero}, false, null, s.authorize)).kind).toBe(C.result.review); expect(s.calls).toEqual([]);
  });
  it('does not mark a mismatching creation response as recorded', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i); s.state.transfer.destination = F.provider.otherAccount;
    expect((await executeStripeTransfer(s.client, i, false, null, s.authorize)).kind).toBe(C.result.review);
  });
});

describe('transfer reversal recovery and creation', () => {
  it('creates the exact partial reversal after reading current remaining funds and local authorization', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i);
    expect((await executeStripeTransferReversal(s.client, s.reversal, false, null, s.authorize)).kind).toBe(C.result.recorded);
    expect(s.methods()).toEqual([F.calls.reversalList, F.calls.retrieve, F.calls.authorize, F.calls.reversalCreate]);
  });
  it('recovers an accepted reversal after its response was lost without creating another', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i); s.state.loseReversalResponse = true;
    expect((await executeStripeTransferReversal(s.client, s.reversal, false, null, s.authorize)).kind).toBe(C.result.retry);
    expect((await executeStripeTransferReversal(s.client, s.reversal, false, null, async () => ({allowed: false, reason: C.reason.adjustment}))).kind).toBe(C.result.recorded);
    expect(s.count(F.calls.reversalCreate)).toBe(C.one);
  });
  it('recovers a known reversal without consulting account readiness or creating anything', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i);
    expect((await executeStripeTransferReversal(s.client, s.reversal, false, F.provider.reversal, s.authorize)).kind).toBe(C.result.recorded);
    expect(s.methods()).toEqual([F.calls.reversalRead]);
  });
  it('rejects duplicate reversal matches across pages', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i), second = {...providerReversal(s.reversal), id: F.provider.reversal + F.unrelated};
    s.state.reversalPages = [{data: [s.state.reversal], has_more: true}, {data: [second], has_more: false}];
    expect((await recoverStripeReversal(s.client, s.reversal, null)).kind).toBe(C.result.review);
  });
  it('does not create a reversal after unreadable history', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i); s.state.failures.add(F.calls.reversalList);
    expect((await executeStripeTransferReversal(s.client, s.reversal, false, null, s.authorize)).kind).toBe(C.result.retry);
    expect(s.count(F.calls.reversalCreate)).toBe(C.zero);
  });
  it('refuses more than the unreversed balance, including a fully reversed transfer', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i); s.state.transfer.amount_reversed = i.amount; s.state.transfer.reversed = true;
    expect(await executeStripeTransferReversal(s.client, s.reversal, false, null, s.authorize)).toEqual({kind: C.result.blocked, reason: C.reason.remaining});
    expect(s.count(F.calls.reversalCreate)).toBe(C.zero);
  });
  it('rejects transfer metadata or mode drift and never creates a replacement', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i); s.state.transfer.metadata = {};
    expect((await executeStripeTransferReversal(s.client, s.reversal, false, null, s.authorize)).kind).toBe(C.result.review);
    expect((await executeStripeTransferReversal(s.client, s.reversal, true, null, s.authorize)).kind).toBe(C.result.review);
    expect(s.count(F.calls.reversalCreate)).toBe(C.zero);
  });
  it('requires local refund authorization and never infers it from a provider balance', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i);
    expect(await executeStripeTransferReversal(s.client, s.reversal, false, null, async () => ({allowed: false, reason: C.reason.adjustment}))).toEqual({kind: C.result.blocked, reason: C.reason.adjustment});
    expect(s.count(F.calls.reversalCreate)).toBe(C.zero);
  });
  it('rejects overlarge instructions and a mismatching reversal response', async () => {
    const {instruction: i} = transferFixture(), s = stripeFixture(i);
    expect((await executeStripeTransferReversal(s.client, {...s.reversal, amount: F.money.tooMuch}, false, null, s.authorize)).kind).toBe(C.result.review);
    s.state.reversal.amount += C.one;
    expect((await executeStripeTransferReversal(s.client, s.reversal, false, null, s.authorize)).kind).toBe(C.result.review);
  });
});

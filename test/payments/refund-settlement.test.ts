import {afterEach, describe, expect, it, vi} from 'vitest';
import {REFUND_SETTLEMENT as C, refundSnapshotSchema, refundSnapshotComplete, refundBalanceTotals,
  refundDocumentSchema, type RefundSource, type RefundSnapshot} from '../../src/modules/payments/domain/refund-settlement';
import {readStripeRefundSettlement, type RefundSettlementClient} from '../../src/modules/payments/infrastructure/stripe-refund-settlement';
import {RefundSettlementsService} from '../../src/modules/payments/application/refund-settlements.service';
import type {RefundSettlementRepository} from '../../src/modules/payments/domain/refund-settlement.repository';
import {F, transferFixture, stripeFixture} from './payment-transfer.fixtures';
import type {IdentityAccess} from '../../src/modules/identity/domain/user.types';

vi.mock('../../src/config/env', () => ({getEnv: () => ({STRIPE_SECRET_KEY: 'sk_test_contract_only_not_a_credential'})}));
const R = {id: 're_RefundSettlement', otherId: 're_OtherRefundSettlement', debit: 'txn_RefundDebit', failure: 'txn_RefundFailure',
  amount: 5000, debitAmount: -6100, fee: 25, net: -6125, failureAmount: 6100,
  created: 1793923200, available: 1794009600, pending: 'pending', missing: 'resource_missing',
  unknown: 'unsupported_state', network: 'api_connection_error', snapshotId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'} as const;
const errors: unknown[] = [];
afterEach(() => { expect(errors.splice(C.limits.zero)).toEqual([]); });
function contract(actual: unknown, expected: unknown) { try { expect(actual).toEqual(expected); } catch (error) { errors.push(error); throw error; } }
function sourceFixture(): RefundSource {
  return {paymentId: F.id.payment, orderId: F.id.order, paymentIntentId: F.provider.intent, capture: transferFixture().capture};
}
function providerRefund() {
  return {id: R.id as string, object: C.provider.refundObject, amount: R.amount, currency: 'chf', charge: F.provider.charge,
    payment_intent: F.provider.intent, status: C.status.succeeded as string, created: R.created,
    balance_transaction: {id: R.debit, source: R.id as string, type: C.kind.debit as string, amount: R.debitAmount, currency: 'usd',
      fee: R.fee, net: R.net, created: R.created, available_on: R.available},
  };
}
function reader() {
  const source = sourceFixture(), calls: string[] = [], charge = {...stripeFixture(transferFixture().instruction).state.charge, amount_refunded: R.amount as number};
  const state = {pages: [{data: [providerRefund()] as unknown[], has_more: false}], charge, after: undefined as typeof charge | undefined,
    fail: null as string | null, reads: C.limits.zero as number};
  const client = {
    charges: {async retrieve(id: string, params: unknown, options: unknown) {
      calls.push('charge'); contract([id, params, options], [F.provider.charge, {expand: ['balance_transaction']}, {timeout: 10000, maxNetworkRetries: 0}]);
      if (state.fail === 'charge') throw {code: R.network};
      state.reads++; return state.reads > C.limits.one && state.after ? state.after : state.charge;
    }},
    refunds: {async list(params: {starting_after?: string}, options: unknown) {
      calls.push('refunds'); contract([params, options], [{charge: F.provider.charge, limit: 100, starting_after: params.starting_after,
        expand: ['data.balance_transaction', 'data.failure_balance_transaction']}, {timeout: 10000, maxNetworkRetries: 0}]);
      if (state.fail) throw {code: state.fail};
      const index = params.starting_after === undefined ? C.limits.zero : C.limits.one;
      return state.pages[index];
    }},
  } as unknown as RefundSettlementClient;
  return {source, state, calls, client, read: () => {state.reads = C.limits.zero; return readStripeRefundSettlement(client, source, false);}};
}
async function observed(): Promise<RefundSnapshot> {
  const result = await reader().read(); expect(result.kind).toBe(C.result.observed);
  if (result.kind !== C.result.observed) throw new Error(C.validation.snapshot);
  return result.snapshot;
}
describe('refund settlement provider boundary', () => {
  it('preserves the actual refund debit and fee without reusing the capture FX rate', async () => {
    const s = reader(), result = await s.read(); expect(result.kind).toBe(C.result.observed);
    if (result.kind !== C.result.observed) return;
    expect(result.snapshot.items[C.limits.zero]).toMatchObject({amount: 5000, currency: 'CHF', debit: {amount: -6100, feeAmount: 25, netAmount: -6125, currency: 'USD'}, failure: null});
    expect(refundSnapshotComplete(result.snapshot)).toBe(true); expect(refundBalanceTotals(result.snapshot)).toEqual({amount: -6100, feeAmount: 25, netAmount: -6125});
    expect(s.calls).toEqual(['charge', 'refunds', 'charge']);
  });
  it('records an actual empty scan only after complete source reads', async () => {
    const s = reader(); s.state.pages[C.limits.zero].data = []; s.state.charge.amount_refunded = C.limits.zero;
    const result = await s.read(); expect(result.kind).toBe(C.result.observed);
    if (result.kind === C.result.observed) { expect(result.snapshot.items).toEqual([]); expect(refundSnapshotComplete(result.snapshot)).toBe(true); }
  });
  it('follows pages and preserves separate refund identities', async () => {
    const s = reader(), other = {...providerRefund(), id: R.otherId, balance_transaction: {...providerRefund().balance_transaction, id: R.failure, source: R.otherId}};
    s.state.pages = [{data: [providerRefund()], has_more: true}, {data: [other], has_more: false}]; s.state.charge.amount_refunded = R.amount + R.amount;
    const result = await s.read(); expect(result.kind).toBe(C.result.observed);
    if (result.kind === C.result.observed) expect(result.snapshot.items.map(row => row.refundId)).toEqual([R.id, R.otherId]);
  });
  it('rejects duplicate identities, empty continuing pages and unknown statuses', async () => {
    const s = reader(); s.state.pages = [{data: [providerRefund()], has_more: true}, {data: [providerRefund()], has_more: false}];
    expect((await s.read()).kind).toBe(C.result.review);
    s.state.pages = [{data: [], has_more: true}]; expect((await s.read()).kind).toBe(C.result.review);
    s.state.pages = [{data: [{...providerRefund(), status: R.unknown}], has_more: false}]; expect((await s.read()).kind).toBe(C.result.review);
  });
  it('distinguishes an outage and a missing source from an empty history', async () => {
    const s = reader(); s.state.fail = R.network;
    expect(await s.read()).toEqual({kind: C.result.retry, reason: C.failure.unavailable});
    s.state.fail = R.missing; expect(await s.read()).toEqual({kind: C.result.review, reason: C.failure.missing});
  });
  it('does not publish a scan if a refund or dispute changed during enumeration', async () => {
    const s = reader(); s.state.after = {...s.state.charge, amount_refunded: R.amount + C.limits.one};
    expect(await s.read()).toEqual({kind: C.result.retry, reason: C.failure.changed});
    s.state.after = {...s.state.charge, disputed: true}; expect(await s.read()).toEqual({kind: C.result.retry, reason: C.failure.changed});
  });
  it('rejects another capture balance or a different refund owner', async () => {
    const s = reader(); s.state.charge.balance_transaction.net -= C.limits.one;
    expect((await s.read()).kind).toBe(C.result.review);
    const other = reader(); other.state.pages[C.limits.zero].data = [{...providerRefund(), payment_intent: R.unknown}];
    expect((await other.read()).kind).toBe(C.result.review);
  });
  it('refuses unexpected currencies and unexpanded balance references', async () => {
    const s = reader(); s.state.pages[C.limits.zero].data = [{...providerRefund(), balance_transaction: R.debit}];
    expect((await s.read()).kind).toBe(C.result.review);
    s.state.pages[C.limits.zero].data = [{...providerRefund(), balance_transaction: {...providerRefund().balance_transaction, currency: 'eur'}}];
    expect((await s.read()).kind).toBe(C.result.review);
  });
  it('records pending or balance-pending observations without calling them complete', async () => {
    const s = reader(); s.state.pages[C.limits.zero].data = [{...providerRefund(), status: C.status.pending, balance_transaction: null}];
    const pending = await s.read(); expect(pending.kind).toBe(C.result.observed);
    if (pending.kind === C.result.observed) expect(refundSnapshotComplete(pending.snapshot)).toBe(false);
    s.state.pages[C.limits.zero].data = [{...providerRefund(), balance_transaction: null}];
    const missing = await s.read(); expect(missing.kind).toBe(C.result.observed);
    if (missing.kind === C.result.observed) expect(refundSnapshotComplete(missing.snapshot)).toBe(false);
  });
  it('keeps the actual failed-refund restoring movement and any remaining fee', async () => {
    const s = reader(); s.state.charge.amount_refunded = C.limits.zero;
    s.state.pages[C.limits.zero].data = [{...providerRefund(), status: C.status.failed, failure_balance_transaction: {
      ...providerRefund().balance_transaction, id: R.failure, type: C.kind.failure, amount: R.failureAmount, fee: C.limits.zero, net: R.failureAmount,
    }}];
    const result = await s.read(); expect(result.kind).toBe(C.result.observed);
    if (result.kind === C.result.observed) { expect(refundSnapshotComplete(result.snapshot)).toBe(true); expect(refundBalanceTotals(result.snapshot).netAmount).toBe(-R.fee); }
  });
  it('waits for the restoring movement of a failed refund and permits a failed attempt with no movement', async () => {
    const s = reader(); s.state.charge.amount_refunded = C.limits.zero;
    s.state.pages[C.limits.zero].data = [{...providerRefund(), status: C.status.failed}];
    let result = await s.read(); if (result.kind !== C.result.observed) throw new Error(C.validation.snapshot);
    expect(refundSnapshotComplete(result.snapshot)).toBe(false);
    s.state.pages[C.limits.zero].data = [{...providerRefund(), status: C.status.failed, balance_transaction: null}];
    result = await s.read(); if (result.kind !== C.result.observed) throw new Error(C.validation.snapshot);
    expect(refundSnapshotComplete(result.snapshot)).toBe(true);
  });
  it('refuses a live/test mismatch before provider access', async () => {
    const s = reader(); expect((await readStripeRefundSettlement(s.client, s.source, true)).kind).toBe(C.result.review); expect(s.calls).toEqual([]);
  });
});
describe('refund settlement canonical document', () => {
  it('rejects missing required nullable fields, conflicting balances and duplicate refunds', async () => {
    const snapshot = await observed(), item = snapshot.items[C.limits.zero], {failure, ...missing} = item;
    expect(refundSnapshotSchema.safeParse({...snapshot, items: [missing]}).success).toBe(false);
    expect(refundSnapshotSchema.safeParse({...snapshot, items: [item, item]}).success).toBe(false);
    expect(refundSnapshotSchema.safeParse({...snapshot, items: [{...item, debit: {...item.debit, netAmount: C.limits.zero}}]}).success).toBe(false);
  });
  it('does not call an unmatched charge refund counter complete', async () => {
    const snapshot = await observed(); snapshot.amountRefunded += C.limits.one;
    expect(refundSnapshotSchema.safeParse(snapshot).success).toBe(true); expect(refundSnapshotComplete(snapshot)).toBe(false);
  });
  it('requires current generation and a complete scan before synced', async () => {
    const snapshot = await observed(), doc = {source: snapshot.source, state: C.state.synced, asOf: snapshot.observedAt, generation: C.limits.one,
      observedGeneration: C.limits.one, failureCode: null, nextAttemptAt: null,
      snapshot: {...snapshot, id: R.snapshotId, generation: C.limits.one, recordedAt: snapshot.observedAt}};
    expect(refundDocumentSchema.safeParse(doc).success).toBe(true);
    expect(refundDocumentSchema.safeParse({...doc, snapshot: null}).success).toBe(false);
    expect(refundDocumentSchema.safeParse({...doc, generation: C.limits.one + C.limits.one}).success).toBe(false);
    expect(refundDocumentSchema.safeParse({...doc, snapshot: {...doc.snapshot, amountRefunded: C.limits.zero}}).success).toBe(false);
  });
});
describe('refund settlement administration boundary', () => {
  function service(access: IdentityAccess = {status: 'active', roles: ['admin']}) {
    const source = sourceFixture(), calls: unknown[] = [], doc = refundDocumentSchema.parse({source, state: C.state.queued,
      asOf: F.date.created, generation: C.limits.one, observedGeneration: C.limits.zero, failureCode: null, nextAttemptAt: F.date.created, snapshot: null});
    const repository: RefundSettlementRepository = {async transaction(write, operation) {calls.push(write); return operation(repository);},
      async access(actor, write) {calls.push({actor, write}); return {status: access.status, roles: [...access.roles]};},
      async source() {return source;}, async request(id) {calls.push(id);}, async requestCharge(chargeId, liveMode) {calls.push({chargeId, liveMode}); return true;},
      async document() {return doc;}, async claim() {return [];}, async finish() {return false;}};
    return {value: new RefundSettlementsService(repository, reader().client), repository, calls, doc};
  }
  it('reads only after active administration authorization', async () => {
    const s = service(); expect(await s.value.document(F.id.operation, F.id.payment)).toEqual(s.doc);
    expect(s.calls).toEqual([false, {actor: F.id.operation, write: false}]);
  });
  it('queues through locked authorization without accepting a client amount', async () => {
    const s = service(); await s.value.synchronize(F.id.operation, F.id.payment, {});
    expect(s.calls).toEqual([true, {actor: F.id.operation, write: true}, F.id.payment]);
    expect(() => s.value.synchronize(F.id.operation, F.id.payment, {amount: R.amount})).toThrow();
  });
  it('requests only a valid charge in the configured mode', async () => {
    const s = service(); expect(await s.value.requestCharge(F.provider.charge, true)).toBe(false);
    expect(await s.value.requestCharge(R.unknown, false)).toBe(false); expect(s.calls).toEqual([]);
    expect(await s.value.requestCharge(F.provider.charge, false)).toBe(true); expect(s.calls).toEqual([{chargeId: F.provider.charge, liveMode: false}]);
  });
  it('rejects non-admin and suspended access before enqueue', async () => {
    for (const access of [{status: 'active', roles: ['customer']}, {status: 'suspended', roles: ['admin']}] satisfies IdentityAccess[]) {
      const s = service(access); await expect(s.value.synchronize(F.id.operation, F.id.payment, {})).rejects.toMatchObject({status: 403});
      expect(s.calls).not.toContain(F.id.payment);
    }
  });
  it('distinguishes an absent capture and an invalid identifier from empty refunds', async () => {
    const s = service(); s.repository.document = async () => undefined;
    await expect(s.value.document(F.id.operation, F.id.payment)).rejects.toMatchObject({status: 404});
    await expect(s.value.document(F.id.operation, R.unknown)).rejects.toMatchObject({status: 400});
  });
});

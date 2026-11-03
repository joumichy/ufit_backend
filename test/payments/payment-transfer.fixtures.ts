import {afterEach, expect} from 'vitest';
import {calculatePaymentAllocation} from '../../src/modules/payments/domain/payment-allocation';
import {makeTransferInstruction, transferGroup, transferMetadata, PAYMENT_TRANSFER as C,
  type TransferInstruction, type ReversalInstruction} from '../../src/modules/payments/domain/payment-transfer';
import type {StripeTransferClient} from '../../src/modules/payments/infrastructure/stripe-transfer-reconciliation';
import {CONNECT} from '../../src/modules/payments/domain/connect-account';
import {STRIPE_ORDER_METADATA} from '../../src/modules/payments/application/stripe-commerce';

export const F = {
  id: {operation: '11111111-1111-4111-8111-111111111111', payment: '22222222-2222-4222-8222-222222222222',
    order: '33333333-3333-4333-8333-333333333333', brand: '44444444-4444-4444-8444-444444444444',
    creator: '55555555-5555-4555-8555-555555555555', policy: '66666666-6666-4666-8666-666666666666',
    commission: '77777777-7777-4777-8777-777777777777', account: '88888888-8888-4888-8888-888888888888',
    reversal: '99999999-9999-4999-8999-999999999999', other: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},
  provider: {intent: 'pi_TransferFixture', charge: 'ch_TransferFixture', balance: 'txn_TransferFixture', account: 'acct_TransferFixture',
    transfer: 'tr_TransferFixture', reversal: 'trr_TransferFixture', otherTransfer: 'tr_OtherFixture', otherAccount: 'acct_OtherFixture'},
  date: {capture: '2026-11-03T00:00:00.000Z', available: '2026-11-05T00:00:00.000Z', created: '2026-11-06T00:00:00.000Z'},
  money: {subtotal: 10000, shipping: 800, tax: 200, total: 11000, creator: 1000, gross: 13200, fee: 350, net: 12850,
    platformBps: 500, creatorSettled: 1200, brandSettled: 11050, reversal: 200, tooMuch: 1201},
  currency: {purchase: 'CHF', settlement: 'USD', different: 'EUR'}, country: 'CH',
  unrelated: 'other-operation', failure: 'Controlled provider failure', unknown: 'unknownField',
  calls: {list: 'list', retrieve: 'retrieve', account: 'account', charge: 'charge', refunds: 'refunds',
    create: 'create', reversalList: 'reversal-list', reversalRead: 'reversal-read', reversalCreate: 'reversal-create', authorize: 'authorize'},
} as const;
export function transferFixture(kind: TransferInstruction['recipient']['kind'] = C.kind.creator) {
  const capture = {chargeId: F.provider.charge, balanceTransactionId: F.provider.balance, chargeAmount: F.money.total,
    chargeCurrency: F.currency.purchase, settlementAmount: F.money.gross, settlementCurrency: F.currency.settlement,
    feeAmount: F.money.fee, netAmount: F.money.net, capturedAt: F.date.capture, availableAt: F.date.available, liveMode: false};
  const plan = {...calculatePaymentAllocation({paymentId: F.id.payment, orderId: F.id.order, brandId: F.id.brand, policyId: F.id.policy,
    platformRateBps: F.money.platformBps, feeBearer: C.kind.brand, subtotal: F.money.subtotal, shipping: F.money.shipping,
    tax: F.money.tax, total: F.money.total, currency: F.currency.purchase,
    creatorCommissions: [{creatorId: F.id.creator, commissionId: F.id.commission, amount: F.money.creator}], receipt: capture}), createdAt: F.date.created};
  const profileId = kind === C.kind.brand ? F.id.brand : F.id.creator;
  const account = {id: F.id.account, kind, profileId, country: F.country, liveMode: false, stripeAccountId: F.provider.account, snapshot: null};
  const key = kind === C.kind.brand ? `${kind}/${profileId}` : `${kind}/${profileId}/${F.id.commission}`;
  const refunds = {source: {paymentId: F.id.payment, orderId: F.id.order, paymentIntentId: F.provider.intent, capture},
    observedAt: F.date.created, amountRefunded: C.zero, disputed: false, items: []};
  return {plan, capture, account, refunds, instruction: makeTransferInstruction(F.id.operation, F.provider.intent, plan, capture, key, account, refunds)};
}
export function providerTransfer(instruction: TransferInstruction) {
  return {id: F.provider.transfer as string, object: C.provider.transferObject, amount: instruction.amount,
    currency: instruction.currency.toLowerCase(), destination: instruction.account.stripeAccountId as string,
    source_transaction: instruction.funding === C.funding.charge ? instruction.capture.chargeId : null, transfer_group: transferGroup(instruction), livemode: instruction.capture.liveMode,
    created: Date.parse(F.date.created) / C.provider.millisecondsPerSecond, amount_reversed: C.zero as number, reversed: false,
    metadata: transferMetadata(instruction)};
}
export function reversalFixture(original: TransferInstruction): ReversalInstruction {
  return {id: F.id.reversal, original, transferId: F.provider.transfer, amount: F.money.reversal, expectedReversedAmount: C.zero};
}
export function providerReversal(instruction: ReversalInstruction) {
  return {id: F.provider.reversal as string, object: C.provider.reversalObject, amount: instruction.amount,
    currency: instruction.original.currency.toLowerCase(), transfer: instruction.transferId,
    created: Date.parse(F.date.created) / C.provider.millisecondsPerSecond,
    metadata: {...transferMetadata(instruction.original), [C.provider.metadata.reversal]: instruction.id}};
}
type Call = {method: string; args: unknown[]};
const contractFailures: unknown[] = [];
afterEach(() => { const failures = contractFailures.splice(C.zero); expect(failures).toEqual([]); });
function contract(actual: unknown, expected: unknown) {
  try { expect(actual).toEqual(expected); } catch (error) { contractFailures.push(error); throw error; }
}
/** Checks SDK arity, canonical request bodies and options independently of the implementation. */
export function stripeFixture(instruction: TransferInstruction) {
  const options = {timeout: 10000, maxNetworkRetries: 0};
  const reversal = reversalFixture(instruction), calls: Call[] = [];
  const state = {
    pages: [{data: [] as unknown[], has_more: false}], reversalPages: [{data: [] as unknown[], has_more: false}],
    transfer: providerTransfer(instruction), reversal: providerReversal(reversal), refunds: [] as Array<Record<string, unknown>>,
    account: {id: instruction.account.stripeAccountId, country: instruction.account.country, details_submitted: true,
      charges_enabled: true, payouts_enabled: true, capabilities: {transfers: CONNECT.capabilityActive},
      requirements: {currently_due: [] as string[], past_due: [], pending_verification: [], disabled_reason: null},
      metadata: {[CONNECT.metadata.associationId]: instruction.account.id, [CONNECT.metadata.profileId]: instruction.recipient.beneficiaryId,
        [CONNECT.metadata.kind]: instruction.recipient.kind}},
    charge: {id: instruction.capture.chargeId, payment_intent: instruction.paymentIntentId, livemode: false, paid: true, captured: true,
      status: C.provider.succeeded, amount: instruction.capture.chargeAmount, amount_captured: instruction.capture.chargeAmount,
      currency: instruction.capture.chargeCurrency.toLowerCase(), amount_refunded: C.zero as number, refunded: false, disputed: false,
      created: Date.parse(instruction.capture.capturedAt) / C.provider.millisecondsPerSecond,
      metadata: {[STRIPE_ORDER_METADATA.orderId]: instruction.orderId}, balance_transaction: {id: instruction.capture.balanceTransactionId,
        source: instruction.capture.chargeId, type: C.provider.balanceType, amount: instruction.capture.settlementAmount,
        currency: instruction.capture.settlementCurrency.toLowerCase(), net: instruction.capture.netAmount, fee: instruction.capture.feeAmount,
        available_on: Date.parse(instruction.capture.availableAt) / C.provider.millisecondsPerSecond}},
    failures: new Set<string>(), failAtCursor: null as string | null, loseTransferResponse: false, loseReversalResponse: false,
  };
  const call = (method: string, args: unknown[]) => { calls.push({method, args}); if (state.failures.has(method)) throw new Error(F.failure); };
  const page = (pages: typeof state.pages, cursor?: string) => {
    if (cursor === undefined) return pages[C.zero];
    const previous = pages.findIndex(p => (p.data.at(-C.one) as {id?: string})?.id === cursor);
    return pages[previous + C.one];
  };
  const sdk = {
    transfers: {
      async list(params: {starting_after?: string}, request: unknown) {
        call(F.calls.list, [params, request]); contract(request, options);
        contract(params, {transfer_group: 'order:' + instruction.orderId, destination: instruction.account.stripeAccountId, limit: 100, starting_after: params.starting_after});
        if (params.starting_after === state.failAtCursor) throw new Error(F.failure);
        return page(state.pages, params.starting_after);
      },
      async retrieve(id: string, params: unknown, request: unknown) {
        call(F.calls.retrieve, [id, params, request]); contract([id, params, request], [state.transfer.id, {}, options]); return state.transfer;
      },
      async create(params: unknown, request: unknown) {
        call(F.calls.create, [params, request]);
        contract(params, {amount: instruction.amount, currency: 'usd', destination: F.provider.account,
          ...(instruction.funding === C.funding.charge ? {source_transaction: F.provider.charge} : {}),
          transfer_group: 'order:' + instruction.orderId, metadata: {ufit_transfer_operation_id: instruction.id, ufit_payment_id: instruction.paymentId, ufit_allocation_key: instruction.allocationKey, ufit_transfer_funding: instruction.funding}});
        contract(request, {...options, idempotencyKey: 'ufit-transfer:' + instruction.id});
        if (state.loseTransferResponse) { state.pages = [{data: [state.transfer], has_more: false}]; throw new Error(F.failure); }
        return state.transfer;
      },
      async listReversals(id: string, params: {starting_after?: string}, request: unknown) {
        call(F.calls.reversalList, [id, params, request]); contract([id, params, request], [F.provider.transfer, {limit: 100, starting_after: params.starting_after}, options]);
        return page(state.reversalPages, params.starting_after);
      },
      async retrieveReversal(id: string, reversalId: string, params: unknown, request: unknown) {
        call(F.calls.reversalRead, [id, reversalId, params, request]); contract([id, reversalId, params, request], [F.provider.transfer, F.provider.reversal, {}, options]); return state.reversal;
      },
      async createReversal(id: string, params: unknown, request: unknown) {
        call(F.calls.reversalCreate, [id, params, request]);
        contract([id, params, request], [F.provider.transfer, {amount: F.money.reversal, metadata: {ufit_transfer_operation_id: instruction.id,
          ufit_payment_id: instruction.paymentId, ufit_allocation_key: instruction.allocationKey, ufit_transfer_funding: instruction.funding, ufit_reversal_operation_id: F.id.reversal}},
        {...options, idempotencyKey: 'ufit-transfer-reversal:' + F.id.reversal}]);
        if (state.loseReversalResponse) { state.reversalPages = [{data: [state.reversal], has_more: false}]; throw new Error(F.failure); }
        return state.reversal;
      },
    },
    accounts: {async retrieve(id: string, params: unknown, request: unknown) {
      call(F.calls.account, [id, params, request]); contract([id, params, request], [F.provider.account, {}, options]); return state.account;
    }},
    charges: {async retrieve(id: string, params: unknown, request: unknown) {
      call(F.calls.charge, [id, params, request]); contract([id, params, request], [F.provider.charge, {expand: ['balance_transaction']}, options]); return state.charge;
    }},
    refunds: {async list(params: unknown, request: unknown) {
      call(F.calls.refunds, [params, request]);
      contract([params, request], [{charge: F.provider.charge, limit: 100, starting_after: undefined,
        expand: ['data.balance_transaction', 'data.failure_balance_transaction']}, options]);
      return {data: state.refunds, has_more: false};
    }},
  };
  const authorize = async () => { call(F.calls.authorize, []); return {allowed: true as const}; };
  return {client: sdk as unknown as StripeTransferClient, state, calls, authorize, reversal,
    methods: () => calls.map(row => row.method), count: (method: string) => calls.filter(row => row.method === method).length};
}

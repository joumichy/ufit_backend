import {describe, expect, it} from 'vitest';
import {getTableColumns, is} from 'drizzle-orm';
import {PgTable} from 'drizzle-orm/pg-core';
import type {DatabaseSession} from '../../src/shared/infrastructure/database/database-session';
import {orders, payments, orderItems, outfits, commissions, orderDistributionTerms, paymentDistributionPolicies,
  paymentSettlements, orderReturns, orderReturnItems, returnRefundFinancialFacts, orderCancellations,
  externalRefundSettlements, refundOrganizationCases} from '../../src/shared/infrastructure/database/schema';
import {CANCELLATION, ORDER_PAYMENT, ORDER_STATUS} from '../../src/modules/orders/domain/order-lifecycle';
import {PAYMENT_ALLOCATION as C, calculatePaymentAllocation, type StoredAllocationPlan} from '../../src/modules/payments/domain/payment-allocation';
import {readPaymentAllocationSource} from '../../src/modules/payments/infrastructure/payment-allocation-source';
import {readDisbursementBusiness} from '../../src/modules/payments/infrastructure/payment-disbursement-business';

const F = {
  payment: '51111111-1111-4111-8111-111111111111', order: '52222222-2222-4222-8222-222222222222',
  brand: '53333333-3333-4333-8333-333333333333', otherBrand: '54444444-4444-4444-8444-444444444444',
  outfit: '55555555-5555-4555-8555-555555555555', item: '56666666-6666-4666-8666-666666666666',
  creator: '57777777-7777-4777-8777-777777777777', commission: '58888888-8888-4888-8888-888888888888',
  policy: '59999999-9999-4999-8999-999999999999', at: '2026-11-19T18:00:00.000Z',
  cancellation: '50000000-0000-4000-8000-000000000001',
  intent: 'pi_BrandOutfit', charge: 'ch_BrandOutfit', balance: 'txn_BrandOutfit',
  otherIntent: 'pi_OtherOrder', paymentPending: 'pending', otherCurrency: 'EUR',
  currency: 'CHF', settlementCurrency: 'USD', total: 1000, settled: 1186, fee: 76, net: 1110,
  rate: '0.0000', creatorRate: '0.2000', creatorAmount: 200, platformRate: 1000,
  zero: 0, quantity: 1, feeBearer: 'brand', sourceFailure: 'source database unavailable', archived: 'archived', published: 'published',
} as const;

function scenario(creator = false) {
  const order = {id: F.order, brandId: F.brand, status: ORDER_STATUS.paid, subtotalAmount: F.total,
    taxAmount: F.zero, shippingAmount: F.zero, totalAmount: F.total, currency: F.currency,
    stripePaymentIntentId: F.intent} as typeof orders.$inferSelect;
  const item: Pick<typeof orderItems.$inferSelect, 'id' | 'orderId' | 'sourceCreatorId' | 'sourceOutfitId' | 'commissionRate' | 'quantity' | 'unitPrice' | 'totalPrice'> = {
    id: F.item, orderId: F.order, sourceCreatorId: creator ? F.creator : null, sourceOutfitId: F.outfit,
    commissionRate: creator ? F.creatorRate : F.rate, quantity: F.quantity, unitPrice: F.total, totalPrice: F.total};
  const source: Pick<typeof outfits.$inferSelect, 'id' | 'creatorId' | 'brandId' | 'status'> = {
    id: F.outfit, creatorId: creator ? F.creator : null, brandId: creator ? null : F.brand, status: F.published};
  const policy = {id: F.policy, brandId: F.brand, active: true, platformRateBps: F.platformRate, feeBearer: F.feeBearer};
  const receipt: typeof paymentSettlements.$inferSelect = {paymentId: F.payment, chargeId: F.charge, balanceTransactionId: F.balance,
    chargeAmount: F.total, chargeCurrency: F.currency, settlementAmount: F.settled, settlementCurrency: F.settlementCurrency,
    feeAmount: F.fee, netAmount: F.net, capturedAt: new Date(F.at), availableAt: new Date(F.at), liveMode: false,
    recordedAt: new Date(F.at)};
  const entry: Pick<typeof commissions.$inferSelect, 'id' | 'orderItemId' | 'creatorId' | 'brandId' | 'sourceOutfitId' | 'baseAmount' | 'commissionRate' | 'commissionAmount'> = {
    id: F.commission, orderItemId: F.item, creatorId: F.creator, brandId: F.brand, sourceOutfitId: F.outfit,
    baseAmount: F.total, commissionRate: F.creatorRate, commissionAmount: F.creatorAmount};
  const {paymentId, recordedAt, ...capture} = receipt;
  const originalPlan = calculatePaymentAllocation({paymentId: F.payment, orderId: F.order, brandId: F.brand, policyId: F.policy,
    platformRateBps: F.platformRate, feeBearer: F.feeBearer, subtotal: F.total, shipping: F.zero, tax: F.zero,
    total: F.total, currency: F.currency, creatorCommissions: creator ? [{creatorId: F.creator, commissionId: F.commission, amount: F.creatorAmount}] : [],
    receipt: {...capture, capturedAt: F.at, availableAt: F.at}});
  const plan: StoredAllocationPlan = {...originalPlan, createdAt: F.at};
  const payment: Pick<typeof payments.$inferSelect, 'id' | 'orderId' | 'provider' | 'providerPaymentIntentId' | 'status' | 'amount' | 'currency'> = {
    id: F.payment, orderId: F.order, provider: ORDER_PAYMENT.provider, providerPaymentIntentId: F.intent,
    status: ORDER_PAYMENT.status.succeeded, amount: F.total, currency: F.currency};
  const rows = new Map<object, Record<string, unknown>[]>([
    [orders, [order]], [payments, [payment]],
    [orderItems, [item]], [outfits, [source]], [commissions, creator ? [entry] : []],
    [orderDistributionTerms, [{policy}]], [paymentSettlements, [receipt]],
    [orderReturns, []], [orderReturnItems, []], [returnRefundFinancialFacts, []], [orderCancellations, []], [externalRefundSettlements, []],
  ]);
  const reads: object[] = [];
  // This read-only adapter rejects unknown tables/columns and has no mutation methods.
  const database = {db: {select(selection?: Record<string, unknown>) {
    return {from(table: object) {
      const query = {
        where: () => query, orderBy: () => query,
        innerJoin(joined: PgTable) {
          if (table === orderDistributionTerms) expect(joined).toBe(paymentDistributionPolicies);
          else if (table === externalRefundSettlements) expect(joined).toBe(refundOrganizationCases);
          else throw new Error(F.sourceFailure);
          return query;
        },
        then(resolve: (value: Record<string, unknown>[]) => unknown, reject: (error: unknown) => unknown) {
          return Promise.resolve().then(() => {
            reads.push(table);
            const values = rows.get(table);
            if (!values) throw new Error(F.sourceFailure);
            if (!selection) return values;
            if (!is(table, PgTable)) throw new Error(F.sourceFailure);
            return values.map(row => Object.fromEntries(Object.entries(selection).map(([alias, column]) => {
              if (column === paymentDistributionPolicies) return [alias, row.policy];
              const property = Object.entries(getTableColumns(table)).find(([, candidate]) => candidate === column)?.[C.limit.zero];
              if (!property) throw new Error(F.sourceFailure);
              return [alias, row[property]];
            })));
          }).then(resolve, reject);
        },
      };
      return query;
    }};
  }}} as unknown as DatabaseSession;
  return {order, item, source, entry, payment, receipt, rows, database, reads, plan};
}

function cancelledScenario(external = false) {
  const value = scenario(); value.order.status = ORDER_STATUS.cancelled;
  value.payment.status = external ? ORDER_PAYMENT.status.succeeded : ORDER_PAYMENT.status.refunded;
  const cancellation: Pick<typeof orderCancellations.$inferSelect, 'id' | 'status' | 'effectsApplied' | 'paymentOutcome'> = {
    id: F.cancellation, status: CANCELLATION.status.succeeded, effectsApplied: true,
    paymentOutcome: external ? CANCELLATION.outcome.refundedExternally : CANCELLATION.outcome.refunded,
  };
  value.rows.set(orderCancellations, [cancellation]);
  return {...value, cancellation};
}

async function expectRejected(value: ReturnType<typeof scenario>) {
  expect(await readPaymentAllocationSource(value.database, F.payment, false)).toMatchObject({plan: null, blockReason: C.block.basis});
  await expect(readDisbursementBusiness(value.database, value.order, value.plan)).rejects.toThrow();
}

describe('financial sources of brand publications', () => {
  it('allocates and reconciles a same-brand outfit without inventing a creator commission', async () => {
    const value = scenario();
    const result = await readPaymentAllocationSource(value.database, F.payment, false);
    const {createdAt, ...expectedPlan} = value.plan;
    expect(result?.plan).toEqual(expectedPlan);
    expect(result?.plan?.lines.map(line => line.recipient.kind)).toEqual([C.kind.brand, C.kind.platform]);
    expect(result?.plan?.lines.reduce((total, line) => total + line.netAmount, F.zero as number)).toBe(F.net);
    expect(await readDisbursementBusiness(value.database, value.order, value.plan)).toMatchObject({
      remainingCommissions: [], merchandiseRemaining: F.total, refundLiability: F.zero, refundOutstanding: false,
    });
    expect(value.reads).toContain(outfits);
  });
  it('keeps direct purchases valid without requiring a publication', async () => {
    const value = scenario(); value.item.sourceOutfitId = null;
    expect((await readPaymentAllocationSource(value.database, F.payment, false))?.plan).not.toBeNull();
    await expect(readDisbursementBusiness(value.database, value.order, value.plan)).resolves.toMatchObject({remainingCommissions: []});
    expect(value.reads).not.toContain(outfits);
  });
  it('keeps purchased brand attribution valid after its publication is archived', async () => {
    const value = scenario(); value.source.status = F.archived;
    expect((await readPaymentAllocationSource(value.database, F.payment, false))?.plan?.brandId).toBe(F.brand);
    await expect(readDisbursementBusiness(value.database, value.order, value.plan)).resolves.toMatchObject({remainingCommissions: []});
  });
  it('preserves creator attribution and its frozen commission', async () => {
    const value = scenario(true);
    expect((await readPaymentAllocationSource(value.database, F.payment, false))?.plan?.lines
      .find(line => line.recipient.kind === C.kind.creator)?.presentmentAmount).toBe(F.creatorAmount);
    await expect(readDisbursementBusiness(value.database, value.order, value.plan)).resolves.toMatchObject({
      remainingCommissions: [{commissionId: F.commission, amount: F.creatorAmount}],
    });
  });
  it('rejects a missing source outfit', async () => {const value = scenario(); value.rows.set(outfits, []); await expectRejected(value);});
  it('rejects an outfit owned by another brand', async () => {
    const value = scenario(); value.source.brandId = F.otherBrand; await expectRejected(value);
  });
  it('rejects a creator-owned outfit whose frozen creator is missing', async () => {
    const value = scenario(); value.source.creatorId = F.creator; value.source.brandId = null; await expectRejected(value);
  });
  it('rejects ownerless and contradictory dual-owner outfits', async () => {
    for (const creatorId of [null, F.creator]) {
      const value = scenario(); value.source.brandId = creatorId ? F.brand : null; value.source.creatorId = creatorId;
      await expectRejected(value);
    }
  });
  it('rejects a commission rate on an unattributed brand purchase', async () => {
    const value = scenario(); value.item.commissionRate = F.creatorRate; await expectRejected(value);
  });
  it('rejects an unexpected commission row on a brand purchase', async () => {
    const value = scenario(); value.rows.set(commissions, [value.entry]); await expectRejected(value);
  });
  it('preserves refusal of a creator commission attributed to another source', async () => {
    const value = scenario(true); value.entry.sourceOutfitId = F.item; await expectRejected(value);
  });
  it('propagates source database failure instead of presenting a valid or empty financial source', async () => {
    const value = scenario(); value.rows.delete(outfits);
    await expect(readPaymentAllocationSource(value.database, F.payment, false)).rejects.toThrow(F.sourceFailure);
    await expect(readDisbursementBusiness(value.database, value.order, value.plan)).rejects.toThrow(F.sourceFailure);
  });
});

describe('reconstruction of captured cancelled orders', () => {
  it.each([ORDER_STATUS.cancelled, ORDER_STATUS.refunded])('preserves the original captured amount and fee after %s', async status => {
    const value = cancelledScenario(); value.order.status = status;
    const result = await readPaymentAllocationSource(value.database, F.payment, false);
    expect(result?.plan).toMatchObject({presentmentAmount: F.total, settlementAmount: F.settled, feeAmount: F.fee, netAmount: F.net});
  });
  it('recognizes completed external cancellation compensation without inventing a Stripe refund state', async () => {
    const value = cancelledScenario(true);
    expect((await readPaymentAllocationSource(value.database, F.payment, false))?.plan?.paymentId).toBe(F.payment);
    expect(value.payment.status).toBe(ORDER_PAYMENT.status.succeeded);
  });
  it('preserves the existing refunded-order path for an externally compensated capture', async () => {
    const value = scenario(); value.order.status = ORDER_STATUS.refunded;
    expect((await readPaymentAllocationSource(value.database, F.payment, false))?.plan?.paymentId).toBe(F.payment);
  });
  it.each([ORDER_STATUS.cancelled, ORDER_STATUS.refunded])('requires an actual capture receipt even when the order is %s', async status => {
    const value = cancelledScenario(); value.order.status = status; value.rows.set(paymentSettlements, []);
    expect(await readPaymentAllocationSource(value.database, F.payment, false)).toMatchObject({plan: null, blockReason: C.block.settlement});
  });
  it('rejects a pending payment despite a claimed cancelled order and a receipt', async () => {
    const value = cancelledScenario(); value.payment.status = F.paymentPending;
    expect(await readPaymentAllocationSource(value.database, F.payment, false)).toMatchObject({plan: null, blockReason: C.block.basis});
  });
  it('does not make a pending-payment order eligible from a refund label alone', async () => {
    const value = cancelledScenario(); value.order.status = ORDER_STATUS.pendingPayment;
    expect(await readPaymentAllocationSource(value.database, F.payment, false)).toMatchObject({plan: null, blockReason: C.block.fulfillment});
  });
  it.each([CANCELLATION.status.requested, CANCELLATION.status.failed])('refuses cancellation compensation still %s', async status => {
    const value = cancelledScenario(); value.cancellation.status = status;
    expect(await readPaymentAllocationSource(value.database, F.payment, false)).toMatchObject({plan: null, blockReason: C.block.fulfillment});
  });
  it('requires the canonical cancellation and its completed physical effects', async () => {
    const value = cancelledScenario(); value.rows.set(orderCancellations, []);
    expect(await readPaymentAllocationSource(value.database, F.payment, false)).toMatchObject({plan: null, blockReason: C.block.fulfillment});
    value.rows.set(orderCancellations, [value.cancellation]); value.cancellation.effectsApplied = false;
    expect(await readPaymentAllocationSource(value.database, F.payment, false)).toMatchObject({plan: null, blockReason: C.block.fulfillment});
  });
  it.each([CANCELLATION.outcome.notCharged, null])('refuses an uncaptured cancellation outcome: %s', async paymentOutcome => {
    const value = cancelledScenario(); value.cancellation.paymentOutcome = paymentOutcome;
    expect(await readPaymentAllocationSource(value.database, F.payment, false)).toMatchObject({plan: null, blockReason: C.block.fulfillment});
  });
  it('refuses conflicting canonical payment and cancellation refund outcomes', async () => {
    for (const external of [false, true]) {
      const value = cancelledScenario(external);
      value.payment.status = external ? ORDER_PAYMENT.status.refunded : ORDER_PAYMENT.status.succeeded;
      expect(await readPaymentAllocationSource(value.database, F.payment, false)).toMatchObject({plan: null, blockReason: C.block.fulfillment});
    }
  });
  it('refuses a receipt belonging to another payment', async () => {
    const value = cancelledScenario(); value.receipt.paymentId = F.order;
    expect(await readPaymentAllocationSource(value.database, F.payment, false)).toMatchObject({plan: null, blockReason: C.block.basis});
  });
  it('refuses contradictory capture money, currency, identity or conservation', async () => {
    for (const corrupt of [
      (value: ReturnType<typeof cancelledScenario>) => {value.receipt.chargeAmount += F.quantity;},
      (value: ReturnType<typeof cancelledScenario>) => {value.receipt.chargeCurrency = F.otherCurrency;},
      (value: ReturnType<typeof cancelledScenario>) => {value.payment.providerPaymentIntentId = F.otherIntent;},
      (value: ReturnType<typeof cancelledScenario>) => {value.receipt.netAmount += F.quantity;},
    ]) {
      const value = cancelledScenario(); corrupt(value);
      expect(await readPaymentAllocationSource(value.database, F.payment, false)).toMatchObject({plan: null, blockReason: C.block.basis});
    }
  });
});

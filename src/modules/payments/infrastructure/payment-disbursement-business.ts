import {ConflictException} from '@nestjs/common';
import {and, asc, eq, inArray, isNotNull} from 'drizzle-orm';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {orders, orderItems, commissions, orderReturns, orderReturnItems, orderReturnRefunds, orderCancellations, orderCancellationRefunds,
  orderDistributionTerms, paymentDistributionPolicies, externalRefundSettlements, refundOrganizationCases, returnRefundFinancialFacts} from '../../../shared/infrastructure/database/schema';
import {ORDER_RETURN, RETURN_STATUS} from '../../orders/domain/order-return.contract';
import {CANCELLATION, CANCELLATION_REFUND} from '../../orders/domain/order-lifecycle';
import {RETURN_REFUND} from '../../orders/domain/return-refund';
import {parseStoredRate, calculateCommissionAmount} from '../../commissions/domain/commission-rule.contract';
import {allocateReturnRefund, assertSameRefundAmounts, returnedCommissionAmount, type ReturnQuantity} from '../../orders/domain/return-refund-policy';
import {PAYMENT_DISBURSEMENT as C, type DisbursementBasis} from '../domain/payment-disbursement';
import {PAYMENT_ALLOCATION, type StoredAllocationPlan} from '../domain/payment-allocation';
import {hasValidNonCreatorOutfitSources} from './order-item-outfit-attribution';

type Order = typeof orders.$inferSelect;
function invalid(): never { throw new ConflictException(C.reason.sources); }
export async function readDisbursementBusiness(database: DatabaseSession, order: Order, plan: StoredAllocationPlan): Promise<{
  subtotal: number; platformRateBps: number; merchandiseRemaining: number; refundLiability: number;
  remainingCommissions: DisbursementBasis['remainingCommissions']; expectedStripeRefunds: DisbursementBasis['expectedStripeRefunds'];
  refundOutstanding: boolean; openReturnItemIds: Set<string>; cancellationOpen: boolean;
}> {
  const [policy] = await database.db.select({policy: paymentDistributionPolicies}).from(orderDistributionTerms)
    .innerJoin(paymentDistributionPolicies, eq(paymentDistributionPolicies.id, orderDistributionTerms.policyId)).where(eq(orderDistributionTerms.orderId, order.id));
  if (!policy || policy.policy.id !== plan.policyId || policy.policy.brandId !== order.brandId || !policy.policy.active
    || policy.policy.feeBearer !== plan.feeBearer) invalid();
  const items = await database.db.select().from(orderItems).where(eq(orderItems.orderId, order.id)).orderBy(asc(orderItems.id));
  if (!items.length) invalid();
  if (!await hasValidNonCreatorOutfitSources(database, order.brandId, items)) invalid();
  const originals = await database.db.select().from(commissions).where(inArray(commissions.orderItemId, items.map(item => item.id)));
  let originalSubtotal = BigInt(C.zero);
  for (const item of items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity < C.one || item.unitPrice < C.zero
      || BigInt(item.unitPrice) * BigInt(item.quantity) !== BigInt(item.totalPrice)) invalid();
    originalSubtotal += BigInt(item.totalPrice);
    const entries = originals.filter(row => row.orderItemId === item.id), rate = parseStoredRate(item.commissionRate);
    if (item.sourceCreatorId === null) {
      if (entries.length !== C.zero || rate !== C.zero) invalid();
    } else {
      const [entry] = entries;
      if (entries.length !== C.one || !entry || entry.creatorId !== item.sourceCreatorId || entry.sourceOutfitId !== item.sourceOutfitId
        || entry.baseAmount !== item.totalPrice || parseStoredRate(entry.commissionRate) !== rate
        || entry.commissionAmount !== calculateCommissionAmount(item.totalPrice, rate)) invalid();
    }
  }
  if (originalSubtotal !== BigInt(order.subtotalAmount)
    || BigInt(order.subtotalAmount) + BigInt(order.taxAmount) + BigInt(order.shippingAmount) !== BigInt(order.totalAmount)) invalid();
  const expectedCreators = plan.lines.filter(line => line.recipient.kind === PAYMENT_ALLOCATION.kind.creator);
  if (expectedCreators.length !== originals.length || !expectedCreators.every(line => line.recipient.kind === PAYMENT_ALLOCATION.kind.creator
    && originals.some(row => line.recipient.kind === PAYMENT_ALLOCATION.kind.creator && row.id === line.recipient.commissionId
      && row.creatorId === line.recipient.beneficiaryId && row.brandId === order.brandId && row.commissionAmount === line.presentmentAmount))) invalid();
  const returns = await database.db.select().from(orderReturns).where(eq(orderReturns.orderId, order.id)).orderBy(asc(orderReturns.allocationNumber), asc(orderReturns.id));
  const returnItems = await database.db.select().from(orderReturnItems).where(eq(orderReturnItems.orderId, order.id));
  const facts = await database.db.select().from(returnRefundFinancialFacts).where(eq(returnRefundFinancialFacts.orderId, order.id));
  if (facts.length !== returns.length || facts.some(row => row.invalid)) invalid();
  const attempts = returns.length ? await database.db.select().from(orderReturnRefunds).where(inArray(orderReturnRefunds.returnId, returns.map(row => row.id))) : [];
  const [cancellation] = await database.db.select().from(orderCancellations).where(eq(orderCancellations.orderId, order.id));
  const cancellationRefunds = cancellation ? await database.db.select().from(orderCancellationRefunds).where(eq(orderCancellationRefunds.cancellationId, cancellation.id)) : [];
  const external = await database.db.select({amount: externalRefundSettlements.amount, currency: externalRefundSettlements.currency, cancellationId: refundOrganizationCases.cancellationId})
    .from(externalRefundSettlements).innerJoin(refundOrganizationCases, eq(refundOrganizationCases.id, externalRefundSettlements.caseId))
    .where(and(eq(externalRefundSettlements.orderId, order.id), isNotNull(refundOrganizationCases.cancellationId)));
  if (external.length > C.one || external.some(row => row.cancellationId !== cancellation?.id || row.currency !== order.currency || row.amount !== order.totalAmount)) invalid();
  const expectedStripeRefunds: DisbursementBasis['expectedStripeRefunds'] = [];
  const openReturnItemIds = new Set(returnItems.filter(row => returns.some(document => document.id === row.returnId
    && !ORDER_RETURN.terminalStatuses.some(status => status === document.status))).map(row => row.orderItemId));
  let previous: ReturnQuantity[] = [], merchandise = C.zero as number, liability = C.zero as number, outstanding = false, allocation = C.zero as number;
  const amounts = {subtotalAmount: order.subtotalAmount, taxAmount: order.taxAmount, shippingAmount: order.shippingAmount, totalAmount: order.totalAmount};
  for (const document of returns) {
    if (document.allocationNumber === null) continue;
    allocation += C.one;
    if (document.allocationNumber !== allocation || document.refundPolicyCode !== ORDER_RETURN.policy.code) invalid();
    const selected = returnItems.filter(row => row.returnId === document.id).map(row => ({orderItemId: row.orderItemId, quantity: row.quantity}));
    const allocated = allocateReturnRefund(amounts, items, previous, selected);
    assertSameRefundAmounts(allocated, {refundPolicyCode: document.refundPolicyCode,
      merchandiseAmount: document.merchandiseAmount, taxAmount: document.taxAmount, shippingAmount: document.shippingAmount,
      totalAmount: document.totalAmount, completesOrder: document.completesOrder});
    merchandise += allocated.merchandiseAmount; liability += allocated.totalAmount;
    outstanding ||= document.status !== RETURN_STATUS.refunded;
    const cumulative = new Map(previous.map(row => [row.orderItemId, row.quantity]));
    for (const row of selected) cumulative.set(row.orderItemId, (cumulative.get(row.orderItemId) ?? C.zero) + row.quantity);
    previous = [...cumulative].map(([orderItemId, quantity]) => ({orderItemId, quantity}));
  }
  for (const attempt of attempts) {
    if (attempt.state !== RETURN_REFUND.state.succeeded || attempt.amount === C.zero) continue;
    if (!attempt.stripeRefundId) invalid();
    expectedStripeRefunds.push({refundId: attempt.stripeRefundId, amount: attempt.amount});
  }
  for (const attempt of cancellationRefunds) {
    if (attempt.state !== CANCELLATION_REFUND.state.succeeded) continue;
    if (!attempt.stripeRefundId || attempt.paymentIntentId !== order.stripePaymentIntentId || attempt.amount !== order.totalAmount || attempt.currency !== order.currency) invalid();
    expectedStripeRefunds.push({refundId: attempt.stripeRefundId, amount: attempt.amount});
  }
  if (cancellation) {
    if (previous.length > C.zero || external.length > C.zero && cancellationRefunds.some(row => row.state === CANCELLATION_REFUND.state.succeeded)) invalid();
    merchandise = order.subtotalAmount; liability = order.totalAmount;
    const complete = cancellation.effectsApplied && (cancellation.paymentOutcome === CANCELLATION.outcome.refunded
      && cancellationRefunds.filter(row => row.state === CANCELLATION_REFUND.state.succeeded).length === C.one
      || cancellation.paymentOutcome === CANCELLATION.outcome.refundedExternally && external.length === C.one);
    outstanding ||= !complete;
  }
  const quantities = new Map(previous.map(row => [row.orderItemId, row.quantity]));
  const remainingCommissions = originals.map(row => {
    const item = items.find(value => value.id === row.orderItemId); if (!item) invalid();
    const returned = cancellation ? item.quantity : quantities.get(item.id) ?? C.zero;
    return {commissionId: row.id, amount: row.commissionAmount - returnedCommissionAmount(row.commissionAmount, item.quantity, returned)};
  });
  return {subtotal: order.subtotalAmount, platformRateBps: policy.policy.platformRateBps, merchandiseRemaining: order.subtotalAmount - merchandise,
    refundLiability: liability, remainingCommissions, expectedStripeRefunds, refundOutstanding: outstanding, openReturnItemIds,
    cancellationOpen: cancellation !== undefined && (!cancellation.effectsApplied || cancellation.status === CANCELLATION.status.requested)};
}

import {eq, inArray} from 'drizzle-orm';
import {z} from 'zod';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {orders, payments, orderItems, commissions, orderDistributionTerms, paymentDistributionPolicies, paymentSettlements} from '../../../shared/infrastructure/database/schema';
import {ORDER_PAYMENT, ORDER_STATUS} from '../../orders/domain/order-lifecycle';
import {COMMISSION_RULE, calculateCommissionAmount, parseStoredRate} from '../../commissions/domain/commission-rule.contract';
import {DistributionBudgetExceeded} from '../domain/payment-distribution';
import {captureReceiptSchema} from '../domain/payment-settlement';
import {PAYMENT_ALLOCATION as C, allocationBasisSchema, calculatePaymentAllocation, type AllocationPlan} from '../domain/payment-allocation';

export type AllocationSource = {orderId: string; plan: AllocationPlan; blockReason: null}
  | {orderId: string; plan: null; blockReason: typeof C.block[keyof typeof C.block]};
const fulfilledStates = [ORDER_STATUS.paid, ORDER_STATUS.preparing, ORDER_STATUS.shipped, ORDER_STATUS.delivered, ORDER_STATUS.refunded] as readonly string[];
export async function readPaymentAllocationSource(database: DatabaseSession, paymentId: string, lock: boolean): Promise<AllocationSource | undefined> {
  const [reference] = await database.db.select({orderId: payments.orderId}).from(payments).where(eq(payments.id, paymentId));
  if (!reference) return undefined;
  const query = database.db.select().from(orders).where(eq(orders.id, reference.orderId));
  const [order] = await (lock ? query.for(C.lock) : query);
  const [payment] = await database.db.select().from(payments).where(eq(payments.id, paymentId));
  const blocked = (blockReason: typeof C.block[keyof typeof C.block]): AllocationSource => ({orderId: reference.orderId, plan: null, blockReason});
  if (!order || !payment || payment.orderId !== order.id) return blocked(C.block.basis);
  const [terms] = await database.db.select({policy: paymentDistributionPolicies}).from(orderDistributionTerms)
    .innerJoin(paymentDistributionPolicies, eq(paymentDistributionPolicies.id, orderDistributionTerms.policyId)).where(eq(orderDistributionTerms.orderId, order.id));
  if (!terms) return blocked(C.block.terms);
  const [receipt] = await database.db.select().from(paymentSettlements).where(eq(paymentSettlements.paymentId, paymentId));
  if (!receipt) return blocked(C.block.settlement);
  if (!fulfilledStates.includes(order.status)) return blocked(C.block.fulfillment);
  const items = await database.db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  const recorded = items.length ? await database.db.select().from(commissions).where(inArray(commissions.orderItemId, items.map(item => item.id))) : [];
  if (payment.provider !== ORDER_PAYMENT.provider || !payment.providerPaymentIntentId || payment.providerPaymentIntentId !== order.stripePaymentIntentId
    || !Object.values(ORDER_PAYMENT.status).some(status => status === payment.status)
    || payment.amount !== order.totalAmount || payment.currency !== order.currency
    || terms.policy.brandId !== order.brandId || !terms.policy.active || !items.length) return blocked(C.block.basis);
  // Only parse/calculation failures become an invalid basis. Database outages must propagate.
  try {
    const creatorCommissions: Array<{creatorId: string; commissionId: string; amount: number}> = []; let merchandise = BigInt(C.limit.zero), expectedEntries = C.limit.zero;
    for (const item of items) {
      merchandise += BigInt(item.totalPrice);
      const bps = parseStoredRate(item.commissionRate), entries = recorded.filter(row => row.orderItemId === item.id);
      if (item.sourceCreatorId === null && item.sourceOutfitId === null) {
        if (bps !== C.limit.zero || entries.length !== C.limit.zero) return blocked(C.block.basis);
        continue;
      }
      const [entry] = entries;
      if (!item.sourceCreatorId || !item.sourceOutfitId || entries.length !== C.limit.one || !entry
        || entry.creatorId !== item.sourceCreatorId || entry.brandId !== order.brandId || entry.sourceOutfitId !== item.sourceOutfitId
        || entry.baseAmount !== item.totalPrice || parseStoredRate(entry.commissionRate) !== bps
        || entry.commissionAmount !== calculateCommissionAmount(item.totalPrice, bps)) return blocked(C.block.basis);
      expectedEntries += C.limit.one;
      creatorCommissions.push({creatorId: entry.creatorId, commissionId: entry.id, amount: entry.commissionAmount});
    }
    if (merchandise !== BigInt(order.subtotalAmount) || expectedEntries !== recorded.length) return blocked(C.block.basis);
    const {paymentId: receiptPaymentId, recordedAt, ...capture} = receipt;
    const basis = allocationBasisSchema.parse({paymentId: payment.id, orderId: order.id, brandId: order.brandId,
      policyId: terms.policy.id, platformRateBps: terms.policy.platformRateBps, feeBearer: terms.policy.feeBearer,
      subtotal: order.subtotalAmount, shipping: order.shippingAmount, tax: order.taxAmount, total: order.totalAmount, currency: order.currency,
      creatorCommissions,
      receipt: captureReceiptSchema.parse({...capture, capturedAt: receipt.capturedAt.toISOString(), availableAt: receipt.availableAt.toISOString()})});
    return {orderId: order.id, plan: calculatePaymentAllocation(basis), blockReason: null};
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof DistributionBudgetExceeded || error instanceof RangeError
      || error instanceof Error && [C.failure.persisted.code, COMMISSION_RULE.failure.persisted, COMMISSION_RULE.failure.amount].some(message => message === error.message)) return blocked(C.block.basis);
    throw error;
  }
}

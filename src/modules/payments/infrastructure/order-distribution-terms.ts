import {ConflictException} from '@nestjs/common';
import {eq, isNull, and} from 'drizzle-orm';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {orders, orderItems, brandProfiles, paymentDistributionPolicies as policies, orderDistributionTerms as terms} from '../../../shared/infrastructure/database/schema';
import {PROFILE_STATUS} from '../../../shared/domain/profile-editing.contract';
import {ORDER_STATUS} from '../../orders/domain/order-lifecycle';
import {calculateCommissionAmount, parseStoredRate} from '../../commissions/domain/commission-rule.contract';
import {PAYMENT_DISTRIBUTION as C, platformCommissionAmount, DistributionBudgetExceeded} from '../domain/payment-distribution';

/** Only called in the transaction that has just inserted the order and its items. */
export async function captureOrderDistributionTerms(database: DatabaseSession, orderId: string): Promise<void> {
  const [order] = await database.db.select({brandId: orders.brandId, subtotalAmount: orders.subtotalAmount, status: orders.status})
    .from(orders).where(eq(orders.id, orderId)).limit(C.limits.one);
  if (!order || order.status !== ORDER_STATUS.pendingPayment) throw new ConflictException(C.failure.persisted);
  // The brand is the serialization point shared with administrative revisions.
  const [brand] = await database.db.select({status: brandProfiles.status}).from(brandProfiles)
    .where(eq(brandProfiles.id, order.brandId)).for(C.lock);
  const [policy] = await database.db.select().from(policies).where(and(eq(policies.brandId, order.brandId), isNull(policies.supersededAt)));
  if (!brand || brand.status !== PROFILE_STATUS.active || !policy?.active) throw new ConflictException(C.failure.unavailable);
  await requireDistributionBudget(database, orderId, order.subtotalAmount, policy.platformRateBps);
  await database.db.insert(terms).values({orderId, policyId: policy.id});
}

export async function assertFrozenDistributionTerms(database: DatabaseSession, orderId: string): Promise<void> {
  const [row] = await database.db.select({orderBrand: orders.brandId, policyBrand: policies.brandId, subtotal: orders.subtotalAmount,
    active: policies.active, rate: policies.platformRateBps, status: orders.status})
    .from(terms).innerJoin(orders, eq(orders.id, terms.orderId)).innerJoin(policies, eq(policies.id, terms.policyId))
    .where(eq(terms.orderId, orderId));
  if (!row) throw new ConflictException(C.failure.order);
  if (row.status !== ORDER_STATUS.pendingPayment) throw new ConflictException(C.failure.order);
  // A later revision cannot alter the conditions accepted for this order.
  if (!row.active || row.orderBrand !== row.policyBrand) throw new ConflictException(C.failure.persisted);
  await requireDistributionBudget(database, orderId, row.subtotal, row.rate);
}

async function requireDistributionBudget(database: DatabaseSession, orderId: string, subtotal: number, rate: number): Promise<void> {
  const items = await database.db.select({amount: orderItems.totalPrice, rate: orderItems.commissionRate, creator: orderItems.sourceCreatorId})
    .from(orderItems).where(eq(orderItems.orderId, orderId));
  try {
    if (!items.length) throw new Error(C.failure.persisted.code);
    let merchandise = BigInt(C.limits.zero), commissions = BigInt(C.limits.zero);
    for (const item of items) {
      const bps = parseStoredRate(item.rate);
      if (item.creator === null && bps !== C.limits.zero) throw new Error(C.failure.persisted.code);
      merchandise += BigInt(item.amount);
      commissions += BigInt(calculateCommissionAmount(item.amount, bps));
    }
    if (merchandise !== BigInt(subtotal) || commissions > BigInt(C.limits.maximumAmount)) throw new Error(C.failure.persisted.code);
    platformCommissionAmount(subtotal, Number(commissions), rate);
  } catch (error) {
    throw new ConflictException(error instanceof DistributionBudgetExceeded ? C.failure.budget : C.failure.persisted);
  }
}

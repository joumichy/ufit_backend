import {sql} from 'drizzle-orm';
import {check, integer, text, timestamp, uniqueIndex, uuid} from 'drizzle-orm/pg-core';
import {ufitSchema} from './schema-base';
import {brandProfiles, creatorProfiles, commissions, orders, paymentSettlements, paymentDistributionPolicies} from './schema';
import {PAYMENT_ALLOCATION as C} from '../../../modules/payments/domain/payment-allocation';

export const paymentAllocations = ufitSchema.table('payment_allocations', {
  paymentId: uuid('payment_id').primaryKey().references(() => paymentSettlements.paymentId),
  orderId: uuid('order_id').notNull().references(() => orders.id), brandId: uuid('brand_id').notNull().references(() => brandProfiles.id),
  policyId: uuid('policy_id').notNull().references(() => paymentDistributionPolicies.id), algorithm: text('algorithm').notNull(),
  chargeId: text('charge_id').notNull(), balanceTransactionId: text('balance_transaction_id').notNull(),
  presentmentAmount: integer('presentment_amount').notNull(), presentmentCurrency: text('presentment_currency').notNull(),
  settlementAmount: integer('settlement_amount').notNull(), settlementCurrency: text('settlement_currency').notNull(),
  feeAmount: integer('fee_amount').notNull(), netAmount: integer('net_amount').notNull(), feeBearer: text('fee_bearer').notNull(),
  lineCount: integer('line_count').notNull(),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull(),
}, table => ({
  source: check('payment_allocations_amounts', sql`${table.presentmentAmount}>${C.limit.zero} and ${table.settlementAmount}>${C.limit.zero}
    and ${table.feeAmount}>=${C.limit.zero} and ${table.settlementAmount}::bigint-${table.feeAmount}::bigint=${table.netAmount}::bigint`),
  algorithm: check('payment_allocations_algorithm', sql`${table.algorithm}=${C.algorithm}`),
  lines: check('payment_allocations_line_count', sql`${table.lineCount}>${C.limit.one}`),
}));
export const paymentAllocationLines = ufitSchema.table('payment_allocation_lines', {
  id: uuid('id').primaryKey(), paymentId: uuid('payment_id').notNull().references(() => paymentAllocations.paymentId),
  commissionId: uuid('commission_id').references(() => commissions.id),
  kind: text('kind').notNull(), brandId: uuid('brand_id').references(() => brandProfiles.id), creatorId: uuid('creator_id').references(() => creatorProfiles.id),
  presentmentAmount: integer('presentment_amount').notNull(), grossAmount: integer('gross_amount').notNull(),
  feeAmount: integer('fee_amount').notNull(), netAmount: integer('net_amount').notNull(),
}, table => ({
  brand: uniqueIndex('payment_allocation_lines_brand_unique').on(table.paymentId).where(sql`${table.kind}=${C.kind.brand}`),
  platform: uniqueIndex('payment_allocation_lines_platform_unique').on(table.paymentId).where(sql`${table.kind}=${C.kind.platform}`),
  creator: uniqueIndex('payment_allocation_lines_creator_unique').on(table.paymentId, table.commissionId).where(sql`${table.kind}=${C.kind.creator}`),
  recipient: check('payment_allocation_lines_recipient', sql`(${table.kind}=${C.kind.brand} and ${table.brandId} is not null and ${table.creatorId} is null and ${table.commissionId} is null)
    or (${table.kind}=${C.kind.creator} and ${table.brandId} is null and ${table.creatorId} is not null and ${table.commissionId} is not null)
    or (${table.kind}=${C.kind.platform} and ${table.brandId} is null and ${table.creatorId} is null and ${table.commissionId} is null)`),
  amounts: check('payment_allocation_lines_amounts', sql`${table.presentmentAmount}>=${C.limit.zero} and ${table.grossAmount}>=${C.limit.zero}
    and ${table.feeAmount}>=${C.limit.zero} and ${table.grossAmount}::bigint-${table.feeAmount}::bigint=${table.netAmount}::bigint`),
}));

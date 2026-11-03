import {sql} from 'drizzle-orm';
import {boolean, check, foreignKey, index, integer, primaryKey, text, timestamp, uniqueIndex, uuid} from 'drizzle-orm/pg-core';
import {ufitSchema, timestamps} from './schema-base';
import {paymentSettlements} from './schema.payment-settlements';
import {REFUND_SETTLEMENT as C} from '../../../modules/payments/domain/refund-settlement';

export const paymentRefundScans = ufitSchema.table('payment_refund_scans', {
  id: uuid('id').primaryKey(), paymentId: uuid('payment_id').notNull().references(() => paymentSettlements.paymentId),
  generation: integer('generation').notNull(), observedAt: timestamp('observed_at', {withTimezone: true}).notNull(), amountRefunded: integer('amount_refunded').notNull(),
  disputed: boolean('disputed').notNull(), itemCount: integer('item_count').notNull(), recordedAt: timestamp('recorded_at', {withTimezone: true}).notNull().defaultNow(),
}, table => ({identity: uniqueIndex('payment_refund_scans_identity').on(table.id, table.paymentId),
  generation: uniqueIndex('payment_refund_scans_generation_identity').on(table.id, table.paymentId, table.generation),
  amounts: check('payment_refund_scans_amounts', sql`${table.generation}>=${C.limits.one} and ${table.amountRefunded}>=${C.limits.zero} and ${table.itemCount}>=${C.limits.zero}`)}));
export const paymentRefundBalances = ufitSchema.table('payment_refund_balances', {
  id: text('id').primaryKey(), paymentId: uuid('payment_id').notNull().references(() => paymentSettlements.paymentId),
  refundId: text('refund_id').notNull(), kind: text('kind').notNull(), amount: integer('amount').notNull(), currency: text('currency').notNull(),
  feeAmount: integer('fee_amount').notNull(), netAmount: integer('net_amount').notNull(),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull(), availableAt: timestamp('available_at', {withTimezone: true}).notNull(),
  recordedAt: timestamp('recorded_at', {withTimezone: true}).notNull().defaultNow(),
}, table => ({identity: uniqueIndex('payment_refund_balances_identity').on(table.id, table.paymentId, table.refundId),
  refundKind: uniqueIndex('payment_refund_balances_refund_kind').on(table.refundId, table.kind),
  amounts: check('payment_refund_balances_amounts', sql`${table.amount}::bigint-${table.feeAmount}::bigint=${table.netAmount}::bigint
    and ((${table.kind}=${C.kind.debit} and ${table.amount}<${C.limits.zero}) or (${table.kind}=${C.kind.failure} and ${table.amount}>${C.limits.zero}))`)}));
export const paymentRefundScanItems = ufitSchema.table('payment_refund_scan_items', {
  scanId: uuid('scan_id').notNull(), paymentId: uuid('payment_id').notNull(), refundId: text('refund_id').notNull(),
  amount: integer('amount').notNull(), currency: text('currency').notNull(), status: text('status').notNull(),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull(), debitId: text('debit_id'), failureId: text('failure_id'),
}, table => ({identity: primaryKey({columns: [table.scanId, table.refundId]}),
  scan: foreignKey({columns: [table.scanId, table.paymentId], foreignColumns: [paymentRefundScans.id, paymentRefundScans.paymentId]}),
  debit: foreignKey({columns: [table.debitId, table.paymentId, table.refundId], foreignColumns: [paymentRefundBalances.id, paymentRefundBalances.paymentId, paymentRefundBalances.refundId]}),
  failure: foreignKey({columns: [table.failureId, table.paymentId, table.refundId], foreignColumns: [paymentRefundBalances.id, paymentRefundBalances.paymentId, paymentRefundBalances.refundId]}),
  amounts: check('payment_refund_scan_items_amounts', sql`${table.amount}>${C.limits.zero}`)}));
export const paymentRefundJobs = ufitSchema.table('payment_refund_jobs', {
  paymentId: uuid('payment_id').primaryKey().references(() => paymentSettlements.paymentId), status: text('status').notNull(),
  generation: integer('generation').notNull(), observedGeneration: integer('observed_generation').notNull(),
  latestScanId: uuid('latest_scan_id'), attempts: integer('attempts').notNull().default(C.limits.zero),
  nextAttemptAt: timestamp('next_attempt_at', {withTimezone: true}), leaseToken: uuid('lease_token'), leaseUntil: timestamp('lease_until', {withTimezone: true}),
  failureCode: text('failure_code'), ...timestamps,
}, table => ({scan: foreignKey({columns: [table.latestScanId, table.paymentId, table.observedGeneration], foreignColumns: [paymentRefundScans.id, paymentRefundScans.paymentId, paymentRefundScans.generation]}),
  due: index('payment_refund_jobs_due').on(table.status, table.nextAttemptAt, table.leaseUntil, table.createdAt),
  generation: check('payment_refund_jobs_generation', sql`${table.generation}>=${C.limits.one} and ${table.observedGeneration}>=${C.limits.zero}
    and ${table.observedGeneration}<=${table.generation} and ((${table.latestScanId} is null)=(${table.observedGeneration}=${C.limits.zero}))`)}));

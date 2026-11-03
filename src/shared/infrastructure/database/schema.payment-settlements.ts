import {sql} from 'drizzle-orm';
import {boolean, check, index, integer, text, timestamp, uuid} from 'drizzle-orm/pg-core';
import {ufitSchema, timestamps} from './schema-base';
import {payments} from './schema';
import {PAYMENT_SETTLEMENT as C} from '../../../modules/payments/domain/payment-settlement';

const statuses = sql.raw([C.state.queued, C.state.processing, C.state.recorded, C.state.needsReview].map(value => `'${value}'`).join(','));
const failures = sql.raw(Object.values(C.failure).map(value => `'${value}'`).join(','));
const queued = sql.raw(`'${C.state.queued}'`), processing = sql.raw(`'${C.state.processing}'`), review = sql.raw(`'${C.state.needsReview}'`);
const currencyPattern = '^[A-Z]{3}$';
export const paymentSettlementJobs = ufitSchema.table('payment_settlement_jobs', {
  paymentId: uuid('payment_id').primaryKey().references(() => payments.id),
  status: text('status').notNull(), attempts: integer('attempts').notNull().default(C.limits.zero),
  nextAttemptAt: timestamp('next_attempt_at', {withTimezone: true}),
  leaseToken: uuid('lease_token'), leaseUntil: timestamp('lease_until', {withTimezone: true}), failureCode: text('failure_code'),
  ...timestamps,
}, table => ({
  due: index('payment_settlement_jobs_due_idx').on(table.status, table.nextAttemptAt, table.leaseUntil, table.createdAt),
  status: check('payment_settlement_jobs_status', sql`${table.status} in (${statuses})`),
  attempts: check('payment_settlement_jobs_attempts', sql`${table.attempts} >= ${C.limits.zero}`),
  next: check('payment_settlement_jobs_next', sql`(${table.status}=${queued})=(${table.nextAttemptAt} is not null)`),
  lease: check('payment_settlement_jobs_lease', sql`(${table.status}=${processing})=(${table.leaseToken} is not null and ${table.leaseUntil} is not null)
    and ((${table.leaseToken} is null)=(${table.leaseUntil} is null))`),
  failure: check('payment_settlement_jobs_failure', sql`(${table.failureCode} is null or ${table.failureCode} in (${failures}))
    and (${table.status}<>${review} or ${table.failureCode} is not null)
    and (${table.failureCode} is null or ${table.status} in (${queued},${review}))`),
}));
export const paymentSettlements = ufitSchema.table('payment_settlements', {
  paymentId: uuid('payment_id').primaryKey().references(() => paymentSettlementJobs.paymentId),
  chargeId: text('charge_id').notNull().unique(), balanceTransactionId: text('balance_transaction_id').notNull().unique(),
  chargeAmount: integer('charge_amount').notNull(), chargeCurrency: text('charge_currency').notNull(),
  settlementAmount: integer('settlement_amount').notNull(), settlementCurrency: text('settlement_currency').notNull(),
  feeAmount: integer('fee_amount').notNull(), netAmount: integer('net_amount').notNull(),
  capturedAt: timestamp('captured_at', {withTimezone: true}).notNull(), availableAt: timestamp('available_at', {withTimezone: true}).notNull(),
  liveMode: boolean('live_mode').notNull(), recordedAt: timestamp('recorded_at', {withTimezone: true}).notNull().defaultNow(),
}, table => ({
  amount: check('payment_settlements_amounts', sql`${table.chargeAmount}>${C.limits.zero} and ${table.settlementAmount}>${C.limits.zero}
    and ${table.feeAmount}>=${C.limits.zero} and ${table.settlementAmount}::bigint-${table.feeAmount}::bigint=${table.netAmount}::bigint`),
  currency: check('payment_settlements_currencies', sql`${table.chargeCurrency}~${currencyPattern} and ${table.settlementCurrency}~${currencyPattern}`),
}));

import {sql} from 'drizzle-orm';
import {boolean, check, index, integer, text, timestamp, uniqueIndex, uuid, type AnyPgColumn} from 'drizzle-orm/pg-core';
import {ufitSchema} from './schema-base';
import {brandProfiles, orders} from './schema';
import {users} from './schema.identity';
import {PAYMENT_DISTRIBUTION as C} from '../../../modules/payments/domain/payment-distribution';

// Revisions retain the agreed values. Retiring a revision only dates its replacement.
export const paymentDistributionPolicies = ufitSchema.table('payment_distribution_policies', {
  id: uuid('id').primaryKey(), brandId: uuid('brand_id').notNull().references(() => brandProfiles.id),
  revision: integer('revision').notNull(), previousId: uuid('previous_id').references((): AnyPgColumn => paymentDistributionPolicies.id),
  requestId: uuid('request_id').notNull(), requestHash: text('request_hash').notNull(),
  platformRateBps: integer('platform_rate_bps').notNull(), feeBearer: text('fee_bearer').notNull(), active: boolean('active').notNull(),
  reason: text('reason').notNull(), createdByUserId: uuid('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  supersededAt: timestamp('superseded_at', {withTimezone: true}),
}, table => ({
  revision: uniqueIndex('payment_distribution_brand_revision_unique').on(table.brandId, table.revision),
  current: uniqueIndex('payment_distribution_current_brand_unique').on(table.brandId).where(sql`${table.supersededAt} is null`),
  request: uniqueIndex('payment_distribution_request_unique').on(table.requestId),
  previous: uniqueIndex('payment_distribution_previous_unique').on(table.previousId),
  history: index('payment_distribution_history_idx').on(table.brandId, table.revision.desc()),
  rate: check('payment_distribution_rate_valid', sql`${table.platformRateBps} between ${C.limits.zero} and ${C.limits.basisPoints}`),
  bearer: check('payment_distribution_bearer_valid', sql`${table.feeBearer} in (${C.feeBearer.brand},${C.feeBearer.platform})`),
  parent: check('payment_distribution_parent_valid', sql`${table.revision}>=${C.limits.one} and ((${table.revision}=${C.limits.one})=(${table.previousId} is null))`),
  reason: check('payment_distribution_reason_valid', sql`char_length(btrim(${table.reason})) between ${C.limits.one} and ${C.limits.reason}`),
  hash: check('payment_distribution_request_hash_valid', sql`${table.requestHash}~${C.request.hashPattern.source}`),
  chronology: check('payment_distribution_chronology_valid', sql`${table.supersededAt} is null or ${table.supersededAt}>=${table.createdAt}`),
}));

export const orderDistributionTerms = ufitSchema.table('order_distribution_terms', {
  orderId: uuid('order_id').primaryKey().references(() => orders.id),
  policyId: uuid('policy_id').notNull().references(() => paymentDistributionPolicies.id),
});

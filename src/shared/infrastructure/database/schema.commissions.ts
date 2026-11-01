import {sql} from 'drizzle-orm';
import {boolean, check, index, integer, numeric, text, timestamp, uniqueIndex, uuid, type AnyPgColumn} from 'drizzle-orm/pg-core';
import {ufitSchema} from './schema-base';
import {brandProfiles, products, creatorGrades, users} from './schema';
import {COMMISSION_RULE} from '../../../modules/commissions/domain/commission-rule.contract';

// Each row is an immutable rate revision. Only supersededAt can be set once.
export const commissionRules = ufitSchema.table('commission_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  scopeId: uuid('scope_id').notNull(), revision: integer('revision').notNull(),
  previousRuleId: uuid('previous_rule_id').references((): AnyPgColumn => commissionRules.id),
  brandId: uuid('brand_id').notNull().references(() => brandProfiles.id),
  productId: uuid('product_id').references(() => products.id),
  creatorGradeCode: text('creator_grade_code').references(() => creatorGrades.code),
  baseRate: numeric('base_rate', {precision: COMMISSION_RULE.limits.storagePrecision, scale: COMMISSION_RULE.limits.decimalPlaces}).notNull(),
  bonusRate: numeric('bonus_rate', {precision: COMMISSION_RULE.limits.storagePrecision, scale: COMMISSION_RULE.limits.decimalPlaces}).notNull(),
  maxRate: numeric('max_rate', {precision: COMMISSION_RULE.limits.storagePrecision, scale: COMMISSION_RULE.limits.decimalPlaces}),
  active: boolean('active').notNull(), reason: text('reason'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  supersededAt: timestamp('superseded_at', {withTimezone: true}),
}, table => ({
  scopeRevision: uniqueIndex('commission_rules_scope_revision_unique').on(table.scopeId, table.revision),
  previous: uniqueIndex('commission_rules_previous_unique').on(table.previousRuleId),
  scopeHistory: index('commission_rules_scope_history_idx').on(table.scopeId, table.createdAt.desc(), table.id.desc()),
  currentScope: uniqueIndex('commission_rules_current_scope_unique').on(table.scopeId).where(sql`${table.supersededAt} is null`),
  brandScope: uniqueIndex('commission_rules_current_brand_unique').on(table.brandId).where(sql`${table.supersededAt} is null and ${table.productId} is null and ${table.creatorGradeCode} is null`),
  gradeScope: uniqueIndex('commission_rules_current_grade_unique').on(table.brandId, table.creatorGradeCode).where(sql`${table.supersededAt} is null and ${table.productId} is null and ${table.creatorGradeCode} is not null`),
  productScope: uniqueIndex('commission_rules_current_product_unique').on(table.brandId, table.productId).where(sql`${table.supersededAt} is null and ${table.productId} is not null and ${table.creatorGradeCode} is null`),
  productGradeScope: uniqueIndex('commission_rules_current_product_grade_unique').on(table.brandId, table.productId, table.creatorGradeCode).where(sql`${table.supersededAt} is null and ${table.productId} is not null and ${table.creatorGradeCode} is not null`),
  rateRange: check('commission_rules_rate_range', sql`${table.baseRate} between 0 and 1 and ${table.bonusRate} between 0 and 1 and (${table.maxRate} is null or ${table.maxRate} between 0 and 1)`),
  revision: check('commission_rules_revision_positive', sql`${table.revision} >= ${COMMISSION_RULE.limits.initialRevision}`),
  revisionParent: check('commission_rules_revision_parent', sql`(${table.revision} = ${COMMISSION_RULE.limits.initialRevision}) = (${table.previousRuleId} is null)`),
}));

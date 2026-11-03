import {check, index, integer, text, timestamp, uniqueIndex, uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {ufitSchema} from './schema-base';
import {brandProfiles, creatorProfiles, users} from './schema';
import {profileStatusEnum} from './schema.profile-status';
import {USER_ADMINISTRATION as U} from '../../../modules/identity/domain/user-administration.contract';

export const profileStatusChanges = ufitSchema.table('profile_status_changes', {
  id: uuid('id').primaryKey().defaultRandom(),
  creatorId: uuid('creator_id').references(() => creatorProfiles.id),
  brandId: uuid('brand_id').references(() => brandProfiles.id),
  version: integer('version').notNull(),
  fromStatus: profileStatusEnum('from_status').notNull(),
  toStatus: profileStatusEnum('to_status').notNull(),
  decidedByUserId: uuid('decided_by_user_id').notNull().references(() => users.id),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
}, table => ({
  creatorVersion: uniqueIndex('profile_status_creator_version_unique').on(table.creatorId, table.version),
  brandVersion: uniqueIndex('profile_status_brand_version_unique').on(table.brandId, table.version),
  creatorHistory: index('profile_status_creator_history_idx').on(table.creatorId, table.version),
  brandHistory: index('profile_status_brand_history_idx').on(table.brandId, table.version),
  profile: check('profile_status_change_profile_required', sql`(${table.creatorId} is not null) <> (${table.brandId} is not null)`),
  version: check('profile_status_change_version_valid', sql`${table.version} > ${U.limits.initialVersion}`),
  changed: check('profile_status_change_changed', sql`${table.fromStatus} <> ${table.toStatus}`),
  reason: check('profile_status_change_reason_valid', sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between ${U.limits.one} and ${U.limits.reason}`),
}));

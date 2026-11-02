import {sql} from 'drizzle-orm';
import {check, foreignKey, integer, primaryKey, text, timestamp, uuid} from 'drizzle-orm/pg-core';
import {STYLE_PREFERENCES as S} from '../../../modules/identity/domain/style-preferences.contract';
import {ufitSchema} from './schema-base';
import {users} from './schema.identity';
import {tags, tagTypeEnum} from './schema.tags';

export const stylePreferences = ufitSchema.table('style_preferences', {
  userId: uuid('user_id').primaryKey().references(() => users.id, {onDelete: 'cascade'}),
  version: integer('version').notNull(), updatedAt: timestamp('updated_at', {withTimezone: true}).notNull(),
}, table => ({version: check('style_preferences_version_positive', sql`${table.version}>=${S.version.initial}`)}));
export const preferredStyles = ufitSchema.table('preferred_styles', {
  userId: uuid('user_id').notNull().references(() => stylePreferences.userId, {onDelete: 'cascade'}),
  tagId: uuid('tag_id').notNull(), tagType: tagTypeEnum('tag_type').notNull().default(S.tagType),
}, table => ({
  identity: primaryKey({columns: [table.userId, table.tagId]}),
  tag: foreignKey({columns: [table.tagId, table.tagType], foreignColumns: [tags.id, tags.type]}),
  style: check('preferred_styles_type_style', sql`${table.tagType}=${S.tagType}`),
}));
export const stylePreferenceChanges = ufitSchema.table('style_preference_changes', {
  userId: uuid('user_id').notNull().references(() => stylePreferences.userId, {onDelete: 'cascade'}),
  requestId: uuid('request_id').notNull(), fingerprint: text('fingerprint').notNull(),
  expectedVersion: integer('expected_version').notNull(), version: integer('version').notNull(),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull(),
}, table => ({
  identity: primaryKey({columns: [table.userId, table.requestId]}),
  version: check('style_preference_change_version_valid', sql`${table.expectedVersion}>=${S.version.absent} and ${table.expectedVersion}<${S.version.maximum} and ${table.version}=${table.expectedVersion}+${S.version.step}`),
  fingerprint: check('style_preference_change_fingerprint_valid', sql`${table.fingerprint}~${S.digest.pattern}`),
}));

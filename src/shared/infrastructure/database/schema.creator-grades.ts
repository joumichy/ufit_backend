import {sql} from 'drizzle-orm';
import {boolean, check, foreignKey, index, integer, text, timestamp, uniqueIndex, uuid} from 'drizzle-orm/pg-core';
import {ufitSchema} from './schema-base';
import {creatorGrades, users} from './schema';
import {CREATOR_GRADE} from '../../../modules/creators/grades/creator-grade.contract';

// Version one can record the observed migration baseline, with its editor unknown.
export const creatorGradeRevisions = ufitSchema.table('creator_grade_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().references(() => creatorGrades.code),
  version: integer('version').notNull(),
  previousRevisionId: uuid('previous_revision_id'),
  label: text('label').notNull(), rank: integer('rank').notNull(), assignable: boolean('assignable').notNull(),
  changedByUserId: uuid('changed_by_user_id').references(() => users.id), reason: text('reason'),
  recordedAt: timestamp('recorded_at', {withTimezone: true}).notNull().defaultNow(),
}, table => ({
  versionUnique: uniqueIndex('creator_grade_revisions_version_unique').on(table.code, table.version),
  codeIdUnique: uniqueIndex('creator_grade_revisions_code_id_unique').on(table.code, table.id),
  parentScope: foreignKey({name: 'creator_grade_revisions_parent_scope', columns: [table.code, table.previousRevisionId], foreignColumns: [table.code, table.id]}),
  previousUnique: uniqueIndex('creator_grade_revisions_previous_unique').on(table.previousRevisionId),
  history: index('creator_grade_revisions_history_idx').on(table.code, table.version.desc()),
  positiveVersion: check('creator_grade_revisions_version_check', sql`${table.version} >= ${CREATOR_GRADE.limits.initialVersion}`),
  validRank: check('creator_grade_revisions_rank_check', sql`${table.rank} >= ${CREATOR_GRADE.limits.zero}`),
  parentRequired: check('creator_grade_revisions_parent_required', sql`(${table.version} = ${CREATOR_GRADE.limits.initialVersion}) = (${table.previousRevisionId} is null)`),
}));

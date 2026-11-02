import {PROFILE_IMAGE} from '../../../modules/media/domain/profile-image.contract';
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { ufitSchema } from './schema-base';
import { USER_ROLES, USER_STATUSES } from '../../../modules/identity/domain/user.types';
import { USER_ADMINISTRATION } from '../../../modules/identity/domain/user-administration.contract';
export const userStatusEnum = ufitSchema.enum('user_status', USER_STATUSES);
export const userRoleEnum = ufitSchema.enum('user_role', USER_ROLES);
export const users = ufitSchema.table('users', {
    id: uuid('id').primaryKey().defaultRandom(),
    supabaseUserId: uuid('supabase_user_id').notNull(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    imageVersion: integer('image_version').notNull().default(PROFILE_IMAGE.limits.initialVersion),
    status: userStatusEnum('status').notNull().default(USER_ADMINISTRATION.status.active),
    accessVersion: integer('access_version').notNull().default(USER_ADMINISTRATION.limits.initialVersion),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
    supabaseUserIdUnique: uniqueIndex('users_supabase_user_id_unique').on(table.supabaseUserId),
    emailIndex: index('users_email_idx').on(table.email),
    statusIndex: index('users_status_idx').on(table.status),
    imageVersion: check('users_image_version_check', sql`${table.imageVersion} >= ${PROFILE_IMAGE.limits.initialVersion}`)
}));
export const userRoles = ufitSchema.table('user_roles', {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
    role: userRoleEnum('role').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
    userRoleUnique: uniqueIndex('user_roles_user_id_role_unique').on(table.userId, table.role),
    userIdIndex: index('user_roles_user_id_idx').on(table.userId),
    roleIndex: index('user_roles_role_idx').on(table.role)
}));
export const userAccessChanges = ufitSchema.table('user_access_changes', {
    id: uuid('id').primaryKey().defaultRandom(), userId: uuid('user_id').notNull().references(() => users.id),
    version: integer('version').notNull(),
    kind: text('kind', { enum: [USER_ADMINISTRATION.change.status, USER_ADMINISTRATION.change.adminAccess] }).notNull(),
    fromStatus: userStatusEnum('from_status').notNull(), toStatus: userStatusEnum('to_status').notNull(),
    adminBefore: boolean('admin_before').notNull(), adminAfter: boolean('admin_after').notNull(),
    decidedByUserId: uuid('decided_by_user_id').notNull().references(() => users.id), reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
    versionUnique: uniqueIndex('user_access_changes_version_unique').on(table.userId, table.version),
    history: index('user_access_changes_history_idx').on(table.userId, table.version.desc()),
    version: check('user_access_changes_version_check', sql `${table.version} > ${USER_ADMINISTRATION.limits.initialVersion}`),
}));

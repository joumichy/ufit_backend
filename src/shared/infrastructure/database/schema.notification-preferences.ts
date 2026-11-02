import {check,integer,boolean,timestamp,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {ufitSchema} from './schema-base';
import {users} from './schema.identity';
import {NOTIFICATION_PREFERENCES} from '../../../modules/notifications/domain/notification-preferences';
export const notificationPreferences=ufitSchema.table('notification_preferences',{
  userId:uuid('user_id').primaryKey().references(()=>users.id,{onDelete:'cascade'}),
  version:integer('version').notNull(),
  emailEnabled:boolean('email_enabled').notNull().default(NOTIFICATION_PREFERENCES.defaults.emailEnabled),
  pushEnabled:boolean('push_enabled').notNull().default(NOTIFICATION_PREFERENCES.defaults.pushEnabled),
  updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},table=>({version:check('notification_preferences_version_positive',sql`${table.version}>=${sql.raw(String(NOTIFICATION_PREFERENCES.revision.initial))}`)}));

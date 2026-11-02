import {check,foreignKey,index,integer,text,timestamp,unique,uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {ufitSchema} from './schema-base';
import {notifications} from './schema.notifications';
import {notificationDeviceAssociations as associations,notificationInstallationRegistrations as registrations} from './schema.notification-installations';
import {NOTIFICATION_PUSH as N,PUSH_STATUSES} from '../../../modules/notifications/domain/notification-push.contract';
import {PUSH_DELIVERY as PUSH} from '../../../modules/notifications/domain/push-delivery';

const values=(items:readonly string[])=>sql.raw(items.map(value=>`'${value}'`).join(', '));
const zero=sql.raw(String(N.limits.zero)),reserved=sql.raw(`'${N.status.reserved}'`),sending=sql.raw(`'${N.status.sending}'`),accepted=sql.raw(`'${N.status.accepted}'`);
export const notificationPushDeliveries=ufitSchema.table('notification_push_deliveries',{
  id:uuid('id').primaryKey().defaultRandom(),notificationId:uuid('notification_id').notNull().references(()=>notifications.id),
  installationId:uuid('installation_id').notNull(),associationId:uuid('association_id').notNull(),environment:text('environment').notNull(),
  status:text('status').notNull().default(N.status.pending),attempts:integer('attempts').notNull().default(N.limits.zero),
  expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),nextAttemptAt:timestamp('next_attempt_at',{withTimezone:true}).notNull().defaultNow(),
  leaseToken:uuid('lease_token'),leaseUntil:timestamp('lease_until',{withTimezone:true}),
  registrationId:uuid('registration_id'),deviceToken:text('device_token'),attemptedAt:timestamp('attempted_at',{withTimezone:true}),
  cancelRequestedAt:timestamp('cancel_requested_at',{withTimezone:true}),
  providerMessageId:uuid('provider_message_id'),acceptedAt:timestamp('accepted_at',{withTimezone:true}),lastFailure:text('last_failure'),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},table=>({
  notificationAssociation:unique('notification_push_notification_association_unique').on(table.notificationId,table.installationId,table.associationId),
  association:foreignKey({name:'notification_push_association_fk',columns:[table.associationId,table.installationId],foreignColumns:[associations.id,associations.installationId]}),
  registration:foreignKey({name:'notification_push_registration_fk',columns:[table.registrationId,table.associationId,table.installationId],foreignColumns:[registrations.id,registrations.associationId,registrations.installationId]}),
  due:index('notification_push_due_idx').on(table.environment,table.nextAttemptAt,table.id).where(sql`${table.status} in (${values([N.status.pending,N.status.retry])})`),
  leases:index('notification_push_lease_idx').on(table.environment,table.leaseUntil,table.id).where(sql`${table.status} in (${reserved},${sending})`),
  status:check('notification_push_status_valid',sql`${table.status} in (${values(PUSH_STATUSES)})`),
  environment:check('notification_push_environment_valid',sql`${table.environment} in (${values(Object.values(PUSH.environment))})`),
  attempts:check('notification_push_attempt_valid',sql`${table.attempts}>=${zero} and ((${table.attempts}=${zero} and ${table.registrationId} is null and ${table.deviceToken} is null and ${table.attemptedAt} is null)
    or (${table.attempts}>${zero} and ${table.registrationId} is not null and ${table.deviceToken} is not null and ${table.attemptedAt} is not null))`),
  token:check('notification_push_token_valid',sql`${table.deviceToken} is null or ${table.deviceToken}~'^([0-9a-f]{2})+$'`),
  lease:check('notification_push_lease_valid',sql`(${table.status} in (${reserved},${sending}) and ${table.leaseToken} is not null and ${table.leaseUntil} is not null)
    or (${table.status} not in (${reserved},${sending}) and ${table.leaseToken} is null and ${table.leaseUntil} is null)`),
  attemptState:check('notification_push_attempt_state_valid',sql`(${table.status}<>${sql.raw(`'${N.status.pending}'`)} or ${table.attempts}=${zero})
    and (${table.status} not in (${values([N.status.sending,N.status.retry,N.status.accepted,N.status.rejected,N.status.uncertain])}) or ${table.attempts}>${zero})`),
  acceptance:check('notification_push_acceptance_valid',sql`(${table.status}=${accepted} and ${table.providerMessageId}=${table.id} and ${table.providerMessageId} is not null and ${table.acceptedAt} is not null and ${table.lastFailure} is null)
    or (${table.status}<>${accepted} and ${table.providerMessageId} is null and ${table.acceptedAt} is null)`),
  chronology:check('notification_push_chronology',sql`${table.expiresAt}>${table.createdAt} and ${table.updatedAt}>=${table.createdAt}`),
}));

import {check, index, integer, text, timestamp, unique, uniqueIndex, uuid} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {ufitSchema} from './schema-base';
import {users} from './schema.identity';
import {brandProfiles} from './schema';
import {NOTIFICATION,NOTIFICATION_AUDIENCES,NOTIFICATION_RESOURCES} from '../../../modules/notifications/domain/notification.contract';
import {EMAIL_DELIVERY, EMAIL_PROVIDER} from '../../../modules/notifications/domain/email-delivery';
import {NOTIFICATION_EMAIL, NOTIFICATION_EMAIL_STATUSES} from '../../../modules/notifications/domain/notification-email.contract';

const statusValues = sql.raw(NOTIFICATION_EMAIL_STATUSES.map(value => `'${value}'`).join(', '));
const resourceValues = sql.raw(NOTIFICATION_RESOURCES.map(value => `'${value}'`).join(', '));
const pending = sql.raw(`'${NOTIFICATION_EMAIL.status.pending}'`);
const processing = sql.raw(`'${NOTIFICATION_EMAIL.status.processing}'`);
const accepted = sql.raw(`'${NOTIFICATION_EMAIL.status.accepted}'`);
const cancelled = sql.raw(`'${NOTIFICATION_EMAIL.status.cancelled}'`);
const zeroAttempts = sql.raw(String(NOTIFICATION_EMAIL.limits.initialAttempts));
const minimumText = sql.raw(String(EMAIL_DELIVERY.limits.minimum));
const maximumKey = sql.raw(String(NOTIFICATION.limits.eventKey));
const providerValues = sql.raw(Object.values(EMAIL_PROVIDER).map(value => `'${value}'`).join(', '));

export const notifications = ufitSchema.table('notifications', {
  id:uuid('id').primaryKey().defaultRandom(),eventKey:text('event_key').notNull(),
  recipientUserId:uuid('recipient_user_id').notNull().references(()=>users.id),
  resourceType:text('resource_type').notNull(),resourceId:uuid('resource_id').notNull(),
  audience:text('audience').notNull(),brandId:uuid('brand_id').references(()=>brandProfiles.id),
  subject:text('subject').notNull(),bodyText:text('body_text').notNull(),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},table=>({
  eventRecipient:unique('notification_event_recipient_unique').on(table.eventKey,table.recipientUserId),
  recipient:index('notification_recipient_idx').on(table.recipientUserId,table.createdAt,table.id),
  resource:index('notification_resource_idx').on(table.resourceType,table.resourceId),
  eventKey:check('notification_key_valid',sql`${table.eventKey}=btrim(${table.eventKey}) and length(${table.eventKey}) between ${minimumText} and ${maximumKey}`),
  resourceType:check('notification_resource_valid',sql`${table.resourceType} in (${resourceValues})`),
  content:check('notification_content_valid',sql`length(${table.subject})>=${minimumText} and length(${table.bodyText})>=${minimumText}`),
  audience:check('notification_audience_valid',sql`${table.audience} in (${sql.raw(NOTIFICATION_AUDIENCES.map(value=>`'${value}'`).join(', '))})`),
  context:check('notification_context_valid',sql`(${table.resourceType} in (${sql.raw(`'${NOTIFICATION.resource.creatorApplication}', '${NOTIFICATION.resource.brandApplication}'`)})
    and ${table.audience}=${sql.raw(`'${NOTIFICATION.audience.applicant}'`)} and ${table.brandId} is null)
    or (${table.resourceType} not in (${sql.raw(`'${NOTIFICATION.resource.creatorApplication}', '${NOTIFICATION.resource.brandApplication}'`)})
    and ((${table.audience}=${sql.raw(`'${NOTIFICATION.audience.customer}'`)} and ${table.brandId} is null)
      or (${table.audience}=${sql.raw(`'${NOTIFICATION.audience.brand}'`)} and ${table.brandId} is not null)))`),
}));

export const notificationEmailDeliveries = ufitSchema.table('notification_email_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  notificationId:uuid('notification_id').notNull().references(()=>notifications.id,{onDelete:'cascade'}),
  recipientAddress: text('recipient_address').notNull(), subject: text('subject').notNull(), bodyText: text('body_text').notNull(),
  senderName: text('sender_name'), senderAddress: text('sender_address'),
  provider: text('provider'),
  status: text('status').notNull().default(NOTIFICATION_EMAIL.status.pending),
  attempts: integer('attempts').notNull().default(NOTIFICATION_EMAIL.limits.initialAttempts),
  firstAttemptAt: timestamp('first_attempt_at', {withTimezone: true}),
  nextAttemptAt: timestamp('next_attempt_at', {withTimezone: true}).notNull().defaultNow(),
  leaseToken: uuid('lease_token'), leaseUntil: timestamp('lease_until', {withTimezone: true}),
  providerMessageId: text('provider_message_id'), acceptedAt: timestamp('accepted_at', {withTimezone: true}),
  lastFailure: text('last_failure'),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow(),
}, table => ({
  notification: unique('notification_email_notification_unique').on(table.notificationId),
  providerMessage: uniqueIndex('notification_email_provider_message_unique').on(table.provider,table.providerMessageId),
  due: index('notification_email_due_idx').on(table.nextAttemptAt, table.id),
  recipient: check('notification_email_recipient_valid', sql`${table.recipientAddress}=btrim(${table.recipientAddress}) and length(${table.recipientAddress})>=${minimumText}`),
  content: check('notification_email_content_valid', sql`length(${table.subject})>=${minimumText} and length(${table.bodyText})>=${minimumText}`),
  status: check('notification_email_status_valid', sql`${table.status} in (${statusValues})`),
  attempts: check('notification_email_attempts_valid', sql`${table.attempts} >= ${zeroAttempts}`),
  provider: check('notification_email_provider_valid', sql`${table.provider} is null or ${table.provider} in (${providerValues})`),
  receipt: check('notification_email_provider_receipt_valid', sql`${table.providerMessageId} is null or (${table.providerMessageId} !~ '\\s' and length(${table.providerMessageId}) between ${minimumText} and ${sql.raw(String(EMAIL_DELIVERY.limits.receiptMaximum))})`),
  anchor: check('notification_email_anchor_valid', sql`(${table.firstAttemptAt} is null and ${table.senderName} is null and ${table.senderAddress} is null and ${table.provider} is null and ${table.attempts}=${zeroAttempts})
    or (${table.firstAttemptAt} is not null and ${table.senderName} is not null and ${table.senderAddress} is not null and ${table.provider} is not null and ${table.attempts}>${zeroAttempts})`),
  lease: check('notification_email_lease_valid', sql`(${table.status}=${processing} and ${table.leaseToken} is not null and ${table.leaseUntil} is not null)
    or (${table.status}<>${processing} and ${table.leaseToken} is null and ${table.leaseUntil} is null)`),
  acceptance: check('notification_email_acceptance_valid', sql`(${table.status}=${accepted} and ${table.providerMessageId} is not null and ${table.acceptedAt} is not null and ${table.lastFailure} is null)
    or (${table.status}<>${accepted} and ${table.providerMessageId} is null and ${table.acceptedAt} is null)`),
  attemptState: check('notification_email_attempt_state_valid', sql`(${table.status}=${pending} and ${table.attempts}=${zeroAttempts})
    or ${table.status}=${cancelled} or (${table.status}<>${pending} and ${table.firstAttemptAt} is not null)`),
}));

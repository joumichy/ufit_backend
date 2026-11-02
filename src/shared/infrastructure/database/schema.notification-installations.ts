import {check,foreignKey,index,integer,text,timestamp,uniqueIndex,uuid,type AnyPgColumn} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {ufitSchema} from './schema-base';
import {users} from './schema.identity';
import {INSTALLATION as I} from '../../../modules/notifications/domain/notification-installation';
import {PUSH_DELIVERY} from '../../../modules/notifications/domain/push-delivery';

const registered=sql.raw(`'${I.state.registered}'`),detached=sql.raw(`'${I.state.detached}'`),invalidated=sql.raw(`'${I.state.invalidated}'`);
const environments=sql.raw(Object.values(PUSH_DELIVERY.environment).map(value=>`'${value}'`).join(', '));
export const notificationDeviceAssociations=ufitSchema.table('notification_device_associations',{
  id:uuid('id').primaryKey(),installationId:uuid('installation_id').notNull().references(():AnyPgColumn=>notificationInstallations.id),
  userId:uuid('user_id').notNull().references(()=>users.id),openedAt:timestamp('opened_at',{withTimezone:true}).notNull(),
  closedAt:timestamp('closed_at',{withTimezone:true}),
},table=>({
  installationIdentity:uniqueIndex('notification_association_installation_identity').on(table.id,table.installationId),
  active:uniqueIndex('notification_association_active_installation_unique').on(table.installationId).where(sql`${table.closedAt} is null`),
  recipient:index('notification_association_recipient_idx').on(table.userId,table.installationId).where(sql`${table.closedAt} is null`),
  chronology:check('notification_association_chronology',sql`${table.closedAt} is null or ${table.closedAt}>=${table.openedAt}`),
}));
export const notificationInstallationRegistrations=ufitSchema.table('notification_installation_registrations',{
  id:uuid('id').primaryKey(),associationId:uuid('association_id').notNull(),installationId:uuid('installation_id').notNull(),requestHash:text('request_hash').notNull(),
},table=>({
  identity:uniqueIndex('notification_registration_identity').on(table.id,table.associationId,table.installationId),
  association:foreignKey({name:'notification_registration_association_fk',columns:[table.associationId,table.installationId],foreignColumns:[notificationDeviceAssociations.id,notificationDeviceAssociations.installationId]}),
  hash:check('notification_registration_request_valid',sql`${table.requestHash}~'^[0-9a-f]{64}$'`),
}));
export const notificationInstallations=ufitSchema.table('notification_installations',{
  id:uuid('id').primaryKey(),credentialHash:text('credential_hash').notNull(),version:integer('version').notNull(),
  state:text('state').notNull(),currentAssociationId:uuid('current_association_id'),registrationId:uuid('registration_id'),
  deviceToken:text('device_token'),environment:text('environment'),registeredAt:timestamp('registered_at',{withTimezone:true}),
  invalidatedAt:timestamp('invalidated_at',{withTimezone:true}),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull(),
},table=>({
  association:foreignKey({name:'notification_installation_association_fk',columns:[table.currentAssociationId,table.id],foreignColumns:[notificationDeviceAssociations.id,notificationDeviceAssociations.installationId]}),
  registration:foreignKey({name:'notification_installation_registration_fk',columns:[table.registrationId,table.currentAssociationId,table.id],foreignColumns:[notificationInstallationRegistrations.id,notificationInstallationRegistrations.associationId,notificationInstallationRegistrations.installationId]}),
  token:uniqueIndex(I.storage.tokenUnique).on(table.environment,table.deviceToken).where(sql`${table.state}=${registered}`),
  version:check('notification_installation_version_positive',sql`${table.version}>=${sql.raw(String(I.revision.initial))}`),
  proof:check('notification_installation_credential_valid',sql`${table.credentialHash}~'^[0-9a-f]{64}$'`),
  state:check('notification_installation_state_valid',sql`${table.state} in (${registered},${detached},${invalidated})`),
  shape:check('notification_installation_shape_valid',sql`(${table.state}=${detached} and ${table.currentAssociationId} is null and ${table.registrationId} is null and ${table.deviceToken} is null and ${table.environment} is null and ${table.registeredAt} is null and ${table.invalidatedAt} is null)
    or (${table.state} in (${registered},${invalidated}) and ${table.currentAssociationId} is not null and ${table.registrationId} is not null and ${table.deviceToken} is not null and ${table.environment} is not null and ${table.registeredAt} is not null and (${table.state}<>${registered} or ${table.invalidatedAt} is null))`),
  tokenFormat:check('notification_installation_token_valid',sql`${table.deviceToken} is null or ${table.deviceToken}~'^([0-9a-f]{2})+$'`),
  environment:check('notification_installation_environment_valid',sql`${table.environment} is null or ${table.environment} in (${environments})`),
  chronology:check('notification_installation_chronology',sql`${table.updatedAt}>=${table.createdAt} and (${table.registeredAt} is null or ${table.registeredAt}>=${table.createdAt})`),
}));

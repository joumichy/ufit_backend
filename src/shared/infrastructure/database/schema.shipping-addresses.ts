import {sql} from 'drizzle-orm';
import {boolean, check, integer, primaryKey, text, timestamp, uniqueIndex, uuid} from 'drizzle-orm/pg-core';
import {SHIPPING_ADDRESSES as S} from '../../../modules/identity/domain/shipping-addresses.contract';
import {ADDRESS_LIMIT as A} from '../../domain/shipping-address';
import {ufitSchema} from './schema-base';
import {users} from './schema.identity';

export const shippingAddressBooks = ufitSchema.table('shipping_address_books', {
  userId: uuid('user_id').primaryKey().references(() => users.id, {onDelete: 'cascade'}),
  version: integer('version').notNull(), updatedAt: timestamp('updated_at', {withTimezone: true}).notNull(),
}, table => ({version: check('shipping_address_book_version_positive', sql`${table.version}>=${S.version.initial}`)}));
export const shippingAddresses = ufitSchema.table('shipping_addresses', {
  userId: uuid('user_id').notNull().references(() => shippingAddressBooks.userId, {onDelete: 'cascade'}),
  id: uuid('id').notNull(), fullName: text('full_name').notNull(), line1: text('line1').notNull(), line2: text('line2'),
  postalCode: text('postal_code').notNull(), city: text('city').notNull(), country: text('country').notNull(), phone: text('phone'),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull(), updatedAt: timestamp('updated_at', {withTimezone: true}).notNull(),
}, table => ({
  identity: primaryKey({columns: [table.userId, table.id]}),
  default: uniqueIndex('shipping_address_default_unique').on(table.userId).where(sql`${table.isDefault}`),
  fullName: check('shipping_address_name_length', sql`char_length(${table.fullName}) between ${A.minimum} and ${A.fullName}`),
  line1: check('shipping_address_line1_length', sql`char_length(${table.line1}) between ${A.minimum} and ${A.line}`),
  line2: check('shipping_address_line2_length', sql`${table.line2} is null or char_length(${table.line2})<=${A.line}`),
  postal: check('shipping_address_postal_length', sql`char_length(${table.postalCode}) between ${A.minimum} and ${A.postalCode}`),
  city: check('shipping_address_city_length', sql`char_length(${table.city}) between ${A.minimum} and ${A.city}`),
  phone: check('shipping_address_phone_length', sql`${table.phone} is null or char_length(${table.phone})<=${A.phone}`),
}));
export const shippingAddressChanges = ufitSchema.table('shipping_address_changes', {
  userId: uuid('user_id').notNull().references(() => shippingAddressBooks.userId, {onDelete: 'cascade'}),
  requestId: uuid('request_id').notNull(), fingerprint: text('fingerprint').notNull(), expectedVersion: integer('expected_version').notNull(),
  version: integer('version').notNull(), action: text('action', {enum: [S.action.save, S.action.delete, S.action.setDefault]}).notNull(),
  addressId: uuid('address_id'), createdAt: timestamp('created_at', {withTimezone: true}).notNull(),
}, table => ({
  identity: primaryKey({columns: [table.userId, table.requestId]}),
  version: check('shipping_address_change_version_valid', sql`${table.expectedVersion}>=${S.version.absent} and ${table.expectedVersion}<${S.version.maximum} and ${table.version}=${table.expectedVersion}+${S.version.step}`),
  fingerprint: check('shipping_address_change_fingerprint_valid', sql`${table.fingerprint}~${S.digest.pattern}`),
  action: check('shipping_address_change_action_valid', sql`${table.action} in (${S.action.save},${S.action.delete},${S.action.setDefault})`),
  address: check('shipping_address_change_target_valid', sql`${table.action}=${S.action.setDefault} or ${table.addressId} is not null`),
}));

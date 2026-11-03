import {sql} from 'drizzle-orm';
import {check, foreignKey, integer, text, timestamp, uniqueIndex, uuid} from 'drizzle-orm/pg-core';
import {ufitSchema} from './schema-base';
import {users} from './schema.identity';
import {orders, orderCancellations} from './schema.orders';
import {orderReturns} from './schema.returns';
import {REFUND_ORGANIZATION as O} from '../../../modules/orders/domain/refund-organization';

export const refundOrganizationCases = ufitSchema.table('refund_organization_cases', {
  id: uuid('id').primaryKey(), orderId: uuid('order_id').notNull().references(()=>orders.id),
  returnId: uuid('return_id'), cancellationId: uuid('cancellation_id'), version: integer('version').notNull(),
}, table => ({
  returnUnique: uniqueIndex('refund_organization_return_unique').on(table.returnId),
  cancellationUnique: uniqueIndex('refund_organization_cancellation_unique').on(table.cancellationId),
  origin: check('refund_organization_origin_required', sql`(${table.returnId} is null) <> (${table.cancellationId} is null)`),
  version: check('refund_organization_version_positive', sql`${table.version} >= ${O.revision.first}`),
  returnOrder: foreignKey({name: 'refund_organization_return_order_fk', columns: [table.returnId,table.orderId], foreignColumns: [orderReturns.id,orderReturns.orderId]}),
  cancellationOrder: foreignKey({name: 'refund_organization_cancellation_order_fk', columns: [table.cancellationId,table.orderId], foreignColumns: [orderCancellations.id,orderCancellations.orderId]}),
}));
export const refundOrganizationRevisions = ufitSchema.table('refund_organization_revisions', {
  id: uuid('id').primaryKey(), caseId: uuid('case_id').notNull().references(()=>refundOrganizationCases.id),
  version: integer('version').notNull(), previousRevisionId: uuid('previous_revision_id'),
  requestId: uuid('request_id').notNull(), requestFingerprint: text('request_fingerprint').notNull(),
  action: text('action').notNull(), changedBy: uuid('changed_by').references(()=>users.id),
  status: text('status').notNull(), methodLabel: text('method_label').notNull(), instructions: text('instructions').notNull(),
  customerDetails: text('customer_details'), recordedAt: timestamp('recorded_at',{withTimezone:true}).notNull(),
}, table => ({
  versionUnique: uniqueIndex('refund_organization_revision_version_unique').on(table.caseId,table.version),
  requestUnique: uniqueIndex('refund_organization_revision_request_unique').on(table.caseId,table.requestId),
  identity: uniqueIndex('refund_organization_revision_identity').on(table.caseId,table.id),
  previousUnique: uniqueIndex('refund_organization_revision_previous_unique').on(table.previousRevisionId),
  parent: foreignKey({name:'refund_organization_revision_parent_fk',columns:[table.caseId,table.previousRevisionId],foreignColumns:[table.caseId,table.id]}),
  version: check('refund_organization_revision_version_valid',sql`${table.version} >= ${O.revision.first} and ((${table.version} = ${O.revision.first}) = (${table.previousRevisionId} is null))`),
  fingerprint: check('refund_organization_revision_fingerprint_valid',sql`${table.requestFingerprint} ~ ${O.hash.pattern}`),
  action: check('refund_organization_revision_action_valid',sql`${table.action} in (${O.action.arrange},${O.action.provideDetails})`),
  fields: check('refund_organization_revision_fields_valid',sql`char_length(btrim(${table.methodLabel})) between ${O.text.minimum} and ${O.text.method} and char_length(btrim(${table.instructions})) between ${O.text.minimum} and ${O.text.instructions}`),
  state: check('refund_organization_revision_state_valid',sql`((${table.status} = ${O.status.awaitingCustomer} and ${table.customerDetails} is null and ${table.action} = ${O.action.arrange}) or (${table.status} = ${O.status.ready} and char_length(btrim(${table.customerDetails})) between ${O.text.minimum} and ${O.text.details} and ${table.action} = ${O.action.provideDetails})) is true`),
}));

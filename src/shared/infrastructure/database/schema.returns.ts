import {sql} from 'drizzle-orm';
import {boolean, check, foreignKey, index, integer, text, timestamp, uniqueIndex, uuid} from 'drizzle-orm/pg-core';
import {ufitSchema, timestamps} from './schema-base';
import {orders, orderItems} from './schema.orders';
import {commissions} from './schema';
import {ORDER_RETURN, RETURN_STATUS} from '../../../modules/orders/domain/order-return.contract';

export const orderReturns = ufitSchema.table('order_returns', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  requestId: uuid('request_id').notNull(), requestFingerprint: text('request_fingerprint').notNull(),
  status: text('status').notNull().default(RETURN_STATUS.requested), version: integer('version').notNull().default(ORDER_RETURN.revision.initial),
  reason: text('reason').notNull(), returnPolicy: text('return_policy').notNull(), deadline: timestamp('deadline', {withTimezone: true}).notNull(),
  refundPolicyCode: text('refund_policy_code').notNull(),
  merchandiseAmount: integer('merchandise_amount').notNull(), taxAmount: integer('tax_amount').notNull(), shippingAmount: integer('shipping_amount').notNull(), totalAmount: integer('total_amount').notNull(),
  completesOrder: boolean('completes_order').notNull(),
  brandDecision: text('brand_decision'), brandReason: text('brand_reason'), brandInstructions: text('brand_instructions'), brandDecidedAt: timestamp('brand_decided_at', {withTimezone: true}),
  disputeReason: text('dispute_reason'), disputedAt: timestamp('disputed_at', {withTimezone: true}),
  adminDecision: text('admin_decision'), adminReason: text('admin_reason'), adminInstructions: text('admin_instructions'), adminDecidedAt: timestamp('admin_decided_at', {withTimezone: true}),
  carrier: text('carrier'), trackingNumber: text('tracking_number'), trackingUrl: text('tracking_url'), sentAt: timestamp('sent_at', {withTimezone: true}),
  receivedAt: timestamp('received_at', {withTimezone: true}), refundedAt: timestamp('refunded_at', {withTimezone: true}),
  ...timestamps,
}, table => ({
  requestUnique: uniqueIndex('order_returns_order_request_unique').on(table.orderId, table.requestId),
  orderIdentityUnique: uniqueIndex('order_returns_id_order_unique').on(table.id, table.orderId),
  openUnique: uniqueIndex('order_returns_one_open_unique').on(table.orderId).where(sql`${table.status} not in ('refunded', 'closed', 'withdrawn')`),
  orderCreatedIndex: index('order_returns_order_created_idx').on(table.orderId, table.createdAt.desc(), table.id.desc()),
  createdIndex: index('order_returns_created_idx').on(table.createdAt.desc(), table.id.desc()),
  statusCheck: check('order_returns_status_known', sql`${table.status} in ('requested', 'approved', 'rejected', 'disputed', 'in_transit', 'refund_pending', 'refund_failed', 'refunded', 'closed', 'withdrawn')`),
  versionCheck: check('order_returns_version_positive', sql`${table.version} >= 1`),
  fingerprintCheck: check('order_returns_fingerprint_valid', sql`${table.requestFingerprint} ~ '^[a-f0-9]{64}$'`),
  amountsCheck: check('order_returns_amounts_valid', sql`${table.merchandiseAmount} >= 0 and ${table.taxAmount} >= 0 and ${table.shippingAmount} >= 0 and ${table.totalAmount}::bigint = ${table.merchandiseAmount}::bigint + ${table.taxAmount}::bigint + ${table.shippingAmount}::bigint`),
  policyCheck: check('order_returns_policy_known', sql`${table.refundPolicyCode} = 'proportional_tax_full_shipping_v1'`),
  textCheck: check('order_returns_text_valid', sql`char_length(btrim(${table.reason})) between 1 and 2000 and char_length(btrim(${table.returnPolicy})) >= 1`),
  brandDecisionCheck: check('order_returns_brand_decision_valid', sql`((${table.brandDecision} is null and ${table.brandReason} is null and ${table.brandInstructions} is null and ${table.brandDecidedAt} is null) or (${table.brandDecision} = 'approved' and ${table.brandReason} is null and char_length(btrim(${table.brandInstructions})) between 1 and 4000 and ${table.brandDecidedAt} is not null) or (${table.brandDecision} = 'rejected' and char_length(btrim(${table.brandReason})) between 1 and 2000 and ${table.brandInstructions} is null and ${table.brandDecidedAt} is not null)) is true`),
  disputeCheck: check('order_returns_dispute_valid', sql`((${table.disputeReason} is null and ${table.disputedAt} is null) or (char_length(btrim(${table.disputeReason})) between 1 and 2000 and ${table.disputedAt} is not null)) is true`),
  adminDecisionCheck: check('order_returns_admin_decision_valid', sql`((${table.adminDecision} is null and ${table.adminReason} is null and ${table.adminInstructions} is null and ${table.adminDecidedAt} is null) or (${table.adminDecision} in ('approved', 'rejected') and char_length(btrim(${table.adminReason})) between 1 and 2000 and ${table.adminDecidedAt} is not null and ((${table.adminDecision} = 'approved' and char_length(btrim(${table.adminInstructions})) between 1 and 4000) or (${table.adminDecision} = 'rejected' and ${table.adminInstructions} is null)))) is true`),
  trackingCheck: check('order_returns_tracking_valid', sql`((${table.sentAt} is null and ${table.carrier} is null and ${table.trackingNumber} is null and ${table.trackingUrl} is null) or (${table.sentAt} is not null and char_length(btrim(${table.carrier})) between 1 and 120 and char_length(btrim(${table.trackingNumber})) between 1 and 160)) is true`),
  receiptCheck: check('order_returns_receipt_valid', sql`(${table.status} not in ('refund_pending', 'refund_failed', 'refunded') or ${table.receivedAt} is not null) and ((${table.status} = 'refunded') = (${table.refundedAt} is not null))`),
}));

export const orderReturnItems = ufitSchema.table('order_return_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  returnId: uuid('return_id').notNull(), orderId: uuid('order_id').notNull(),
  orderItemId: uuid('order_item_id').notNull(),
  quantity: integer('quantity').notNull(), restockQuantity: integer('restock_quantity'),
}, table => ({
  itemUnique: uniqueIndex('order_return_items_return_item_unique').on(table.returnId, table.orderItemId),
  returnOrderForeignKey: foreignKey({name: 'order_return_items_return_order_fk', columns: [table.returnId, table.orderId], foreignColumns: [orderReturns.id, orderReturns.orderId]}),
  itemOrderForeignKey: foreignKey({name: 'order_return_items_item_order_fk', columns: [table.orderItemId, table.orderId], foreignColumns: [orderItems.id, orderItems.orderId]}),
  orderItemIndex: index('order_return_items_order_item_idx').on(table.orderItemId),
  quantityCheck: check('order_return_items_quantities_valid', sql`${table.quantity} >= 1 and (${table.restockQuantity} is null or ${table.restockQuantity} between 0 and ${table.quantity})`),
}));

export const orderReturnRefunds = ufitSchema.table('order_return_refunds', {
  id: uuid('id').primaryKey().defaultRandom(),
  returnId: uuid('return_id').notNull().references(() => orderReturns.id),
  attemptNumber: integer('attempt_number').notNull(), amount: integer('amount').notNull(),
  state: text('state').notNull(), providerStatus: text('provider_status'), stripeRefundId: text('stripe_refund_id').unique(),
  nextRecoveryAt: timestamp('next_recovery_at', {withTimezone: true}).notNull(),
  ...timestamps,
}, table => ({
  attemptUnique: uniqueIndex('order_return_refunds_attempt_unique').on(table.returnId, table.attemptNumber),
  activeUnique: uniqueIndex('order_return_refunds_one_active_unique').on(table.returnId).where(sql`${table.state} in ('queued', 'pending')`),
  recoveryIndex: index('order_return_refunds_recovery_idx').on(table.nextRecoveryAt, table.id).where(sql`${table.state} in ('queued', 'pending')`),
  amountCheck: check('order_return_refunds_amount_valid', sql`${table.amount} >= 0 and ${table.attemptNumber} >= 1`),
  stateCheck: check('order_return_refunds_state_valid', sql`${table.state} in ('queued', 'pending', 'succeeded', 'failed')`),
  providerCheck: check('order_return_refunds_provider_valid', sql`((${table.state} = 'queued' and ${table.stripeRefundId} is null and ${table.providerStatus} is null) or (${table.state} = 'succeeded' and ((${table.amount} = 0 and ${table.stripeRefundId} is null and ${table.providerStatus} is null) or (${table.amount} > 0 and ${table.stripeRefundId} is not null and ${table.providerStatus} = 'succeeded'))) or (${table.amount} > 0 and ${table.stripeRefundId} is not null and ((${table.state} = 'pending' and ${table.providerStatus} in ('pending', 'requires_action')) or (${table.state} = 'failed' and ${table.providerStatus} in ('failed', 'canceled'))))) is true`),
}));

export const returnCommissionAdjustments = ufitSchema.table('return_commission_adjustments', {
  id: uuid('id').primaryKey().defaultRandom(),
  returnItemId: uuid('return_item_id').notNull().references(() => orderReturnItems.id),
  commissionId: uuid('commission_id').notNull().references(() => commissions.id),
  amount: integer('amount').notNull(), createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
}, table => ({
  adjustmentUnique: uniqueIndex('return_commission_adjustments_item_commission_unique').on(table.returnItemId, table.commissionId),
  commissionIndex: index('return_commission_adjustments_commission_idx').on(table.commissionId),
  amountCheck: check('return_commission_adjustments_amount_valid', sql`${table.amount} >= 0`),
}));

export type OrderReturnRow = typeof orderReturns.$inferSelect;
export type OrderReturnItemRow = typeof orderReturnItems.$inferSelect;
export type OrderReturnRefundRow = typeof orderReturnRefunds.$inferSelect;

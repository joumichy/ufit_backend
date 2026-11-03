import {sql} from 'drizzle-orm';
import {boolean, foreignKey, index, integer, jsonb, text, timestamp, uniqueIndex, uuid} from 'drizzle-orm/pg-core';
import {ufitSchema, timestamps} from './schema-base';
import {paymentSettlements} from './schema.payment-settlements';
import {paymentAllocations} from './schema.payment-allocations';
import {DISBURSEMENT_EXECUTION as C, type DisbursementOperation} from '../../../modules/payments/domain/payment-disbursement.repository';
import type {DisbursementAssessment} from '../../../modules/payments/domain/payment-disbursement';
import type {TransferSnapshot, ReversalSnapshot} from '../../../modules/payments/domain/payment-transfer';

export const paymentDisbursementJobs = ufitSchema.table('payment_disbursement_jobs', {
  paymentId: uuid('payment_id').primaryKey().references(() => paymentSettlements.paymentId), status: text('status').notNull(),
  nextAttemptAt: timestamp('next_attempt_at', {withTimezone: true}), leaseToken: uuid('lease_token'),
  leaseUntil: timestamp('lease_until', {withTimezone: true}), failureCode: text('failure_code'), ...timestamps,
}, table => ({due: index('payment_disbursement_jobs_due').on(table.status, table.nextAttemptAt, table.leaseUntil)}));
export const paymentDisbursementTargets = ufitSchema.table('payment_disbursement_targets', {
  id: uuid('id').primaryKey(), paymentId: uuid('payment_id').notNull().references(() => paymentAllocations.paymentId),
  fingerprint: text('fingerprint').notNull(), assessment: jsonb('assessment').$type<DisbursementAssessment>().notNull(),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull(),
}, table => ({identity: uniqueIndex('payment_disbursement_targets_identity').on(table.id, table.paymentId),
  fingerprint: uniqueIndex('payment_disbursement_targets_fingerprint').on(table.paymentId, table.fingerprint)}));
export const paymentTransferOperations = ufitSchema.table('payment_transfer_operations', {
  id: uuid('id').primaryKey(), paymentId: uuid('payment_id').notNull(), targetId: uuid('target_id').notNull(),
  kind: text('kind').notNull(), state: text('state').notNull(), armed: boolean('armed').notNull().default(false), allocationKey: text('allocation_key').notNull(),
  originalOperationId: uuid('original_operation_id'), instruction: jsonb('instruction').$type<DisbursementOperation['instruction']>().notNull(),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull(),
}, table => ({target: foreignKey({columns: [table.targetId, table.paymentId], foreignColumns: [paymentDisbursementTargets.id, paymentDisbursementTargets.paymentId]}),
  original: foreignKey({columns: [table.originalOperationId], foreignColumns: [table.id]}),
  identity: uniqueIndex('payment_transfer_operations_identity').on(table.id, table.paymentId),
  active: uniqueIndex('payment_transfer_operations_one_open').on(table.paymentId).where(sql`${table.state}=${C.operationState.open}`)}));
export const paymentTransferReceipts = ufitSchema.table('payment_transfer_receipts', {
  operationId: uuid('operation_id').primaryKey(), paymentId: uuid('payment_id').notNull(), providerId: text('provider_id').notNull(),
  kind: text('kind').notNull(), amount: integer('amount').notNull(), currency: text('currency').notNull(),
  snapshot: jsonb('snapshot').$type<TransferSnapshot | ReversalSnapshot>().notNull(),
  recordedAt: timestamp('recorded_at', {withTimezone: true}).notNull(),
}, table => ({operation: foreignKey({columns: [table.operationId, table.paymentId], foreignColumns: [paymentTransferOperations.id, paymentTransferOperations.paymentId]}),
  provider: uniqueIndex('payment_transfer_receipts_provider').on(table.providerId)}));

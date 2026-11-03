import {sql} from 'drizzle-orm';
import {check,foreignKey,integer,text,timestamp,uniqueIndex,uuid,date} from 'drizzle-orm/pg-core';
import {ufitSchema} from './schema-base';
import {users} from './schema.identity';
import {refundOrganizationRevisions} from './schema.refund-organizations';
import {REFUND_PROOF as P} from '../../../modules/orders/domain/refund-proof.contract';
import {REFUND_ORGANIZATION as O} from '../../../modules/orders/domain/refund-organization';
export const refundPaymentProofs=ufitSchema.table('refund_payment_proofs',{
  id:uuid('id').primaryKey(),caseId:uuid('case_id').notNull(),organizationVersion:integer('organization_version').notNull(),
  uploadedBy:uuid('uploaded_by').references(()=>users.id),requestId:uuid('request_id').notNull(),requestFingerprint:text('request_fingerprint').notNull(),
  amount:integer('amount').notNull(),currency:text('currency').notNull(),transferReference:text('transfer_reference').notNull(),transferredOn:date('transferred_on').notNull(),
  objectPath:text('object_path').notNull(),contentType:text('content_type').notNull(),byteSize:integer('byte_size').notNull(),sha256:text('sha256').notNull(),
  state:text('state').notNull(),submittedAt:timestamp('submitted_at',{withTimezone:true}),
},table=>({
  revision:foreignKey({name:'refund_proof_organization_revision_fk',columns:[table.caseId,table.organizationVersion],foreignColumns:[refundOrganizationRevisions.caseId,refundOrganizationRevisions.version]}),
  request:uniqueIndex('refund_proof_request_unique').on(table.caseId,table.requestId),
  object:uniqueIndex('refund_proof_object_unique').on(table.objectPath),
  submitted:uniqueIndex('refund_proof_submitted_unique').on(table.caseId).where(sql`${table.state}=${P.state.submitted}`),
  shape:check('refund_proof_state_valid',sql`((${table.state}=${P.state.pending} and ${table.submittedAt} is null) or (${table.state}=${P.state.submitted} and ${table.submittedAt} is not null)) is true`),
  amount:check('refund_proof_amount_valid',sql`${table.amount}>=${P.amount.minimum} and ${table.currency} ~ ${P.currencyPattern}`),
  reference:check('refund_proof_reference_valid',sql`char_length(btrim(${table.transferReference})) between ${P.text.minimum} and ${P.text.referenceMaximum}`),
  file:check('refund_proof_file_valid',sql`${table.contentType} in (${P.mime.pdf},${P.mime.jpeg}) and ${table.byteSize} between ${P.file.minimumBytes} and ${P.file.maximumBytes} and ${table.sha256} ~ ${O.hash.pattern} and ${table.requestFingerprint} ~ ${O.hash.pattern}`),
}));

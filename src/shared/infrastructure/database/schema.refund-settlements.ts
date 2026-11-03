import {sql} from 'drizzle-orm';
import {bigint,boolean,check,date,foreignKey,integer,text,timestamp,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import {ufitSchema} from './schema-base';
import {users} from './schema.identity';
import {refundOrganizationCases} from './schema.refund-organizations';
import {refundPaymentProofs} from './schema.refund-proofs';
import {REFUND_PROOF_REVIEW as R} from '../../../modules/orders/domain/refund-proof-review';
import {REFUND_ORGANIZATION as O} from '../../../modules/orders/domain/refund-organization';
import {REFUND_PROOF as P} from '../../../modules/orders/domain/refund-proof.contract';

export const refundProofReviews=ufitSchema.table('refund_proof_reviews',{
  id:uuid('id').primaryKey(),caseId:uuid('case_id').notNull(),proofId:uuid('proof_id').notNull(),organizationVersion:integer('organization_version').notNull(),
  requestId:uuid('request_id').notNull(),requestFingerprint:text('request_fingerprint').notNull(),reviewedBy:uuid('reviewed_by').references(()=>users.id),
  decision:text('decision').notNull(),reason:text('reason').notNull(),verificationReference:text('verification_reference'),reviewedAt:timestamp('reviewed_at',{withTimezone:true}).notNull(),
},table=>({
  proof:foreignKey({name:'refund_review_proof_revision_fk',columns:[table.caseId,table.proofId,table.organizationVersion],foreignColumns:[refundPaymentProofs.caseId,refundPaymentProofs.id,refundPaymentProofs.organizationVersion]}),
  proofUnique:uniqueIndex('refund_review_proof_unique').on(table.proofId),requestUnique:uniqueIndex('refund_review_request_unique').on(table.caseId,table.requestId),
  settlementIdentity:uniqueIndex('refund_review_settlement_identity').on(table.caseId,table.proofId,table.id,table.decision),
  fingerprint:check('refund_review_fingerprint_valid',sql`${table.requestFingerprint} ~ ${O.hash.pattern}`),
  reason:check('refund_review_reason_valid',sql`char_length(btrim(${table.reason})) between ${R.text.minimum} and ${R.text.reasonMaximum}`),
  decision:check('refund_review_decision_valid',sql`((${table.decision}=${R.decision.reject} and ${table.verificationReference} is null) or (${table.decision}=${R.decision.confirm} and char_length(btrim(${table.verificationReference})) between ${R.text.minimum} and ${R.text.referenceMaximum})) is true`),
}));
export const externalRefundSettlements=ufitSchema.table('external_refund_settlements',{
  id:uuid('id').primaryKey(),caseId:uuid('case_id').notNull(),orderId:uuid('order_id').notNull(),proofId:uuid('proof_id').notNull(),reviewId:uuid('review_id').notNull(),reviewDecision:text('review_decision').notNull(),
  amount:integer('amount').notNull(),currency:text('currency').notNull(),settledOn:date('settled_on').notNull(),confirmedAt:timestamp('confirmed_at',{withTimezone:true}).notNull(),
},table=>({
  caseUnique:uniqueIndex('external_refund_case_unique').on(table.caseId),proofUnique:uniqueIndex('external_refund_proof_unique').on(table.proofId),reviewUnique:uniqueIndex('external_refund_review_unique').on(table.reviewId),
  order:foreignKey({name:'external_refund_case_order_fk',columns:[table.caseId,table.orderId],foreignColumns:[refundOrganizationCases.id,refundOrganizationCases.orderId]}),
  review:foreignKey({name:'external_refund_confirmed_review_fk',columns:[table.caseId,table.proofId,table.reviewId,table.reviewDecision],foreignColumns:[refundProofReviews.caseId,refundProofReviews.proofId,refundProofReviews.id,refundProofReviews.decision]}),
  money:foreignKey({name:'external_refund_proof_money_fk',columns:[table.proofId,table.caseId,table.amount,table.currency,table.settledOn],foreignColumns:[refundPaymentProofs.id,refundPaymentProofs.caseId,refundPaymentProofs.amount,refundPaymentProofs.currency,refundPaymentProofs.transferredOn]}),
  decision:check('external_refund_confirm_required',sql`${table.reviewDecision}=${R.decision.confirm}`),
  amount:check('external_refund_amount_valid',sql`${table.amount}>=${P.amount.minimum} and ${table.currency} ~ ${P.currencyPattern}`),
}));

// Defined by migration0039: both consumers read the same provider/external facts.
export const returnRefundFinancialFacts=ufitSchema.view('return_refund_financial_facts',{
  returnId:uuid('return_id').notNull(),orderId:uuid('order_id').notNull(),amount:bigint('amount',{mode:'number'}).notNull(),stripeAmount:bigint('stripe_amount',{mode:'number'}).notNull(),
  confirmationCount:integer('confirmation_count').notNull(),externalSettlementId:uuid('external_settlement_id'),invalid:boolean('invalid').notNull(),
}).existing();

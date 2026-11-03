import type {RefundProofAsset} from './refund-proof.contract';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {REFUND_ORGANIZATION as O,type RefundOrganizationAccess,type RefundOrganizationDocument,type RefundOrganizationReference} from './refund-organization';
import {REFUND_RECOVERY} from './refund-recovery.contract';

export const REFUND_PROOF_REVIEW = {
  repository:Symbol('RefundProofReviewRepository'),
  decision:{reject:'reject',confirm:'confirm'},status:{submitted:'submitted',rejected:'rejected',verified:'verified'},
  text:{minimum:1,reasonMaximum:2000,referenceMaximum:160},
  money:{minimum:1,maximum:REFUND_RECOVERY.amount.maximum,currencyPattern:'^[A-Z]{3}$'},
  route:{review:':kind/:id/proof-reviews',receipt:':kind/:id/proof-reviews/commands/:requestId'},
  history:{defaultLimit:20,minimumLimit:1,maximumLimit:50,overflow:1,first:0,last:-1},
  source:'external_verified',stage:{recorded:'recorded',reviewable:'reviewable'},
  failure:{
    unverified:{code:'refund_proof_file_unverified',message:'The private refund document must be verified before settlement'},
    input:{code:'refund_proof_review_input_invalid',message:'Invalid refund document review'},
    state:{code:'refund_proof_review_changed',message:'This refund document or its instructions changed; reload before deciding'},
    replay:{code:'refund_proof_review_request_reused',message:'This request already describes another refund decision'},
    receipt:{code:'refund_proof_review_receipt_missing',message:'This refund decision has not been recorded'},
    persisted:{code:'refund_proof_review_persisted_invalid',message:'The recorded refund decision or settlement is inconsistent'},
  },
} as const;
const R=REFUND_PROOF_REVIEW;
const reviewBase={requestId:z.uuid(),expectedVersion:z.number().int().min(O.revision.first).max(O.revision.maximum),proofId:z.uuid(),reason:z.string().trim().min(R.text.minimum).max(R.text.reasonMaximum)};
export const refundProofReviewCommandSchema=z.discriminatedUnion('decision',[
  z.object({...reviewBase,decision:z.literal(R.decision.reject)}).strict(),
  z.object({...reviewBase,decision:z.literal(R.decision.confirm),verificationReference:z.string().trim().min(R.text.minimum).max(R.text.referenceMaximum)}).strict(),
]);
export type RefundProofReviewCommand=z.infer<typeof refundProofReviewCommandSchema>;
export const refundProofReviewSchema=z.object({decision:z.enum(Object.values(R.decision)),reason:z.string().trim().min(R.text.minimum).max(R.text.reasonMaximum),
  verificationReference:z.string().trim().min(R.text.minimum).max(R.text.referenceMaximum).nullable(),reviewedAt:z.iso.datetime()}).strict()
  .refine(value=>(value.decision===R.decision.reject)===(value.verificationReference===null));
export type RefundProofReview=z.infer<typeof refundProofReviewSchema>;
export const externalRefundSettlementSchema=z.object({id:z.uuid(),source:z.literal(R.source),amount:z.number().int().min(R.money.minimum).max(R.money.maximum),currency:z.string().regex(new RegExp(R.money.currencyPattern)),settledOn:z.iso.date(),confirmedAt:z.iso.datetime()}).strict();
export type ExternalRefundSettlement=z.infer<typeof externalRefundSettlementSchema>;
export interface RefundProofReviewResult {document:RefundOrganizationDocument;receipt:{requestId:string;proofId:string;decision:RefundProofReviewCommand['decision'];};}
export type RefundProofReviewPreparation={kind:typeof R.stage.recorded;result:RefundProofReviewResult}|{kind:typeof R.stage.reviewable;asset:RefundProofAsset};
export interface RefundVerifiedFile {sha256:string;byteSize:number;}
export interface RefundProofReviewRepository {
  prepare(access:RefundOrganizationAccess,reference:RefundOrganizationReference,command:RefundProofReviewCommand):Promise<RefundProofReviewPreparation>;
  review(access:RefundOrganizationAccess,reference:RefundOrganizationReference,command:RefundProofReviewCommand,file:RefundVerifiedFile|null):Promise<RefundProofReviewResult>;
  receipt(access:RefundOrganizationAccess,reference:RefundOrganizationReference,requestId:string):Promise<RefundProofReviewResult|undefined>;
}
export function refundReviewFingerprint(command:RefundProofReviewCommand):string {
  return createHash(O.hash.algorithm).update(JSON.stringify(command)).digest(O.hash.encoding);
}

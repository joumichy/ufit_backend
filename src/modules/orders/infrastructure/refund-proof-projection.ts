import {ConflictException} from '@nestjs/common';
import {and,eq,inArray,isNotNull} from 'drizzle-orm';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {refundOrganizationCases} from '../../../shared/infrastructure/database/schema.refund-organizations';
import {externalRefundSettlements,refundProofReviews} from '../../../shared/infrastructure/database/schema.refund-settlements';
import {REFUND_ORGANIZATION as O,type RefundOrganizationReference} from '../domain/refund-organization';
import {REFUND_RECOVERY as Recovery} from '../domain/refund-recovery.contract';
import {REFUND_PROOF_REVIEW as R,externalRefundSettlementSchema,refundProofReviewSchema,type ExternalRefundSettlement} from '../domain/refund-proof-review';
import {presentRefundProof,type RefundProofAsset} from '../domain/refund-proof.contract';

export async function projectStoredRefundProofs(database:DatabaseSession,assets:RefundProofAsset[]) {
  if(!assets.length)return [];
  const rows=await database.db.select().from(refundProofReviews).where(inArray(refundProofReviews.proofId,assets.map(asset=>asset.id)));
  const byId=new Map(rows.map(row=>[row.proofId,row]));
  return assets.map(asset=>{
    const row=byId.get(asset.id);
    if(!row)return presentRefundProof(asset);
    if(row.caseId!==asset.caseId || row.organizationVersion!==asset.organizationVersion)throw new ConflictException(R.failure.persisted);
    const review=refundProofReviewSchema.safeParse({decision:row.decision,reason:row.reason,verificationReference:row.verificationReference,reviewedAt:row.reviewedAt.toISOString()});
    if(!review.success)throw new ConflictException(R.failure.persisted);
    return presentRefundProof(asset,review.data);
  });
}
export function projectExternalRefundSettlement(row:typeof externalRefundSettlements.$inferSelect):ExternalRefundSettlement {
  const parsed=externalRefundSettlementSchema.safeParse({id:row.id,source:R.source,amount:row.amount,currency:row.currency,settledOn:row.settledOn,confirmedAt:row.confirmedAt.toISOString()});
  if(!parsed.success)throw new ConflictException(R.failure.persisted);
  return parsed.data;
}
export async function findExternalRefundSettlement(database:DatabaseSession,reference:RefundOrganizationReference):Promise<ExternalRefundSettlement|null> {
  const [row]=await database.db.select({settlement:externalRefundSettlements}).from(externalRefundSettlements)
    .innerJoin(refundOrganizationCases,eq(refundOrganizationCases.id,externalRefundSettlements.caseId))
    .where(reference.kind===Recovery.kind.orderReturn?eq(refundOrganizationCases.returnId,reference.id):eq(refundOrganizationCases.cancellationId,reference.id)).limit(O.persistence.one);
  return row?projectExternalRefundSettlement(row.settlement):null;
}
export async function cancellationSettlementMap(database:DatabaseSession,orderIds:string[]):Promise<Map<string,ExternalRefundSettlement>> {
  if(!orderIds.length)return new Map();
  const rows=await database.db.select({settlement:externalRefundSettlements}).from(externalRefundSettlements)
    .innerJoin(refundOrganizationCases,eq(refundOrganizationCases.id,externalRefundSettlements.caseId))
    .where(and(inArray(externalRefundSettlements.orderId,orderIds),inArray(refundOrganizationCases.orderId,orderIds),
      // The scope is the cancellation origin; return settlements are separate.
      isNotNull(refundOrganizationCases.cancellationId)));
  return new Map(rows.map(({settlement})=>[settlement.orderId,projectExternalRefundSettlement(settlement)]));
}

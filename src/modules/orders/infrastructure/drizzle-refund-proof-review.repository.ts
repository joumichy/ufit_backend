import {randomUUID} from 'node:crypto';
import {ConflictException,ForbiddenException,Inject,Injectable} from '@nestjs/common';
import {and,eq} from 'drizzle-orm';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT,type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {refundPaymentProofs} from '../../../shared/infrastructure/database/schema.refund-proofs';
import {externalRefundSettlements,refundProofReviews} from '../../../shared/infrastructure/database/schema.refund-settlements';
import {REFUND_ORGANIZATION as O,type RefundOrganizationAccess,type RefundOrganizationReference} from '../domain/refund-organization';
import {REFUND_PROOF as P,type RefundProofAsset} from '../domain/refund-proof.contract';
import {REFUND_PROOF_REVIEW as R,refundReviewFingerprint,type RefundProofReviewCommand,type RefundProofReviewPreparation,type RefundProofReviewRepository,type RefundProofReviewResult,type RefundVerifiedFile} from '../domain/refund-proof-review';
import {loadRefundOrganizationContext,projectRefundOrganizationDocument,type RefundOrganizationContext} from './refund-organization-context';
import {prepareExternalRefundEffect,applyExternalRefundEffect} from './external-refund-financials';

@Injectable()
export class DrizzleRefundProofReviewRepository implements RefundProofReviewRepository {
  constructor(@Inject(DatabaseService) private readonly database:DatabaseSession) {}
  async prepare(access:RefundOrganizationAccess,reference:RefundOrganizationReference,command:RefundProofReviewCommand):Promise<RefundProofReviewPreparation> {
    this.assertAdmin(access);
    return this.database.db.transaction(async tx=>this.prepareCurrent({db:tx},await loadRefundOrganizationContext({db:tx},access,reference,false),access,command),READ_SNAPSHOT);
  }
  async review(access:RefundOrganizationAccess,reference:RefundOrganizationReference,command:RefundProofReviewCommand,file:RefundVerifiedFile|null):Promise<RefundProofReviewResult> {
    this.assertAdmin(access);
    return this.database.db.transaction(async tx=>{
      const database:DatabaseSession={db:tx},context=await loadRefundOrganizationContext(database,access,reference,true);
      const preparation=await this.prepareCurrent(database,context,access,command);
      if(preparation.kind===R.stage.recorded)return preparation.result;
      const {asset}=preparation;
      if(command.decision===R.decision.confirm && (file?.sha256!==asset.sha256 || file?.byteSize!==asset.byteSize))throw new ConflictException(R.failure.unverified);
      const effects=command.decision===R.decision.confirm?await prepareExternalRefundEffect(database,context):null;
      const now=new Date(),id=randomUUID();
      const [review]=await tx.insert(refundProofReviews).values({id,caseId:asset.caseId,proofId:asset.id,organizationVersion:command.expectedVersion,
        requestId:command.requestId,requestFingerprint:refundReviewFingerprint(command),reviewedBy:access.actorId,decision:command.decision,reason:command.reason,
        verificationReference:command.decision===R.decision.confirm?command.verificationReference:null,reviewedAt:now}).returning();
      if(effects){
        await tx.insert(externalRefundSettlements).values({id:randomUUID(),caseId:asset.caseId,orderId:context.order.id,proofId:asset.id,reviewId:id,reviewDecision:R.decision.confirm,
          amount:asset.amount,currency:asset.currency,settledOn:asset.transferredOn,confirmedAt:now});
        await applyExternalRefundEffect(database,effects,now);
      }
      const current=await loadRefundOrganizationContext(database,access,reference,true);
      return {document:projectRefundOrganizationDocument(current,access),receipt:{requestId:review.requestId,proofId:review.proofId,decision:command.decision}};
    });
  }
  async receipt(access:RefundOrganizationAccess,reference:RefundOrganizationReference,requestId:string):Promise<RefundProofReviewResult|undefined> {
    this.assertAdmin(access);
    return this.database.db.transaction(async tx=>{
      const context=await loadRefundOrganizationContext({db:tx},access,reference,false);
      if(!context.stored)return undefined;
      const [review]=await tx.select().from(refundProofReviews).where(and(eq(refundProofReviews.caseId,context.stored.id),eq(refundProofReviews.requestId,requestId))).limit(O.persistence.one);
      if(!review)return undefined;
      if(review.reviewedBy!==access.actorId)throw new ForbiddenException(O.failure.access);
      if(!Object.values(R.decision).some(decision=>decision===review.decision))throw new ConflictException(R.failure.persisted);
      return {document:projectRefundOrganizationDocument(context,access),receipt:{requestId:review.requestId,proofId:review.proofId,decision:review.decision as RefundProofReviewCommand['decision']}};
    },READ_SNAPSHOT);
  }
  private assertAdmin(access:RefundOrganizationAccess) {if(access.scope!==O.scope.administrator)throw new ForbiddenException(O.failure.access);}
  private async prepareCurrent(database:DatabaseSession,context:RefundOrganizationContext,access:RefundOrganizationAccess,command:RefundProofReviewCommand):Promise<RefundProofReviewPreparation> {
    if(!context.stored)throw new ConflictException(R.failure.state);
    const [review]=await database.db.select().from(refundProofReviews).where(and(eq(refundProofReviews.caseId,context.stored.id),eq(refundProofReviews.requestId,command.requestId))).limit(O.persistence.one);
    if(review){
      if(review.reviewedBy!==access.actorId || review.requestFingerprint!==refundReviewFingerprint(command))throw new ConflictException(R.failure.replay);
      return {kind:R.stage.recorded,result:{document:projectRefundOrganizationDocument(context,access),receipt:{requestId:review.requestId,proofId:review.proofId,decision:command.decision}}};
    }
    if(context.settlement || context.organization?.version!==command.expectedVersion || context.proof?.id!==command.proofId || context.proof.status!==R.status.submitted)throw new ConflictException(R.failure.state);
    const [asset]=await database.db.select().from(refundPaymentProofs).where(and(eq(refundPaymentProofs.id,command.proofId),eq(refundPaymentProofs.caseId,context.stored.id),eq(refundPaymentProofs.state,P.state.submitted))).limit(O.persistence.one);
    if(!asset || asset.organizationVersion!==command.expectedVersion || asset.amount!==context.summary.amount || asset.currency!==context.summary.currency)throw new ConflictException(R.failure.persisted);
    return {kind:R.stage.reviewable,asset:asset as RefundProofAsset};
  }
}

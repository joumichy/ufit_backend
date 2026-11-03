import {refundOrganizationCases} from '../../../shared/infrastructure/database/schema.refund-organizations';
import {REFUND_PROOF_REVIEW as Review} from '../domain/refund-proof-review';
import {projectStoredRefundProofs} from './refund-proof-projection';
import {randomUUID} from 'node:crypto';
import {ConflictException,ForbiddenException,Inject,Injectable,NotFoundException} from '@nestjs/common';
import {and,eq,max,desc,lt} from 'drizzle-orm';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT,type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {refundPaymentProofs as proofs} from '../../../shared/infrastructure/database/schema.refund-proofs';
import {REFUND_ORGANIZATION as O,type RefundOrganizationAccess,type RefundOrganizationReference} from '../domain/refund-organization';
import {REFUND_PROOF as P,refundProofFingerprint,type RefundProofAsset,type RefundProofCommand,type RefundProofReceipt,type RefundProofRepository,type PreparedRefundProof} from '../domain/refund-proof.contract';
import {loadRefundOrganizationContext,type RefundOrganizationContext} from './refund-organization-context';

@Injectable()
export class DrizzleRefundProofRepository implements RefundProofRepository {
  constructor(@Inject(DatabaseService) private readonly database:DatabaseSession) {}
  async reserve(access:RefundOrganizationAccess,reference:RefundOrganizationReference,command:RefundProofCommand,file:PreparedRefundProof):Promise<RefundProofAsset> {
    this.assertBrand(access);
    return this.database.db.transaction(async tx=>{
      const context=await loadRefundOrganizationContext({db:tx},access,reference,true);
      if(!context.stored) throw new ConflictException(P.failure.state);
      const [existing]=await tx.select().from(proofs).where(and(eq(proofs.caseId,context.stored.id),eq(proofs.requestId,command.requestId))).limit(O.persistence.one);
      const fingerprint=refundProofFingerprint(command,file);
      if(existing) {
        if(existing.uploadedBy!==access.actorId || existing.requestFingerprint!==fingerprint) throw new ConflictException(P.failure.replay);
        if(existing.state===P.state.pending)this.assertReady(context,existing.organizationVersion,existing.replacesProofId);
        return existing as RefundProofAsset;
      }
      this.assertReady(context,command.expectedVersion,command.replacesProofId);
      const [last]=await tx.select({sequence:max(proofs.sequence)}).from(proofs).where(eq(proofs.caseId,context.stored.id));
      const sequence=(last.sequence ?? O.revision.absent)+O.revision.step;
      if(sequence>O.revision.maximum)throw new ConflictException(P.failure.state);
      const id=randomUUID(),extension=file.contentType===P.mime.pdf?P.extension.pdf:P.extension.jpeg;
      const [row]=await tx.insert(proofs).values({id,caseId:context.stored.id,sequence,replacesProofId:command.replacesProofId,organizationVersion:command.expectedVersion,uploadedBy:access.actorId,
        requestId:command.requestId,requestFingerprint:fingerprint,amount:context.summary.amount,currency:context.summary.currency,
        transferReference:command.transferReference,transferredOn:command.transferredOn,objectPath:context.stored.id+P.storageSettings.separator+id+extension,
        contentType:file.contentType,byteSize:file.bytes.length,sha256:file.sha256,state:P.state.pending,submittedAt:null}).returning();
      return row as RefundProofAsset;
    });
  }
  async submit(access:RefundOrganizationAccess,reference:RefundOrganizationReference,asset:RefundProofAsset):Promise<RefundProofReceipt> {
    this.assertBrand(access);
    return this.database.db.transaction(async tx=>{
      const context=await loadRefundOrganizationContext({db:tx},access,reference,true);
      const [row]=await tx.select().from(proofs).where(eq(proofs.id,asset.id)).limit(O.persistence.one);
      if(!row || row.caseId!==context.stored?.id || row.uploadedBy!==access.actorId || row.requestFingerprint!==asset.requestFingerprint) throw new ForbiddenException(O.failure.access);
      if(row.state===P.state.submitted) return this.projectReceipt({db:tx},row as RefundProofAsset);
      this.assertReady(context,row.organizationVersion,row.replacesProofId);
      const [submitted]=await tx.update(proofs).set({state:P.state.submitted,submittedAt:new Date()}).where(eq(proofs.id,row.id)).returning();
      await tx.update(refundOrganizationCases).set({currentProofId:submitted.id}).where(eq(refundOrganizationCases.id,submitted.caseId));
      return this.projectReceipt({db:tx},submitted as RefundProofAsset);
    });
  }
  async receipt(access:RefundOrganizationAccess,reference:RefundOrganizationReference,requestId:string):Promise<RefundProofReceipt|undefined> {
    this.assertBrand(access);
    return this.database.db.transaction(async tx=>{
      const context=await loadRefundOrganizationContext({db:tx},access,reference,false);
      if(!context.stored) return undefined;
      const [row]=await tx.select().from(proofs).where(and(eq(proofs.caseId,context.stored.id),eq(proofs.requestId,requestId))).limit(O.persistence.one);
      if(!row)return undefined;
      if(row.uploadedBy!==access.actorId)throw new ForbiddenException(O.failure.access);
      return this.projectReceipt({db:tx},row as RefundProofAsset);
    },READ_SNAPSHOT);
  }
  file(access:RefundOrganizationAccess,reference:RefundOrganizationReference,proofId:string):Promise<RefundProofAsset> {
    return this.database.db.transaction(async tx=>{
      const context=await loadRefundOrganizationContext({db:tx},access,reference,false);
      if(!context.stored)throw new NotFoundException(P.failure.missing);
      const [row]=await tx.select().from(proofs).where(and(eq(proofs.id,proofId),eq(proofs.caseId,context.stored!.id),eq(proofs.state,P.state.submitted))).limit(O.persistence.one);
      if(!row)throw new NotFoundException(P.failure.missing);
      return row as RefundProofAsset;
    },READ_SNAPSHOT);
  }
  history(access:RefundOrganizationAccess,reference:RefundOrganizationReference,query:{limit:number;cursor?:string}) {
    return this.database.db.transaction(async tx=>{
      const context=await loadRefundOrganizationContext({db:tx},access,reference,false);
      if(!context.stored)return {items:[],nextCursor:null};
      let sequence:number|undefined;
      if(query.cursor){
        const [anchor]=await tx.select().from(proofs).where(and(eq(proofs.caseId,context.stored.id),eq(proofs.id,query.cursor),eq(proofs.state,P.state.submitted))).limit(O.persistence.one);
        if(!anchor)throw new ConflictException(P.failure.state);
        sequence=anchor.sequence;
      }
      const rows=await tx.select().from(proofs).where(and(eq(proofs.caseId,context.stored.id),eq(proofs.state,P.state.submitted),sequence===undefined?undefined:lt(proofs.sequence,sequence)))
        .orderBy(desc(proofs.sequence)).limit(query.limit+Review.history.overflow);
      const items=await projectStoredRefundProofs({db:tx},rows.slice(Review.history.first,query.limit) as RefundProofAsset[]);
      return {items,nextCursor:rows.length>query.limit?items.at(Review.history.last)!.id:null};
    },READ_SNAPSHOT);
  }
  private assertBrand(access:RefundOrganizationAccess) {if(access.scope!==O.scope.brand)throw new ForbiddenException(O.failure.access);}
  private assertVersion(context:RefundOrganizationContext,version:number) {
    if(context.organization?.version!==version)throw new ConflictException(P.failure.state);
  }
  private assertReady(context:RefundOrganizationContext,version:number,replacesProofId:string|null) {
    this.assertVersion(context,version);
    if(context.settlement || (context.proof && context.proof.status!==Review.status.rejected) || (context.proof?.id ?? null)!==replacesProofId || context.organization?.status!==O.status.ready)throw new ConflictException(P.failure.state);
  }
  private async projectReceipt(database:DatabaseSession,asset:RefundProofAsset):Promise<RefundProofReceipt> {
    const projected=asset.state===P.state.submitted?await projectStoredRefundProofs(database,[asset]):[];
    return {requestId:asset.requestId,state:asset.state,proof:projected[O.persistence.first] ?? null};
  }
}

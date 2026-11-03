import {randomUUID} from 'node:crypto';
import {ConflictException,ForbiddenException,Inject,Injectable,NotFoundException} from '@nestjs/common';
import {and,eq} from 'drizzle-orm';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT,type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {refundPaymentProofs as proofs} from '../../../shared/infrastructure/database/schema.refund-proofs';
import {REFUND_ORGANIZATION as O,type RefundOrganizationAccess,type RefundOrganizationReference} from '../domain/refund-organization';
import {REFUND_PROOF as P,presentRefundProof,refundProofFingerprint,type RefundProofAsset,type RefundProofCommand,type RefundProofReceipt,type RefundProofRepository,type PreparedRefundProof} from '../domain/refund-proof.contract';
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
        this.assertVersion(context,existing.organizationVersion);
        return existing as RefundProofAsset;
      }
      this.assertReady(context,command.expectedVersion);
      const id=randomUUID(),extension=file.contentType===P.mime.pdf?P.extension.pdf:P.extension.jpeg;
      const [row]=await tx.insert(proofs).values({id,caseId:context.stored.id,organizationVersion:command.expectedVersion,uploadedBy:access.actorId,
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
      this.assertVersion(context,row.organizationVersion);
      if(row.state===P.state.submitted) return this.projectReceipt(row as RefundProofAsset);
      this.assertReady(context,row.organizationVersion);
      const [submitted]=await tx.update(proofs).set({state:P.state.submitted,submittedAt:new Date()}).where(eq(proofs.id,row.id)).returning();
      return this.projectReceipt(submitted as RefundProofAsset);
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
      return this.projectReceipt(row as RefundProofAsset);
    },READ_SNAPSHOT);
  }
  file(access:RefundOrganizationAccess,reference:RefundOrganizationReference,proofId:string):Promise<RefundProofAsset> {
    return this.database.db.transaction(async tx=>{
      const context=await loadRefundOrganizationContext({db:tx},access,reference,false);
      if(context.proof?.id!==proofId)throw new NotFoundException(P.failure.missing);
      const [row]=await tx.select().from(proofs).where(and(eq(proofs.id,proofId),eq(proofs.caseId,context.stored!.id),eq(proofs.state,P.state.submitted))).limit(O.persistence.one);
      if(!row)throw new NotFoundException(P.failure.missing);
      return row as RefundProofAsset;
    },READ_SNAPSHOT);
  }
  private assertBrand(access:RefundOrganizationAccess) {if(access.scope!==O.scope.brand)throw new ForbiddenException(O.failure.access);}
  private assertVersion(context:RefundOrganizationContext,version:number) {
    if(context.organization?.version!==version)throw new ConflictException(P.failure.state);
  }
  private assertReady(context:RefundOrganizationContext,version:number) {
    this.assertVersion(context,version);
    if(context.proof || context.organization?.status!==O.status.ready)throw new ConflictException(P.failure.state);
  }
  private projectReceipt(asset:RefundProofAsset):RefundProofReceipt {
    return {requestId:asset.requestId,state:asset.state,proof:asset.state===P.state.submitted?presentRefundProof(asset):null};
  }
}

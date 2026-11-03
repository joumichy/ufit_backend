import {loadRefundOrganizationContext,type RefundOrganizationContext} from './refund-organization-context';
import {randomUUID} from 'node:crypto';
import {ConflictException, ForbiddenException, Inject, Injectable} from '@nestjs/common';
import {and, eq} from 'drizzle-orm';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT, type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {refundOrganizationCases as cases, refundOrganizationRevisions as revisions} from '../../../shared/infrastructure/database/schema.refund-organizations';
import {REFUND_RECOVERY} from '../domain/refund-recovery.contract';
import {REFUND_ORGANIZATION as O, applyOrganization, organizationActions, organizationFingerprint,
  type RefundOrganizationAccess, type RefundOrganizationCommand, type RefundOrganizationDocument,
  type RefundOrganizationReference, type RefundOrganizationRepository, type RefundOrganizationResult} from '../domain/refund-organization';

type RevisionRow = typeof revisions.$inferSelect;

@Injectable()
export class DrizzleRefundOrganizationRepository implements RefundOrganizationRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  read(access: RefundOrganizationAccess, reference: RefundOrganizationReference): Promise<RefundOrganizationDocument> {
    return this.database.db.transaction(async tx => this.document(await loadRefundOrganizationContext({db:tx}, access, reference, false), access), READ_SNAPSHOT);
  }
  apply(access: RefundOrganizationAccess, reference: RefundOrganizationReference, command: RefundOrganizationCommand): Promise<RefundOrganizationResult> {
    return this.database.db.transaction(async tx => {
      const database: DatabaseSession = {db:tx}, context = await loadRefundOrganizationContext(database,access,reference,true);
      this.assertCommandScope(access,command.action);
      if(context.stored) {
        const existing=await this.findReceipt(database,context.stored.id,command.requestId);
        if(existing) {
          if(existing.changedBy!==access.actorId || existing.requestFingerprint!==organizationFingerprint(command)) throw new ConflictException(O.failure.replay);
          return {document:this.document(context,access),receipt:{requestId:existing.requestId,version:existing.version}};
        }
      }
      if(context.proof) throw new ConflictException(O.failure.changed);
      const next=applyOrganization(context.organization,access.scope,command,new Date().toISOString());
      const stored=context.stored ?? {id:randomUUID(),orderId:context.order.id,
        returnId:reference.kind===REFUND_RECOVERY.kind.orderReturn?reference.id:null,
        cancellationId:reference.kind===REFUND_RECOVERY.kind.cancellation?reference.id:null,version:next.version};
      if(!context.stored) await tx.insert(cases).values(stored);
      await tx.insert(revisions).values({id:randomUUID(),caseId:stored.id,version:next.version,previousRevisionId:context.revision?.id ?? null,
        requestId:command.requestId,requestFingerprint:organizationFingerprint(command),action:command.action,changedBy:access.actorId,
        status:next.status,methodLabel:next.methodLabel,instructions:next.instructions,customerDetails:next.customerDetails,recordedAt:new Date(next.updatedAt)});
      if(context.stored) await tx.update(cases).set({version:next.version}).where(and(eq(cases.id,stored.id),eq(cases.version,command.expectedVersion)));
      return {document:{summary:context.summary,organization:next,proof:null,actions:organizationActions(access.scope,next)},receipt:{requestId:command.requestId,version:next.version}};
    });
  }
  receipt(access: RefundOrganizationAccess, reference: RefundOrganizationReference, requestId: string): Promise<RefundOrganizationResult | undefined> {
    return this.database.db.transaction(async tx => {
      const database: DatabaseSession={db:tx},context=await loadRefundOrganizationContext(database,access,reference,false);
      if(!context.stored) return undefined;
      const receipt=await this.findReceipt(database,context.stored.id,requestId);
      if(!receipt) return undefined;
      this.assertCommandScope(access,receipt.action);
      if(receipt.changedBy!==access.actorId) throw new ForbiddenException(O.failure.access);
      return {document:this.document(context,access),receipt:{requestId:receipt.requestId,version:receipt.version}};
    },READ_SNAPSHOT);
  }
  private document(context: RefundOrganizationContext, access: RefundOrganizationAccess): RefundOrganizationDocument {
    return {summary:context.summary,organization:context.organization,proof:context.proof,actions:organizationActions(access.scope,context.organization,context.proof !== null)};
  }
  private assertCommandScope(access: RefundOrganizationAccess, action: string) {
    if(!((access.scope===O.scope.administrator&&action===O.action.arrange)||(access.scope===O.scope.customer&&action===O.action.provideDetails))) throw new ForbiddenException(O.failure.access);
  }
  private async findReceipt(database: DatabaseSession, caseId: string, requestId: string): Promise<RevisionRow | undefined> {
    const [row]=await database.db.select().from(revisions).where(and(eq(revisions.caseId,caseId),eq(revisions.requestId,requestId))).limit(O.persistence.one);
    return row;
  }
}

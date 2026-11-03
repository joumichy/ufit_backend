import {projectStoredRefundProofs,findExternalRefundSettlement} from './refund-proof-projection';
import {REFUND_PROOF_REVIEW as RReview,type ExternalRefundSettlement} from '../domain/refund-proof-review';
import {ConflictException, ForbiddenException, NotFoundException} from '@nestjs/common';
import {and, eq} from 'drizzle-orm';
import {type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {orders, orderReturns, orderCancellations, users, userRoles, type OrderRow} from '../../../shared/infrastructure/database/schema';
import {refundOrganizationCases as cases, refundOrganizationRevisions as revisions} from '../../../shared/infrastructure/database/schema.refund-organizations';
import {DrizzleBrandsRepository} from '../../brands/drizzle-brands.repository';
import {REFUND_RECOVERY, type RefundRecoverySummary} from '../domain/refund-recovery.contract';
import {REFUND_ORGANIZATION as O, refundOrganizationSchema,organizationActions,
  type RefundOrganization, type RefundOrganizationAccess, type RefundOrganizationReference} from '../domain/refund-organization';
import {DrizzleRefundRecoveryRepository} from './drizzle-refund-recovery.repository';

import {refundPaymentProofs} from '../../../shared/infrastructure/database/schema.refund-proofs';
import {REFUND_PROOF as P,type RefundProofAsset,type RefundProofMetadata} from '../domain/refund-proof.contract';
type CaseRow = typeof cases.$inferSelect;
type RevisionRow = typeof revisions.$inferSelect;
export interface RefundOrganizationContext {order: OrderRow; summary: RefundRecoverySummary; stored: CaseRow | null; revision: RevisionRow | null; organization: RefundOrganization | null; proof: RefundProofMetadata | null; settlement:ExternalRefundSettlement|null;}
export async function loadRefundOrganizationContext(database: DatabaseSession, access: RefundOrganizationAccess, reference: RefundOrganizationReference, locking: boolean): Promise<RefundOrganizationContext> {
    const parent=reference.kind===REFUND_RECOVERY.kind.orderReturn?orderReturns:orderCancellations;
    const [origin]=await database.db.select({orderId:parent.orderId}).from(parent).where(eq(parent.id,reference.id)).limit(O.persistence.one);
    if(!origin) throw new NotFoundException(REFUND_RECOVERY.failure.missing);
    const query=database.db.select().from(orders).where(eq(orders.id,origin.orderId)).limit(O.persistence.one);
    const [order]=locking?await query.for(O.persistence.lock):await query;
    if(!order) throw new NotFoundException(REFUND_RECOVERY.failure.missing);
    await authorizeRefundOrganization(database,access,order,locking);
    const source=await new DrizzleRefundRecoveryRepository(database).detail(reference.kind,reference.id);
    if(!source) throw new NotFoundException(REFUND_RECOVERY.failure.missing);
    const condition=reference.kind===REFUND_RECOVERY.kind.orderReturn?eq(cases.returnId,reference.id):eq(cases.cancellationId,reference.id);
    const caseQuery=database.db.select().from(cases).where(condition).limit(O.persistence.one);
    const [stored]=locking?await caseQuery.for(O.persistence.lock):await caseQuery;
    if(!stored) return {order:order,summary:source.summary,stored:null,revision:null,organization:null,proof:null,settlement:null};
    if(stored.orderId!==order.id) throw new ConflictException(O.failure.persisted);
    const [revision]=await database.db.select().from(revisions).where(and(eq(revisions.caseId,stored.id),eq(revisions.version,stored.version))).limit(O.persistence.one);
    if(!revision) throw new ConflictException(O.failure.persisted);
    const organization=refundOrganizationSchema.safeParse({version:revision.version,status:revision.status,methodLabel:revision.methodLabel,
      instructions:revision.instructions,customerDetails:revision.customerDetails,updatedAt:revision.recordedAt.toISOString()});
    if(!organization.success) throw new ConflictException(O.failure.persisted);
    const [proofRow]=stored.currentProofId===null?[]:await database.db.select().from(refundPaymentProofs).where(and(eq(refundPaymentProofs.caseId,stored.id),eq(refundPaymentProofs.id,stored.currentProofId!),eq(refundPaymentProofs.state,P.state.submitted))).limit(O.persistence.one);
    if(stored.currentProofId!==null && !proofRow)throw new ConflictException(P.failure.persisted);
    const proof=proofRow?(await projectStoredRefundProofs(database,[proofRow as RefundProofAsset]))[O.persistence.first]:null;
    const settlement=await findExternalRefundSettlement(database,reference);
    if(proof && ((proof.organizationVersion>organization.data.version || (proof.status!==RReview.status.rejected && proof.organizationVersion!==organization.data.version)) || proof.amount!==source.summary.amount || proof.currency!==source.summary.currency)) throw new ConflictException(P.failure.persisted);
    if((proof?.status===RReview.status.verified)!==(settlement!==null) || (settlement && (settlement.amount!==source.summary.amount || settlement.currency!==source.summary.currency)))throw new ConflictException(RReview.failure.persisted);
    return {order:order,summary:source.summary,stored,revision,organization:organization.data,proof,settlement};
  }
async function authorizeRefundOrganization(database: DatabaseSession, access: RefundOrganizationAccess, order: OrderRow, locking: boolean) {
    if(access.scope===O.scope.brand) {
      const brands=new DrizzleBrandsRepository(database);
      const management=locking?await brands.lockManagementAccess(order.brandId,access.actorId):await brands.findManagementAccess(order.brandId,access.actorId);
      if(!management || management.actor.status!==O.actor.active || !O.actor.brandStatuses.some(status=>status===management.brand.status) || !O.actor.brandMemberRoles.some(role=>role===management.memberRole)) throw new ForbiddenException(O.failure.access);
      return;
    }
    const actorQuery=database.db.select().from(users).where(eq(users.id,access.actorId)).limit(O.persistence.one);
    const [actor]=locking?await actorQuery.for(O.persistence.lock):await actorQuery;
    if(!actor || actor.status!==O.actor.active) throw new ForbiddenException(O.failure.access);
    if(access.scope===O.scope.customer) {
      if(order.customerId!==access.actorId) throw new ForbiddenException(O.failure.access);
      return;
    }
    const roles=await database.db.select().from(userRoles).where(eq(userRoles.userId,access.actorId));
    if(!roles.some(row=>REFUND_RECOVERY.roles.some(role=>role===row.role))) throw new ForbiddenException(O.failure.access);
  }

export function projectRefundOrganizationDocument(context:RefundOrganizationContext,access:RefundOrganizationAccess) {
  return {summary:context.summary,organization:context.organization,proof:context.proof,settlement:context.settlement,
    actions:organizationActions(access.scope,context.organization,context.proof!==null && context.proof.status!==RReview.status.rejected),
    reviewActions:access.scope===O.scope.administrator && context.proof?.status===RReview.status.submitted && context.settlement===null?[RReview.decision.reject,RReview.decision.confirm]:[]};
}

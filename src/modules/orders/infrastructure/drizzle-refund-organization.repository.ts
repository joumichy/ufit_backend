import {randomUUID} from 'node:crypto';
import {ConflictException, ForbiddenException, Inject, Injectable, NotFoundException} from '@nestjs/common';
import {and, eq} from 'drizzle-orm';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT, type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {orders, orderReturns, orderCancellations, users, userRoles, type OrderRow} from '../../../shared/infrastructure/database/schema';
import {refundOrganizationCases as cases, refundOrganizationRevisions as revisions} from '../../../shared/infrastructure/database/schema.refund-organizations';
import {DrizzleBrandsRepository} from '../../brands/drizzle-brands.repository';
import {REFUND_RECOVERY, type RefundRecoverySummary} from '../domain/refund-recovery.contract';
import {REFUND_ORGANIZATION as O, applyOrganization, organizationActions, organizationFingerprint, refundOrganizationSchema,
  type RefundOrganization, type RefundOrganizationAccess, type RefundOrganizationCommand, type RefundOrganizationDocument,
  type RefundOrganizationReference, type RefundOrganizationRepository, type RefundOrganizationResult} from '../domain/refund-organization';
import {DrizzleRefundRecoveryRepository} from './drizzle-refund-recovery.repository';

type CaseRow = typeof cases.$inferSelect;
type RevisionRow = typeof revisions.$inferSelect;
interface Context {order: OrderRow; summary: RefundRecoverySummary; stored: CaseRow | null; revision: RevisionRow | null; organization: RefundOrganization | null;}
@Injectable()
export class DrizzleRefundOrganizationRepository implements RefundOrganizationRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  read(access: RefundOrganizationAccess, reference: RefundOrganizationReference): Promise<RefundOrganizationDocument> {
    return this.database.db.transaction(async tx => this.document(await this.context({db:tx}, access, reference, false), access), READ_SNAPSHOT);
  }
  apply(access: RefundOrganizationAccess, reference: RefundOrganizationReference, command: RefundOrganizationCommand): Promise<RefundOrganizationResult> {
    return this.database.db.transaction(async tx => {
      const database: DatabaseSession = {db:tx}, context = await this.context(database,access,reference,true);
      this.assertCommandScope(access,command.action);
      if(context.stored) {
        const existing=await this.findReceipt(database,context.stored.id,command.requestId);
        if(existing) {
          if(existing.changedBy!==access.actorId || existing.requestFingerprint!==organizationFingerprint(command)) throw new ConflictException(O.failure.replay);
          return {document:this.document(context,access),receipt:{requestId:existing.requestId,version:existing.version}};
        }
      }
      const next=applyOrganization(context.organization,access.scope,command,new Date().toISOString());
      const stored=context.stored ?? {id:randomUUID(),orderId:context.order.id,
        returnId:reference.kind===REFUND_RECOVERY.kind.orderReturn?reference.id:null,
        cancellationId:reference.kind===REFUND_RECOVERY.kind.cancellation?reference.id:null,version:next.version};
      if(!context.stored) await tx.insert(cases).values(stored);
      await tx.insert(revisions).values({id:randomUUID(),caseId:stored.id,version:next.version,previousRevisionId:context.revision?.id ?? null,
        requestId:command.requestId,requestFingerprint:organizationFingerprint(command),action:command.action,changedBy:access.actorId,
        status:next.status,methodLabel:next.methodLabel,instructions:next.instructions,customerDetails:next.customerDetails,recordedAt:new Date(next.updatedAt)});
      if(context.stored) await tx.update(cases).set({version:next.version}).where(and(eq(cases.id,stored.id),eq(cases.version,command.expectedVersion)));
      return {document:{summary:context.summary,organization:next,actions:organizationActions(access.scope,next)},receipt:{requestId:command.requestId,version:next.version}};
    });
  }
  receipt(access: RefundOrganizationAccess, reference: RefundOrganizationReference, requestId: string): Promise<RefundOrganizationResult | undefined> {
    return this.database.db.transaction(async tx => {
      const database: DatabaseSession={db:tx},context=await this.context(database,access,reference,false);
      if(!context.stored) return undefined;
      const receipt=await this.findReceipt(database,context.stored.id,requestId);
      if(!receipt) return undefined;
      this.assertCommandScope(access,receipt.action);
      if(receipt.changedBy!==access.actorId) throw new ForbiddenException(O.failure.access);
      return {document:this.document(context,access),receipt:{requestId:receipt.requestId,version:receipt.version}};
    },READ_SNAPSHOT);
  }
  private document(context: Context, access: RefundOrganizationAccess): RefundOrganizationDocument {
    return {summary:context.summary,organization:context.organization,actions:organizationActions(access.scope,context.organization)};
  }
  private assertCommandScope(access: RefundOrganizationAccess, action: string) {
    if(!((access.scope===O.scope.administrator&&action===O.action.arrange)||(access.scope===O.scope.customer&&action===O.action.provideDetails))) throw new ForbiddenException(O.failure.access);
  }
  private async findReceipt(database: DatabaseSession, caseId: string, requestId: string): Promise<RevisionRow | undefined> {
    const [row]=await database.db.select().from(revisions).where(and(eq(revisions.caseId,caseId),eq(revisions.requestId,requestId))).limit(O.persistence.one);
    return row;
  }
  private async context(database: DatabaseSession, access: RefundOrganizationAccess, reference: RefundOrganizationReference, locking: boolean): Promise<Context> {
    const parent=reference.kind===REFUND_RECOVERY.kind.orderReturn?orderReturns:orderCancellations;
    const [origin]=await database.db.select({orderId:parent.orderId}).from(parent).where(eq(parent.id,reference.id)).limit(O.persistence.one);
    if(!origin) throw new NotFoundException(REFUND_RECOVERY.failure.missing);
    const query=database.db.select().from(orders).where(eq(orders.id,origin.orderId)).limit(O.persistence.one);
    const [order]=locking?await query.for(O.persistence.lock):await query;
    if(!order) throw new NotFoundException(REFUND_RECOVERY.failure.missing);
    await this.authorize(database,access,order,locking);
    const source=await new DrizzleRefundRecoveryRepository(database).detail(reference.kind,reference.id);
    if(!source) throw new NotFoundException(REFUND_RECOVERY.failure.missing);
    const condition=reference.kind===REFUND_RECOVERY.kind.orderReturn?eq(cases.returnId,reference.id):eq(cases.cancellationId,reference.id);
    const caseQuery=database.db.select().from(cases).where(condition).limit(O.persistence.one);
    const [stored]=locking?await caseQuery.for(O.persistence.lock):await caseQuery;
    if(!stored) return {order:order,summary:source.summary,stored:null,revision:null,organization:null};
    if(stored.orderId!==order.id) throw new ConflictException(O.failure.persisted);
    const [revision]=await database.db.select().from(revisions).where(and(eq(revisions.caseId,stored.id),eq(revisions.version,stored.version))).limit(O.persistence.one);
    if(!revision) throw new ConflictException(O.failure.persisted);
    const organization=refundOrganizationSchema.safeParse({version:revision.version,status:revision.status,methodLabel:revision.methodLabel,
      instructions:revision.instructions,customerDetails:revision.customerDetails,updatedAt:revision.recordedAt.toISOString()});
    if(!organization.success) throw new ConflictException(O.failure.persisted);
    return {order:order,summary:source.summary,stored,revision,organization:organization.data};
  }
  private async authorize(database: DatabaseSession, access: RefundOrganizationAccess, order: OrderRow, locking: boolean) {
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
}

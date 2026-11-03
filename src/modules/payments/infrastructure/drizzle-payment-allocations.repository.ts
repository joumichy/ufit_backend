import {randomUUID} from 'node:crypto';
import {ConflictException, Inject, Injectable} from '@nestjs/common';
import {and, eq, inArray} from 'drizzle-orm';
import {z} from 'zod';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT, type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {payments, orders, brandProfiles, creatorProfiles, commissions, orderItems, paymentSettlements, paymentAllocations as plans, paymentAllocationLines as lines} from '../../../shared/infrastructure/database/schema';
import {projectFrozenOrderItem} from '../../orders/infrastructure/frozen-order-item';
import {findIdentityAccess, IdentityAccessMode} from '../../identity/infrastructure/persistence/identity-access';
import {PAYMENT_ALLOCATION as C, allocationDocumentSchema, allocationStoredPlanSchema, allocationRecipientKey,
  type AllocationDocument, type StoredAllocationPlan} from '../domain/payment-allocation';
import type {PaymentAllocationRepository} from '../domain/payment-allocation.repository';
import {readPaymentAllocationSource} from './payment-allocation-source';

@Injectable()
export class DrizzlePaymentAllocationsRepository implements PaymentAllocationRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  transaction<T>(write: boolean, operation: (repository: PaymentAllocationRepository) => Promise<T>): Promise<T> {
    return this.database.db.transaction(tx => operation(new DrizzlePaymentAllocationsRepository({db: tx})), write ? undefined : READ_SNAPSHOT);
  }
  access(actorId: string, write: boolean) { return findIdentityAccess(this.database, actorId, write ? IdentityAccessMode.Lock : IdentityAccessMode.Read); }
  async document(paymentId: string): Promise<AllocationDocument | undefined> {
    const asOf = new Date().toISOString();
    const [payment] = await this.database.db.select({orderId: payments.orderId, orderNumber: orders.orderNumber,
      brandId: orders.brandId, brandName: brandProfiles.brandName, liveMode: paymentSettlements.liveMode}).from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId)).leftJoin(brandProfiles, eq(brandProfiles.id, orders.brandId))
      .leftJoin(paymentSettlements, eq(paymentSettlements.paymentId, payments.id)).where(eq(payments.id, paymentId));
    if (!payment) return undefined;
    const plan = await this.storedPlan(paymentId);
    const creatorIDs = plan?.lines.flatMap(row => row.recipient.kind === C.kind.creator ? [row.recipient.commissionId] : []) ?? [];
    const creatorItems = creatorIDs.length ? await this.database.db.select({commissionId: commissions.id, creatorId: commissions.creatorId,
      creatorName: creatorProfiles.displayName, item: orderItems}).from(commissions)
      .innerJoin(orderItems, eq(orderItems.id, commissions.orderItemId)).innerJoin(creatorProfiles, eq(creatorProfiles.id, commissions.creatorId))
      .where(and(eq(orderItems.orderId, payment.orderId), inArray(commissions.id, creatorIDs))) : [];
    const context = {orderNumber: payment.orderNumber, brand: {id: payment.brandId, name: payment.brandName}, liveMode: payment.liveMode,
      creatorItems: creatorItems.map(({item, ...row}) => ({...row, itemName: projectFrozenOrderItem(item, C.failure.persisted).name}))};
    if (plan) return projection(allocationDocumentSchema, {paymentId, orderId: payment.orderId, asOf, context, state: C.state.recorded, blockReason: null, plan});
    const source = await readPaymentAllocationSource(this.database, paymentId, false);
    if (!source) return undefined;
    return projection(allocationDocumentSchema, {paymentId, orderId: source.orderId, asOf, context,
      state: source.plan ? C.state.notPrepared : C.state.blocked, blockReason: source.blockReason, plan: null});
  }
  async prepare(paymentId: string): Promise<StoredAllocationPlan | undefined> {
    // The source reader locks the order shared with fulfillment/refunds before any write.
    const source = await readPaymentAllocationSource(this.database, paymentId, true);
    if (!source) return undefined;
    const previous = await this.storedPlan(paymentId);
    if (previous) return previous;
    if (!source.plan) throw new ConflictException({...C.failure.unavailable, reason: source.blockReason});
    const {lines: components, ...plan} = source.plan;
    const createdAt = new Date();
    await this.database.db.insert(plans).values({...plan, createdAt, lineCount: components.length});
    await this.database.db.insert(lines).values(components.map(row => ({id: randomUUID(), paymentId, kind: row.recipient.kind,
      brandId: row.recipient.kind === C.kind.brand ? row.recipient.beneficiaryId : null,
      creatorId: row.recipient.kind === C.kind.creator ? row.recipient.beneficiaryId : null,
      commissionId: row.recipient.kind === C.kind.creator ? row.recipient.commissionId : null,
      presentmentAmount: row.presentmentAmount, grossAmount: row.grossAmount, feeAmount: row.feeAmount, netAmount: row.netAmount})));
    return projection(allocationStoredPlanSchema, {...source.plan, createdAt: createdAt.toISOString()});
  }
  async storedPlan(paymentId: string): Promise<StoredAllocationPlan | undefined> {
    const [plan] = await this.database.db.select().from(plans).where(eq(plans.paymentId, paymentId));
    if (!plan) return undefined;
    const components = await this.database.db.select().from(lines).where(eq(lines.paymentId, paymentId));
    if (components.length !== plan.lineCount) throw new ConflictException(C.failure.persisted);
    const {lineCount, ...source} = plan;
    const document = projection(allocationStoredPlanSchema, {...source, createdAt: plan.createdAt.toISOString(),
      lines: components.map(row => ({recipient: row.kind === C.kind.creator ? {kind: row.kind, beneficiaryId: row.creatorId, commissionId: row.commissionId} : {kind: row.kind, beneficiaryId: row.kind === C.kind.brand ? row.brandId : null},
        presentmentAmount: row.presentmentAmount, grossAmount: row.grossAmount, feeAmount: row.feeAmount, netAmount: row.netAmount}))});
    document.lines.sort((left, right) => {
      const a = allocationRecipientKey(left.recipient), b = allocationRecipientKey(right.recipient);
      return a < b ? -C.limit.one : a > b ? C.limit.one : C.limit.zero;
    });
    return document;
  }
}
function projection<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new ConflictException(C.failure.persisted);
  return result.data;
}

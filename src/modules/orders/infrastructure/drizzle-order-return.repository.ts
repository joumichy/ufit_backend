import {DrizzleOrderNotifications} from './drizzle-order-notifications';
import {returnNotification} from '../domain/return-notification';
import {BadRequestException, ConflictException, Inject, Injectable} from '@nestjs/common';
import {and, asc, desc, eq, inArray, lte, lt, notInArray, or, sql, type SQL} from 'drizzle-orm';
import {z} from 'zod';
import {alias} from 'drizzle-orm/pg-core';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT, type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {orders, orderItems, shipments, productVariants} from '../../../shared/infrastructure/database/schema';
import {orderReturns, orderReturnItems, orderReturnRefunds} from '../../../shared/infrastructure/database/schema.returns';
import {DrizzleBrandsRepository} from '../../brands/drizzle-brands.repository';
import {findIdentityAccess, IdentityAccessMode} from '../../identity/infrastructure/persistence/identity-access';
import {ORDER_RETURN, RETURN_STATUS, type ReturnStatus} from '../domain/order-return.contract';
import type {OrderReturnRepository, OrderReturnQuery, ReturnScope, ReturnOrderContext} from '../domain/order-return.repository';
import {RETURN_ACTOR, type OrderReturn} from '../domain/order-return';
import type {OrderStatus} from '../domain/order-lifecycle';
import {RETURN_REFUND_ATTEMPT} from '../domain/return-refund';
import {projectFrozenOrderItem} from './frozen-order-item';
import {latestReturnRefund, projectReturnRecord} from './return-records';

const frozenTerms = z.object({returnWindowDays: z.number().int().nonnegative(), returnPolicy: z.string().trim().min(ORDER_RETURN.limit.minimumText), refundPolicyCode: z.literal(ORDER_RETURN.policy.code)});
const RETURN_RECORD_ALIAS = 'return_record';

@Injectable()
export class DrizzleOrderReturnRepository implements OrderReturnRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  transaction<T>(operation: (repository: OrderReturnRepository) => Promise<T>): Promise<T> {
    return this.database.db.transaction(tx => operation(new DrizzleOrderReturnRepository({db: tx})));
  }
  snapshot<T>(operation: (repository: OrderReturnRepository) => Promise<T>): Promise<T> {
    return this.database.db.transaction(tx => operation(new DrizzleOrderReturnRepository({db: tx})), READ_SNAPSHOT);
  }
  actorAccess(actorId: string, lock: boolean) { return findIdentityAccess(this.database, actorId, lock ? IdentityAccessMode.Lock : IdentityAccessMode.Read); }
  brandAccess(brandId: string, actorId: string, lock: boolean) {
    const brands = new DrizzleBrandsRepository(this.database);
    return lock ? brands.lockManagementAccess(brandId, actorId) : brands.findManagementAccess(brandId, actorId);
  }
  async order(orderId: string, lock: boolean): Promise<ReturnOrderContext | undefined> {
    const query = this.database.db.select().from(orders).where(eq(orders.id, orderId)).limit(ORDER_RETURN.persistence.singleRow);
    const [row] = lock ? await query.for(ORDER_RETURN.persistence.lock) : await query;
    if (!row) return undefined;
    const [items, [shipment]] = await Promise.all([
      this.database.db.select().from(orderItems).where(eq(orderItems.orderId, row.id)).orderBy(asc(orderItems.id)),
      this.database.db.select({deliveredAt: shipments.deliveredAt}).from(shipments).where(eq(shipments.orderId, row.id)).limit(ORDER_RETURN.persistence.singleRow),
    ]);
    const terms = frozenTerms.safeParse(row.commerceSnapshot);
    return {id: row.id, customerId: row.customerId, brandId: row.brandId, orderNumber: row.orderNumber, currency: row.currency,
      status: row.status as OrderStatus, items: items.map(item => projectFrozenOrderItem(item, ORDER_RETURN.failure.persisted)),
      paymentProvider: row.paymentProvider, paymentIntentId: row.stripePaymentIntentId,
      amounts: {subtotalAmount: row.subtotalAmount, shippingAmount: row.shippingAmount, taxAmount: row.taxAmount, totalAmount: row.totalAmount},
      deliveredAt: shipment?.deliveredAt ?? null, terms: terms.success ? terms.data : null};
  }
  async reference(id: string) {
    const [row] = await this.database.db.select({orderId: orderReturns.orderId}).from(orderReturns).where(eq(orderReturns.id, id)).limit(ORDER_RETURN.persistence.singleRow);
    return row;
  }
  async find(id: string, lock: boolean) {
    const record = alias(orderReturns, RETURN_RECORD_ALIAS);
    const query = this.database.db.select({record, brandId: orders.brandId}).from(record)
      .innerJoin(orders, eq(orders.id, record.orderId)).where(eq(record.id, id)).limit(ORDER_RETURN.persistence.singleRow);
    const [row] = lock ? await query.for(ORDER_RETURN.persistence.lock, {of: record}) : await query;
    if (!row) return undefined;
    const [items, refund] = await Promise.all([
      this.database.db.select().from(orderReturnItems).where(eq(orderReturnItems.returnId, id)).orderBy(asc(orderReturnItems.orderItemId)),
      latestReturnRefund(this.database, id),
    ]);
    return projectReturnRecord(row.record, row.brandId, items, refund);
  }
  async findRequest(orderId: string, requestId: string) {
    const [row] = await this.database.db.select({id: orderReturns.id}).from(orderReturns)
      .where(and(eq(orderReturns.orderId, orderId), eq(orderReturns.requestId, requestId))).limit(ORDER_RETURN.persistence.singleRow);
    return row ? this.find(row.id, false) : undefined;
  }
  async findOpen(orderId: string) {
    const [row] = await this.database.db.select({id: orderReturns.id}).from(orderReturns)
      .where(and(eq(orderReturns.orderId, orderId), notInArray(orderReturns.status, [...ORDER_RETURN.terminalStatuses]))).limit(ORDER_RETURN.persistence.singleRow);
    return row?.id ?? null;
  }
  async returnedQuantities(orderId: string) {
    const rows = await this.database.db.select({orderItemId: orderReturnItems.orderItemId, quantity: sql<number>`sum(${orderReturnItems.quantity})::integer`})
      .from(orderReturnItems).innerJoin(orderReturns, eq(orderReturns.id, orderReturnItems.returnId))
      .where(and(eq(orderReturns.orderId, orderId), eq(orderReturns.status, RETURN_STATUS.refunded))).groupBy(orderReturnItems.orderItemId);
    return rows;
  }
  async list(scope: ReturnScope, actorId: string, query: OrderReturnQuery) {
    const scoped = scopeCondition(scope, actorId);
    let anchor: {id: string; createdAt: Date} | undefined;
    if (query.cursor) {
      [anchor] = await this.database.db.select({id: orderReturns.id, createdAt: orderReturns.createdAt}).from(orderReturns)
        .innerJoin(orders, eq(orders.id, orderReturns.orderId)).where(and(scoped, eq(orderReturns.id, query.cursor))).limit(ORDER_RETURN.persistence.singleRow);
      if (!anchor) throw new BadRequestException(ORDER_RETURN.failure.cursor);
    }
    const rows = await this.database.db.select({record: orderReturns, orderNumber: orders.orderNumber, brandId: orders.brandId, currency: orders.currency})
      .from(orderReturns).innerJoin(orders, eq(orders.id, orderReturns.orderId))
      .where(and(scoped, query.status ? eq(orderReturns.status, query.status) : undefined,
        anchor ? or(lt(orderReturns.createdAt, anchor.createdAt), and(eq(orderReturns.createdAt, anchor.createdAt), lt(orderReturns.id, anchor.id))) : undefined))
      .orderBy(desc(orderReturns.createdAt), desc(orderReturns.id)).limit(query.limit + ORDER_RETURN.persistence.overflow);
    const selected = rows.slice(ORDER_RETURN.limit.firstRow, query.limit);
    const quantities = selected.length ? await this.database.db.select({returnId: orderReturnItems.returnId, quantity: sql<number>`sum(${orderReturnItems.quantity})::integer`})
      .from(orderReturnItems).where(inArray(orderReturnItems.returnId, selected.map(row => row.record.id))).groupBy(orderReturnItems.returnId) : [];
    const counts = new Map(quantities.map(row => [row.returnId, row.quantity]));
    return {items: selected.map(({record, orderNumber, brandId, currency}) => {
      const itemCount = counts.get(record.id);
      if (itemCount === undefined) throw new ConflictException(ORDER_RETURN.failure.persisted);
      return {id: record.id, orderId: record.orderId, brandId, orderNumber, version: record.version, status: record.status as ReturnStatus,
        requestedAt: record.createdAt.toISOString(), itemCount, totalAmount: record.totalAmount, currency};
    }), nextCursor: rows.length > query.limit ? selected.at(ORDER_RETURN.persistence.lastRow)!.record.id : null};
  }
  async insert(document: OrderReturn, requestId: string, fingerprint: string, returnPolicy: string): Promise<void> {
    await this.database.db.insert(orderReturns).values({id: document.id, orderId: document.orderId, requestId, requestFingerprint: fingerprint,
      reason: document.reason, returnPolicy, deadline: new Date(document.deadline), status: document.status, version: document.version,
      refundPolicyCode: document.amounts.refundPolicyCode, merchandiseAmount: document.amounts.merchandiseAmount, taxAmount: document.amounts.taxAmount,
      shippingAmount: document.amounts.shippingAmount, totalAmount: document.amounts.totalAmount, completesOrder: document.amounts.completesOrder,
      createdAt: new Date(document.requestedAt), updatedAt: new Date(document.updatedAt)});
    await this.database.db.insert(orderReturnItems).values(document.items.map(item => ({returnId: document.id, orderId: document.orderId, ...item})));
    await new DrizzleOrderNotifications(this.database).record(returnNotification(document.orderId, document.id, document.version, document.status), true);
  }
  async save(document: OrderReturn, expectedVersion: number): Promise<void> {
    const [row] = await this.database.db.update(orderReturns).set({status: document.status, version: document.version, updatedAt: new Date(document.updatedAt),
      brandDecision: document.brandDecision?.decision ?? null, brandReason: document.brandDecision?.reason ?? null, brandInstructions: document.brandDecision?.instructions ?? null,
      brandDecidedAt: document.brandDecision ? new Date(document.brandDecision.at) : null,
      disputeReason: document.dispute?.reason ?? null, disputedAt: document.dispute ? new Date(document.dispute.at) : null,
      adminDecision: document.adminDecision?.decision ?? null, adminReason: document.adminDecision?.reason ?? null, adminInstructions: document.adminDecision?.instructions ?? null,
      adminDecidedAt: document.adminDecision ? new Date(document.adminDecision.at) : null,
      carrier: document.tracking?.carrier ?? null, trackingNumber: document.tracking?.trackingNumber ?? null, trackingUrl: document.tracking?.trackingUrl ?? null,
      sentAt: document.tracking ? new Date(document.tracking.sentAt) : null, receivedAt: document.reception ? new Date(document.reception.at) : null,
    }).where(and(eq(orderReturns.id, document.id), eq(orderReturns.version, expectedVersion))).returning({id: orderReturns.id});
    if (!row) throw new ConflictException(ORDER_RETURN.failure.changed);
    if (document.reception) for (const item of document.reception.items) {
      const [saved] = await this.database.db.update(orderReturnItems).set({restockQuantity: item.restockQuantity})
        .where(and(eq(orderReturnItems.returnId, document.id), eq(orderReturnItems.orderItemId, item.orderItemId))).returning({id: orderReturnItems.id});
      if (!saved) throw new ConflictException(ORDER_RETURN.failure.persisted);
    }
    await new DrizzleOrderNotifications(this.database).record(returnNotification(document.orderId, document.id, document.version, document.status), true);
  }
  async restock(document: OrderReturn, order: ReturnOrderContext): Promise<void> {
    if (!document.reception) throw new ConflictException(ORDER_RETURN.failure.persisted);
    const original = new Map(order.items.map(item => [item.id, item]));
    const quantities = new Map<string, number>();
    for (const item of document.reception.items) {
      const source = original.get(item.orderItemId);
      if (!source) throw new ConflictException(ORDER_RETURN.failure.persisted);
      quantities.set(source.productVariantId, (quantities.get(source.productVariantId) ?? ORDER_RETURN.amount.zero) + item.restockQuantity);
    }
    for (const [variantId, quantity] of [...quantities].sort(([a], [b]) => a.localeCompare(b))) {
      if (quantity === ORDER_RETURN.amount.zero) continue;
      const [saved] = await this.database.db.update(productVariants)
        .set({stockQuantity: sql`${productVariants.stockQuantity} + ${quantity}`, updatedAt: new Date(document.updatedAt)})
        .where(and(eq(productVariants.id, variantId), lte(productVariants.stockQuantity, ORDER_RETURN.amount.maximum - quantity))).returning({id: productVariants.id});
      if (!saved) throw new ConflictException(ORDER_RETURN.failure.persisted);
    }
  }
  async queueRefund(document: OrderReturn, retry: boolean): Promise<void> {
    const previous = await latestReturnRefund(this.database, document.id);
    if ((!retry && previous) || (retry && previous?.state !== RETURN_REFUND_ATTEMPT.failed) || !document.reception || document.status !== RETURN_STATUS.refundPending) throw new ConflictException(ORDER_RETURN.failure.state);
    await this.database.db.insert(orderReturnRefunds).values({returnId: document.id, attemptNumber: previous ? previous.attemptNumber + ORDER_RETURN.revision.step : ORDER_RETURN.revision.initial,
      amount: document.amounts.totalAmount, state: RETURN_REFUND_ATTEMPT.queued, nextRecoveryAt: new Date(document.updatedAt)});
  }
}
function scopeCondition(scope: ReturnScope, actorId: string): SQL | undefined {
  switch (scope.kind) {
    case RETURN_ACTOR.customer: return and(eq(orders.customerId, actorId), eq(orders.id, scope.orderId));
    case RETURN_ACTOR.brand: return eq(orders.brandId, scope.brandId);
    case RETURN_ACTOR.administrator: return undefined;
  }
}

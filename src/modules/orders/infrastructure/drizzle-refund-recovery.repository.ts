import {ConflictException, Inject, Injectable} from '@nestjs/common';
import {and, asc, count, desc, eq, gt, inArray, or, sql} from 'drizzle-orm';
import {unionAll} from 'drizzle-orm/pg-core';
import {z} from 'zod';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import {READ_SNAPSHOT, type DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {orderCancellations, orderCancellationRefunds, orderReturns, orderReturnRefunds, orders, brandProfiles} from '../../../shared/infrastructure/database/schema';
import {CANCELLATION, CANCELLATION_REFUND} from '../domain/order-lifecycle';
import {RETURN_STATUS} from '../domain/order-return.contract';
import {RETURN_REFUND} from '../domain/return-refund';
import {REFUND_RECOVERY, refundRecoveryCursor, refundRecoveryKindSchema, type RefundRecoveryDetail, type RefundRecoveryKind, type RefundRecoveryPage, type RefundRecoveryQuery, type RefundRecoveryRepository} from '../domain/refund-recovery.contract';

const recordSchema = z.object({kind: refundRecoveryKindSchema, id: z.uuid(), orderId: z.uuid(), brandId: z.uuid(), brandName: z.string().trim().nonempty(), orderNumber: z.string().trim().nonempty(),
  amount: z.number().int().positive().max(REFUND_RECOVERY.amount.maximum), attemptAmount: z.number().int().positive().max(REFUND_RECOVERY.amount.maximum), currency: z.string().regex(/^[A-Z]{3}$/), attemptCurrency: z.string().regex(/^[A-Z]{3}$/),
  failedAt: z.date(), attemptId: z.uuid(), attemptNumber: z.number().int().positive(),
  state: z.enum([CANCELLATION_REFUND.state.failed, CANCELLATION_REFUND.state.blocked]), providerStatus: z.enum(Object.values(CANCELLATION_REFUND.providerStatus)).nullable(), refundId: z.string().nonempty().nullable(),
});
@Injectable()
export class DrizzleRefundRecoveryRepository implements RefundRecoveryRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  private rows(database: DatabaseSession['db']) {
    const returned = database.selectDistinctOn([orderReturnRefunds.returnId]).from(orderReturnRefunds)
      .orderBy(orderReturnRefunds.returnId, desc(orderReturnRefunds.attemptNumber)).as(REFUND_RECOVERY.query.returnLatest);
    const cancelled = database.selectDistinctOn([orderCancellationRefunds.cancellationId]).from(orderCancellationRefunds)
      .orderBy(orderCancellationRefunds.cancellationId, desc(orderCancellationRefunds.attemptNumber)).as(REFUND_RECOVERY.query.cancellationLatest);
    const returns = database.select({kind: sql<RefundRecoveryKind>`${REFUND_RECOVERY.kind.orderReturn}`.as(REFUND_RECOVERY.column.kind), id: sql<string>`${orderReturns.id}`.as(REFUND_RECOVERY.column.id),
      orderId: sql<string>`${orders.id}`.as(REFUND_RECOVERY.column.orderId), brandId: sql<string>`${orders.brandId}`.as(REFUND_RECOVERY.column.brandId), brandName: sql<string>`${brandProfiles.brandName}`.as(REFUND_RECOVERY.column.brandName), orderNumber: sql<string>`${orders.orderNumber}`.as(REFUND_RECOVERY.column.orderNumber), amount: sql<number>`${orderReturns.totalAmount}`.as(REFUND_RECOVERY.column.amount), attemptAmount: sql<number>`${returned.amount}`.as(REFUND_RECOVERY.column.attemptAmount), currency: sql<string>`${orders.currency}`.as(REFUND_RECOVERY.column.currency), attemptCurrency: sql<string>`${orders.currency}`.as(REFUND_RECOVERY.column.attemptCurrency),
      failedAt: sql<Date>`${returned.updatedAt}`.mapWith(returned.updatedAt).as(REFUND_RECOVERY.column.failedAt), attemptId: sql<string>`${returned.id}`.as(REFUND_RECOVERY.column.attemptId), attemptNumber: sql<number>`${returned.attemptNumber}`.as(REFUND_RECOVERY.column.attemptNumber), state: sql<string>`${returned.state}`.as(REFUND_RECOVERY.column.state), providerStatus: sql<string | null>`${returned.providerStatus}`.as(REFUND_RECOVERY.column.providerStatus), refundId: sql<string | null>`${returned.stripeRefundId}`.as(REFUND_RECOVERY.column.refundId)})
      .from(orderReturns).innerJoin(orders, eq(orders.id, orderReturns.orderId)).innerJoin(brandProfiles, eq(brandProfiles.id, orders.brandId)).innerJoin(returned, eq(returned.returnId, orderReturns.id))
      .where(and(eq(orderReturns.status, RETURN_STATUS.refundFailed), inArray(returned.state, [RETURN_REFUND.state.failed, RETURN_REFUND.state.blocked]),
        or(eq(returned.state, RETURN_REFUND.state.blocked), eq(returned.providerStatus, RETURN_REFUND.providerStatus.failed))));
    const cancellations = database.select({kind: sql<RefundRecoveryKind>`${REFUND_RECOVERY.kind.cancellation}`.as(REFUND_RECOVERY.column.kind), id: sql<string>`${orderCancellations.id}`.as(REFUND_RECOVERY.column.id),
      orderId: sql<string>`${orders.id}`.as(REFUND_RECOVERY.column.orderId), brandId: sql<string>`${orders.brandId}`.as(REFUND_RECOVERY.column.brandId), brandName: sql<string>`${brandProfiles.brandName}`.as(REFUND_RECOVERY.column.brandName), orderNumber: sql<string>`${orders.orderNumber}`.as(REFUND_RECOVERY.column.orderNumber), amount: sql<number>`${orders.totalAmount}`.as(REFUND_RECOVERY.column.amount), attemptAmount: sql<number>`${cancelled.amount}`.as(REFUND_RECOVERY.column.attemptAmount), currency: sql<string>`${orders.currency}`.as(REFUND_RECOVERY.column.currency), attemptCurrency: sql<string>`${cancelled.currency}`.as(REFUND_RECOVERY.column.attemptCurrency),
      failedAt: sql<Date>`${cancelled.updatedAt}`.mapWith(cancelled.updatedAt).as(REFUND_RECOVERY.column.failedAt), attemptId: sql<string>`${cancelled.id}`.as(REFUND_RECOVERY.column.attemptId), attemptNumber: sql<number>`${cancelled.attemptNumber}`.as(REFUND_RECOVERY.column.attemptNumber), state: sql<string>`${cancelled.state}`.as(REFUND_RECOVERY.column.state), providerStatus: sql<string | null>`${cancelled.providerStatus}`.as(REFUND_RECOVERY.column.providerStatus), refundId: sql<string | null>`${cancelled.stripeRefundId}`.as(REFUND_RECOVERY.column.refundId)})
      .from(orderCancellations).innerJoin(orders, eq(orders.id, orderCancellations.orderId)).innerJoin(brandProfiles, eq(brandProfiles.id, orders.brandId)).innerJoin(cancelled, eq(cancelled.cancellationId, orderCancellations.id))
      .where(and(inArray(orderCancellations.status, [CANCELLATION.status.requested, CANCELLATION.status.failed]),
        inArray(cancelled.state, [CANCELLATION_REFUND.state.failed, CANCELLATION_REFUND.state.blocked]),
        or(eq(cancelled.state, CANCELLATION_REFUND.state.blocked), eq(cancelled.providerStatus, CANCELLATION_REFUND.providerStatus.failed))));
    return unionAll(returns, cancellations).as(REFUND_RECOVERY.query.rows);
  }
  async list(query: RefundRecoveryQuery): Promise<RefundRecoveryPage> {
    return this.database.db.transaction(async tx => {
      const rows = this.rows(tx), filter = and(query.kind === undefined ? undefined : eq(rows.kind, query.kind),
        query.search === undefined ? undefined : gt(sql<number>`strpos(lower(${rows.orderNumber}), lower(${query.search}))`, REFUND_RECOVERY.search.noMatch));
      if (query.cursor) {
        const [anchor] = await tx.select().from(rows).where(and(filter, eq(rows.kind, query.cursor.kind), eq(rows.id, query.cursor.id))).limit(REFUND_RECOVERY.page.minimumLimit);
        if (!anchor) throw new ConflictException(REFUND_RECOVERY.failure.cursor);
        projectRecovery(anchor);
      }
      const cursor = query.cursor;
      // Keep PostgreSQL timestamp precision for keyset ordering; the displayed
      // ISO date is not a cursor identity and must not truncate the seek key.
      const anchorTime = cursor ? sql`(select ${rows.failedAt} from ${rows} where ${rows.kind} = ${cursor.kind} and ${rows.id} = ${cursor.id})` : undefined;
      const selected = await tx.select().from(rows).where(and(filter, cursor ? or(gt(rows.failedAt, anchorTime!),
        and(eq(rows.failedAt, anchorTime!), gt(rows.kind, cursor.kind)),
        and(eq(rows.failedAt, anchorTime!), eq(rows.kind, cursor.kind), gt(rows.id, cursor.id))) : undefined))
        .orderBy(asc(rows.failedAt), asc(rows.kind), asc(rows.id)).limit(query.limit + REFUND_RECOVERY.page.overflow);
      const [total] = await tx.select({value: count()}).from(rows).where(filter);
      const items = selected.slice(REFUND_RECOVERY.page.first, query.limit).map(projectRecovery).map(detail => detail.summary);
      return {items, totalCount: total.value, nextCursor: selected.length > query.limit ? refundRecoveryCursor(items.at(REFUND_RECOVERY.page.last)!) : null};
    }, READ_SNAPSHOT);
  }
  async detail(kind: RefundRecoveryKind, id: string): Promise<RefundRecoveryDetail | undefined> {
    const rows = this.rows(this.database.db);
    const [row] = await this.database.db.select().from(rows).where(and(eq(rows.kind, kind), eq(rows.id, id))).limit(REFUND_RECOVERY.page.minimumLimit);
    return row ? projectRecovery(row) : undefined;
  }
}
function projectRecovery(raw: unknown): RefundRecoveryDetail {
  const parsed = recordSchema.safeParse(raw);
  if (!parsed.success) throw new ConflictException(REFUND_RECOVERY.failure.persisted);
  const row = parsed.data, blocked = row.state === CANCELLATION_REFUND.state.blocked;
  if (row.amount !== row.attemptAmount || row.currency !== row.attemptCurrency || (blocked ? row.refundId !== null || row.providerStatus !== null : row.refundId === null || row.providerStatus !== CANCELLATION_REFUND.providerStatus.failed)) throw new ConflictException(REFUND_RECOVERY.failure.persisted);
  return {summary: {kind: row.kind, id: row.id, orderId: row.orderId, brandId: row.brandId, brandName: row.brandName, orderNumber: row.orderNumber, amount: row.amount, currency: row.currency,
    failedAt: row.failedAt.toISOString(), cause: blocked ? REFUND_RECOVERY.cause.blocked : REFUND_RECOVERY.cause.failed},
    attempt: {id: row.attemptId, number: row.attemptNumber, state: row.state, providerStatus: row.providerStatus, refundId: row.refundId}};
}

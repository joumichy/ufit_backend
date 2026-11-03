import {ConflictException} from '@nestjs/common';
import {and,asc,eq,inArray,sql} from 'drizzle-orm';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {commissions,payments,orders,orderStatusHistory} from '../../../shared/infrastructure/database/schema';
import {orderReturnItems,orderReturns,returnCommissionAdjustments} from '../../../shared/infrastructure/database/schema.returns';
import {returnRefundFinancialFacts} from '../../../shared/infrastructure/database/schema.refund-settlements';
import {ORDER_RETURN,RETURN_STATUS} from '../domain/order-return.contract';
import {ORDER_COMMISSION,ORDER_PAYMENT,ORDER_STATUS} from '../domain/order-lifecycle';
import {RETURN_REFUND} from '../domain/return-refund';
import {returnedCommissionAmount} from '../domain/return-refund-policy';
import type {ReturnOrderContext} from '../domain/order-return.repository';
import type {OrderReturn} from '../domain/order-return';
import {DrizzleOrderReturnRepository} from './drizzle-order-return.repository';

export class ReturnRefundFinancials {
  constructor(private readonly database:DatabaseSession) {}
  async adjustCommissions( order: ReturnOrderContext, document: OrderReturn, previous: Map<string, number>, now: Date): Promise<void> {
    const originals = new Map(order.items.map(item => [item.id, item]));
    const selected = new Map(document.items.map(item => [item.orderItemId, item.quantity]));
    const lines = await this.database.db.select().from(orderReturnItems).where(eq(orderReturnItems.returnId, document.id));
    const returnLines = new Map(lines.map(item => [item.orderItemId, item.id]));
    const rows = await this.database.db.select().from(commissions).where(inArray(commissions.orderItemId, [...selected.keys()])).orderBy(asc(commissions.id)).for(ORDER_RETURN.persistence.lock);
    if (!rows.length) return;
    const adjustments = await this.database.db.select().from(returnCommissionAdjustments).where(inArray(returnCommissionAdjustments.commissionId, rows.map(row => row.id)));
    for (const row of rows) {
      const source = originals.get(row.orderItemId), quantity = selected.get(row.orderItemId), returnItemId = returnLines.get(row.orderItemId);
      if (!source || quantity === undefined || !returnItemId || row.brandId !== order.brandId) throw new ConflictException(ORDER_RETURN.failure.persisted);
      const returned = previous.get(row.orderItemId) ?? ORDER_RETURN.amount.zero;
      const before = returnedCommissionAmount(row.commissionAmount, source.quantity, returned), after = returnedCommissionAmount(row.commissionAmount, source.quantity, returned + quantity);
      const existing = adjustments.find(adjustment => adjustment.commissionId === row.id && adjustment.returnItemId === returnItemId);
      const recorded = adjustments.filter(adjustment => adjustment.commissionId === row.id).reduce((sum, adjustment) => sum + adjustment.amount, ORDER_RETURN.amount.zero as number);
      if ((existing && existing.amount !== after - before) || recorded + (existing ? ORDER_RETURN.amount.zero : after - before) > row.commissionAmount) throw new ConflictException(ORDER_RETURN.failure.persisted);
      if (!existing) await this.database.db.insert(returnCommissionAdjustments).values({returnItemId, commissionId: row.id, amount: after - before, createdAt: now});
      if (returned + quantity === source.quantity && row.status !== ORDER_COMMISSION.status.paid) await this.database.db.update(commissions)
        .set({status: ORDER_COMMISSION.status.cancelled, updatedAt: now}).where(eq(commissions.id, row.id));
    }
  }
  async reconcile(order:ReturnOrderContext,now:Date):Promise<void> {
    const [totals]=await this.database.db.select({amount:sql<number>`coalesce(sum(${returnRefundFinancialFacts.amount}),${ORDER_RETURN.amount.zero})::bigint`,
      stripeAmount:sql<number>`coalesce(sum(${returnRefundFinancialFacts.stripeAmount}),${ORDER_RETURN.amount.zero})::bigint`,
      invalid:sql<number>`count(*) filter(where ${returnRefundFinancialFacts.invalid})::integer`})
      .from(returnRefundFinancialFacts).where(eq(returnRefundFinancialFacts.orderId,order.id));
    const amount=Number(totals.amount),stripeAmount=Number(totals.stripeAmount);
    if(totals.invalid!==ORDER_RETURN.amount.zero || !Number.isSafeInteger(amount) || amount<ORDER_RETURN.amount.zero || amount>order.amounts.totalAmount
      || !Number.isSafeInteger(stripeAmount) || stripeAmount<ORDER_RETURN.amount.zero || stripeAmount>amount)throw new ConflictException(ORDER_RETURN.failure.persisted);
    const returned=new Map((await new DrizzleOrderReturnRepository(this.database).returnedQuantities(order.id)).map(item=>[item.orderItemId,item.quantity]));
    const [unsettled]=await this.database.db.select({count:sql<number>`count(*)::integer`}).from(orderReturns)
      .where(and(eq(orderReturns.orderId,order.id),sql`${orderReturns.allocationNumber} is not null`,sql`${orderReturns.status} <> ${RETURN_STATUS.refunded}`));
    const complete=amount===order.amounts.totalAmount && unsettled.count===ORDER_RETURN.amount.zero && order.items.every(item=>returned.get(item.id)===item.quantity);
    const [payment]=await this.database.db.select().from(payments)
      .where(and(eq(payments.orderId,order.id),eq(payments.provider,ORDER_PAYMENT.provider),eq(payments.providerPaymentIntentId,order.paymentIntentId!)))
      .limit(ORDER_RETURN.persistence.singleRow).for(ORDER_RETURN.persistence.lock);
    if(!payment || payment.amount!==order.amounts.totalAmount || payment.currency!==order.currency || ![ORDER_PAYMENT.status.succeeded,ORDER_PAYMENT.status.refunded].some(status=>payment.status===status))throw new ConflictException(RETURN_REFUND.failure.unavailable);
    // This is the Stripe payment row: external repayments affect business totals, never Stripe's refund status.
    const paymentStatus=stripeAmount===order.amounts.totalAmount?ORDER_PAYMENT.status.refunded:ORDER_PAYMENT.status.succeeded;
    if(payment.status!==paymentStatus)await this.database.db.update(payments).set({status:paymentStatus,updatedAt:now}).where(eq(payments.id,payment.id));
    const status=complete?ORDER_STATUS.refunded:ORDER_STATUS.delivered;
    if(order.status!==status){
      await this.database.db.update(orders).set({status,updatedAt:now}).where(eq(orders.id,order.id));
      await this.database.db.insert(orderStatusHistory).values({orderId:order.id,fromStatus:order.status,toStatus:status,reason:complete?RETURN_REFUND.historyReason:RETURN_REFUND.failureHistoryReason,createdAt:now});
    }
  }
}

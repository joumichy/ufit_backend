import {ConflictException} from '@nestjs/common';
import {and,eq} from 'drizzle-orm';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {orderCancellations,payments} from '../../../shared/infrastructure/database/schema';
import {orderReturns} from '../../../shared/infrastructure/database/schema.returns';
import {ORDER_RETURN,RETURN_STATUS} from '../domain/order-return.contract';
import {CANCELLATION,ORDER_PAYMENT,ORDER_STATUS} from '../domain/order-lifecycle';
import {REFUND_RECOVERY as Recovery} from '../domain/refund-recovery.contract';
import {REFUND_PROOF_REVIEW as R} from '../domain/refund-proof-review';
import {allocateReturnRefund,assertSameRefundAmounts,type ReturnQuantity} from '../domain/return-refund-policy';
import type {ReturnOrderContext,StoredOrderReturn} from '../domain/order-return.repository';
import type {RefundOrganizationContext} from './refund-organization-context';
import {DrizzleOrderReturnRepository} from './drizzle-order-return.repository';
import {ReturnRefundFinancials} from './return-refund-financials';
import {DrizzleOrderNotifications} from './drizzle-order-notifications';
import {returnNotification} from '../domain/return-notification';

type ExternalRefundEffect = {kind:typeof Recovery.kind.orderReturn;order:ReturnOrderContext;stored:StoredOrderReturn;previous:ReturnQuantity[]}
  | {kind:typeof Recovery.kind.cancellation;id:string};
export async function prepareExternalRefundEffect(database:DatabaseSession,context:RefundOrganizationContext):Promise<ExternalRefundEffect> {
  const {summary,order}=context;
  if(context.settlement || order.paymentProvider!==ORDER_PAYMENT.provider || !order.stripePaymentIntentId)throw new ConflictException(R.failure.state);
  if(summary.kind===Recovery.kind.cancellation){
    const [cancellation]=await database.db.select().from(orderCancellations).where(and(eq(orderCancellations.id,summary.id),eq(orderCancellations.orderId,order.id))).limit(ORDER_RETURN.persistence.singleRow);
    const [payment]=await database.db.select().from(payments).where(and(eq(payments.orderId,order.id),eq(payments.provider,ORDER_PAYMENT.provider),eq(payments.providerPaymentIntentId,order.stripePaymentIntentId))).limit(ORDER_RETURN.persistence.singleRow);
    if(!cancellation?.effectsApplied || cancellation.status!==CANCELLATION.status.failed || order.status!==ORDER_STATUS.cancelled
      || !payment || payment.status!==ORDER_PAYMENT.status.succeeded || payment.amount!==summary.amount || payment.currency!==summary.currency)throw new ConflictException(R.failure.state);
    return {kind:Recovery.kind.cancellation,id:cancellation.id};
  }
  const returns=new DrizzleOrderReturnRepository(database),source=await returns.order(order.id,true),stored=await returns.find(summary.id,true);
  if(!source || !stored || stored.document.status!==RETURN_STATUS.refundFailed || !stored.document.reception || stored.allocationNumber===null
    || ![ORDER_STATUS.delivered,ORDER_STATUS.refunded].some(status=>source.status===status) || stored.document.orderId!==order.id || source.currency!==summary.currency)throw new ConflictException(R.failure.state);
  const previous=await returns.returnedQuantities(order.id,stored.allocationNumber);
  const expected=allocateReturnRefund(source.amounts,source.items,previous,stored.document.items);
  assertSameRefundAmounts(expected,stored.document.amounts);
  if(expected.totalAmount!==summary.amount)throw new ConflictException(R.failure.persisted);
  return {kind:Recovery.kind.orderReturn,order:source,stored,previous};
}
export async function applyExternalRefundEffect(database:DatabaseSession,plan:ExternalRefundEffect,now:Date):Promise<void> {
  if(plan.kind===Recovery.kind.cancellation){
    await database.db.update(orderCancellations).set({status:CANCELLATION.status.succeeded,paymentOutcome:CANCELLATION.outcome.refundedExternally,updatedAt:now}).where(eq(orderCancellations.id,plan.id));
    return;
  }
  const financials=new ReturnRefundFinancials(database),document=plan.stored.document;
  await financials.adjustCommissions(plan.order,document,new Map(plan.previous.map(item=>[item.orderItemId,item.quantity])),now);
  const version=Math.min(document.version+ORDER_RETURN.revision.step,ORDER_RETURN.revision.maximum);
  await database.db.update(orderReturns).set({status:RETURN_STATUS.refunded,version,refundedAt:now,updatedAt:now}).where(eq(orderReturns.id,document.id));
  await financials.reconcile(plan.order,now);
  await new DrizzleOrderNotifications(database).record(returnNotification(plan.order.id,document.id,version,RETURN_STATUS.refunded),true);
}

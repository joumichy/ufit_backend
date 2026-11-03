import {returnRefundFinancialFacts,externalRefundSettlements} from '../../../shared/infrastructure/database/schema.refund-settlements';
import {refundOrganizationCases} from '../../../shared/infrastructure/database/schema.refund-organizations';
import {sql} from 'drizzle-orm';
import {orderCancellations, orderItems, orders, payments, orderReturns, orderReturnItems} from '../../../shared/infrastructure/database/schema';
import {CANCELLATION, ORDER_PAYMENT} from '../../orders/domain/order-lifecycle';
import {RETURN_STATUS} from '../../orders/domain/order-return.contract';
import {paymentSettlements} from '../../../shared/infrastructure/database/schema.payment-settlements';
import {WORKSPACE_FINANCE as FINANCE, type WorkspaceFinanceScope} from '../domain/workspace-finance';

const cancelledRefundOutcomes=[CANCELLATION.outcome.refunded,CANCELLATION.outcome.refundedExternally];
const needsRefund = [RETURN_STATUS.refundPending, RETURN_STATUS.refundFailed];


/** Captured order cohorts; refunds describe their current state, not refund-event history. */
export function workspaceSalesFacts(scope: WorkspaceFinanceScope) {
    const creator = scope.kind === FINANCE.scope.creator;
    const owner = creator ? sql`exists (select ${FINANCE.single} from ${orderItems} oi where oi.order_id = o.id and oi.source_creator_id = ${scope.profileId})` : sql`o.brand_id = ${scope.profileId}`;
    const attributedOwner = creator ? sql`oi.source_creator_id = ${scope.profileId}` : sql`true`;
    const captured = creator ? sql`a.amount` : sql`c.amount`;
    const returned = creator ? sql`r.merchandise` : sql`r.amount`;
    const returning = creator ? sql`r.pending_merchandise` : sql`r.pending_amount`;
    return sql`
      with captures as (
        select o.id, o.currency, o.created_at, o.total_amount as amount, o.subtotal_amount, s.live_mode,
          p.status as payment_status,
          (p.amount <> o.total_amount or p.currency <> o.currency or o.total_amount < ${FINANCE.zero}
            or (s.payment_id is not null and (s.charge_amount<>p.amount or s.charge_currency<>p.currency))) as invalid
        from ${orders} o join ${payments} p on p.order_id = o.id
          and p.provider = ${ORDER_PAYMENT.provider} and p.provider_payment_intent_id = o.stripe_payment_intent_id
          and p.status in (${ORDER_PAYMENT.status.succeeded}, ${ORDER_PAYMENT.status.refunded})
        left join ${paymentSettlements} s on s.payment_id=p.id
        where o.payment_provider = ${ORDER_PAYMENT.provider} and ${owner}
      ), attributed as (
        select oi.order_id, coalesce(sum(oi.total_price) filter (where ${attributedOwner}), ${FINANCE.zero}) as amount,
          sum(oi.total_price) as full_amount,
          count(*) filter (where oi.quantity < ${FINANCE.single} or oi.unit_price < ${FINANCE.zero} or oi.total_price::bigint <> oi.quantity::bigint * oi.unit_price) as invalid_count
        from ${orderItems} oi join captures c on c.id = oi.order_id group by oi.order_id
      ), return_money as (
        select rf.order_id,sum(rf.amount) as amount,bool_or(rf.invalid) as invalid
        from ${returnRefundFinancialFacts} rf join captures c on c.id=rf.order_id group by rf.order_id
      ), return_pieces as (
        select rr.order_id,
          coalesce(sum(ri.quantity::bigint * oi.unit_price) filter (where rr.status = ${RETURN_STATUS.refunded}), ${FINANCE.zero})::bigint as merchandise,
          coalesce(sum(ri.quantity::bigint * oi.unit_price) filter (where rr.status in (${sql.join(needsRefund.map(value => sql`${value}`), sql`, `)})), ${FINANCE.zero})::bigint as pending_merchandise
        from ${orderReturns} rr join ${orderReturnItems} ri on ri.return_id = rr.id
        join ${orderItems} oi on oi.id = ri.order_item_id and oi.order_id = rr.order_id
        join captures c on c.id = rr.order_id where ${attributedOwner} group by rr.order_id
      ), return_pending as (
        select rr.order_id, sum(rr.total_amount)::bigint as amount from ${orderReturns} rr
        join captures c on c.id = rr.order_id
        where rr.status in (${sql.join(needsRefund.map(value => sql`${value}`), sql`, `)}) group by rr.order_id
      ), returned as (
        select c.id, coalesce(rm.invalid, false) as invalid, coalesce(rm.amount, ${FINANCE.zero}) as amount, coalesce(rp.merchandise, ${FINANCE.zero}) as merchandise,
          coalesce(rn.amount, ${FINANCE.zero}) as pending_amount, coalesce(rp.pending_merchandise, ${FINANCE.zero}) as pending_merchandise
        from captures c left join return_money rm on rm.order_id = c.id left join return_pieces rp on rp.order_id = c.id left join return_pending rn on rn.order_id = c.id
      ), facts as (
        select c.currency, c.live_mode, c.created_at, ${captured} as captured,
          ${returned} + case when oc.status = ${CANCELLATION.status.succeeded} and oc.payment_outcome in (${sql.join(cancelledRefundOutcomes.map(value=>sql`${value}`),sql`, `)}) then ${captured} else ${FINANCE.zero} end as refunded,
          ${returning} + case when oc.status = ${CANCELLATION.status.requested} then ${captured} else ${FINANCE.zero} end as pending,
          c.invalid or r.invalid or r.amount + r.pending_amount > c.amount or a.amount is null or a.amount < ${FINANCE.zero} or a.invalid_count > ${FINANCE.zero} or a.full_amount <> c.subtotal_amount
            or (oc.payment_outcome = ${CANCELLATION.outcome.refundedExternally} and (es.id is null or es.amount<>c.amount or es.currency<>c.currency or c.payment_status=${ORDER_PAYMENT.status.refunded}))
            or (es.id is not null and (oc.status<>${CANCELLATION.status.succeeded} or oc.payment_outcome<>${CANCELLATION.outcome.refundedExternally}))
            or (c.payment_status = ${ORDER_PAYMENT.status.refunded} and r.amount + case when oc.payment_outcome in (${sql.join(cancelledRefundOutcomes.map(value=>sql`${value}`),sql`, `)}) then c.amount else ${FINANCE.zero} end <> c.amount) as invalid
        from captures c left join attributed a on a.order_id = c.id join returned r on r.id = c.id left join ${orderCancellations} oc on oc.order_id = c.id
        left join ${refundOrganizationCases} ec on ec.cancellation_id=oc.id left join ${externalRefundSettlements} es on es.case_id=ec.id
      )`;
}

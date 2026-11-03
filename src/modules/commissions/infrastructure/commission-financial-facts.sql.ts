import {sql} from 'drizzle-orm';
import {commissions,creatorProfiles,brandProfiles,orderItems,orders,payments,shipments,orderReturns,orderReturnItems,orderCancellations,returnCommissionAdjustments} from '../../../shared/infrastructure/database/schema';
import {paymentSettlements} from '../../../shared/infrastructure/database/schema.payment-settlements';
import {FROZEN_ITEM} from '../../orders/infrastructure/frozen-order-item';
import {ORDER_COMMISSION, ORDER_STATUS, ORDER_PAYMENT, CANCELLATION} from '../../orders/domain/order-lifecycle';
import {ORDER_RETURN} from '../../orders/domain/order-return.contract';
import {COMMISSION_RELEASE as RELEASE, type CommissionFinancialScope} from '../domain/commission-release';
import {COMMISSION_ENTRY} from '../domain/commission-entry.contract';

const limits = {zero: 0, one: 1};
const statuses = Object.values(ORDER_COMMISSION.status);
const datedStatuses = [ORDER_COMMISSION.status.pending, ORDER_COMMISSION.status.validated];
const noDateStates = [RELEASE.state.estimated, RELEASE.state.awaitingDelivery, RELEASE.state.paid, RELEASE.state.cancelled];
const timestamp = COMMISSION_ENTRY.timestamp;
const values = (items: readonly string[]) => sql.join(items.map(value => sql`${value}`), sql`, `);

/** Live release facts: no cached validation can outlive a return or its dispute. */
export function commissionFinancialFacts(scope: CommissionFinancialScope) {
  const status = ORDER_COMMISSION.status;
  const owner = scope.kind === RELEASE.scope.creator ? sql`cm.creator_id=${scope.creatorId}` : sql`true`;
  return sql`with adjustments as (
    select ra.commission_id, sum(ra.amount)::bigint as amount from ${returnCommissionAdjustments} ra
    join ${commissions} cm on cm.id=ra.commission_id where ${owner} group by ra.commission_id
  ), commission_basis as (
    select cm.id,cm.order_item_id,cm.creator_id,cm.brand_id,cm.source_outfit_id,cm.created_at,cm.base_amount,cm.commission_rate,
      cm.status as raw_status,o.id as order_id,o.order_number,o.currency,ps.live_mode,o.status as order_status,o.commerce_snapshot,s.delivered_at,
      cp.display_name as creator_name,bp.brand_name,oi.quantity,oi.product_snapshot->>${FROZEN_ITEM.name} as product_name,
      cm.commission_amount::bigint as original,
      case when cm.status=${status.cancelled} then cm.commission_amount::bigint else coalesce(a.amount,${limits.zero}) end as adjusted,
      coalesce(a.amount,${limits.zero}) as returned,
      exists(select ${limits.one} from ${orderReturns} r join ${orderReturnItems} ri on ri.return_id=r.id
        where r.order_id=o.id and ri.order_item_id=oi.id and r.status not in (${values(ORDER_RETURN.terminalStatuses)})) as return_open,
      o.status=${ORDER_STATUS.cancelling} or exists(select ${limits.one} from ${orderCancellations} oc where oc.order_id=o.id and oc.status=${CANCELLATION.status.requested}) as cancellation_open,
      (cm.commission_amount<${limits.zero} or coalesce(a.amount,${limits.zero})<${limits.zero} or coalesce(a.amount,${limits.zero})>cm.commission_amount
        or cm.base_amount<${limits.zero} or cm.base_amount<>oi.total_price or cm.commission_rate<${limits.zero} or cm.commission_rate>${limits.one}
        or cm.commission_rate<>oi.commission_rate or cm.source_outfit_id is distinct from oi.source_outfit_id
        or cm.status not in (${values(statuses)}) or cm.brand_id<>o.brand_id or cm.creator_id is distinct from oi.source_creator_id
        or cp.id is null or bp.id is null or char_length(btrim(cp.display_name))<${limits.one} or char_length(btrim(bp.brand_name))<${limits.one}
        or char_length(btrim(o.order_number))<${limits.one} or oi.quantity<${limits.one}
        or jsonb_typeof(oi.product_snapshot->${FROZEN_ITEM.name}) is distinct from ${FROZEN_ITEM.jsonString}
        or char_length(btrim(oi.product_snapshot->>${FROZEN_ITEM.name}))<${limits.one}
        or (ps.payment_id is not null and (ps.charge_amount<>p.amount or ps.charge_currency<>p.currency))) as data_invalid
    from ${commissions} cm join ${orderItems} oi on oi.id=cm.order_item_id join ${orders} o on o.id=oi.order_id
    left join ${creatorProfiles} cp on cp.id=cm.creator_id left join ${brandProfiles} bp on bp.id=cm.brand_id
    left join ${shipments} s on s.order_id=o.id left join adjustments a on a.commission_id=cm.id
    left join ${payments} p on p.order_id=o.id and p.provider=${ORDER_PAYMENT.provider}
      and p.provider_payment_intent_id=o.stripe_payment_intent_id
    left join ${paymentSettlements} ps on ps.payment_id=p.id where ${owner}
  ), commission_terms as (
    select b.*,case when jsonb_typeof(commerce_snapshot->${RELEASE.snapshot.window})=${RELEASE.snapshot.number}
      and commerce_snapshot->>${RELEASE.snapshot.window} ~ ${RELEASE.windowPattern}
      then (commerce_snapshot->>${RELEASE.snapshot.window})::numeric end as return_days
    from commission_basis b
  ), commission_deadlines as (
    select t.*,extract(epoch from delivered_at)*${RELEASE.time.millisecondsPerSecond}+return_days*${ORDER_RETURN.time.dayMilliseconds} as due_milliseconds
    from commission_terms t
  ), commission_release as (
    select d.*,
      case when raw_status=${status.paid} then ${RELEASE.state.paid}
        when raw_status=${status.cancelled} or original=adjusted then ${RELEASE.state.cancelled}
        when raw_status=${status.estimated} then ${RELEASE.state.estimated}
        when cancellation_open then ${RELEASE.state.cancellationOpen}
        when return_open then ${RELEASE.state.returnOpen}
        when order_status<>${ORDER_STATUS.delivered} or delivered_at is null then ${RELEASE.state.awaitingDelivery}
        when extract(epoch from current_timestamp)*${RELEASE.time.millisecondsPerSecond}<=due_milliseconds then ${RELEASE.state.returnWindow}
        else ${RELEASE.state.payable} end as release_state,
      data_invalid or (raw_status in (${values(datedStatuses)}) and (
        return_days is null or return_days>${RELEASE.time.latestTimestamp/ORDER_RETURN.time.dayMilliseconds}
        or (order_status=${ORDER_STATUS.delivered} and delivered_at is null)
        or (delivered_at is not null and delivered_at>current_timestamp)
        or (due_milliseconds is not null and due_milliseconds>${RELEASE.time.latestTimestamp}))) as invalid
    from commission_deadlines d
  ), facts as (
    select r.*,
      case when release_state=${RELEASE.state.payable} then ${status.validated}
        when release_state=${RELEASE.state.paid} then ${status.paid}
        when release_state=${RELEASE.state.cancelled} then ${status.cancelled}
        when release_state=${RELEASE.state.estimated} then ${status.estimated} else ${status.pending} end as status,
      case when release_state not in (${values(noDateStates)}) and due_milliseconds between ${limits.zero} and ${RELEASE.time.latestTimestamp}
        then to_char(to_timestamp((due_milliseconds/${RELEASE.time.millisecondsPerSecond})::double precision) at time zone ${timestamp.zone},${timestamp.format})
        else null end as available_at
    from commission_release r
  )`;
}

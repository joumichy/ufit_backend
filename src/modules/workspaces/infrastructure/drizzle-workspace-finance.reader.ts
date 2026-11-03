import {returnRefundFinancialFacts,externalRefundSettlements} from '../../../shared/infrastructure/database/schema.refund-settlements';
import {refundOrganizationCases} from '../../../shared/infrastructure/database/schema.refund-organizations';
import type {WorkspacePage, WorkspacePageInput} from '../application/workspaces.service';
import {ConflictException} from '@nestjs/common';
import {sql} from 'drizzle-orm';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {orderCancellations, orderItems, orders, payments, orderReturns, orderReturnItems} from '../../../shared/infrastructure/database/schema';
import {CANCELLATION, ORDER_COMMISSION, ORDER_PAYMENT} from '../../orders/domain/order-lifecycle';
import {RETURN_STATUS} from '../../orders/domain/order-return.contract';
import {RETURN_REFUND_ATTEMPT} from '../../orders/domain/return-refund';
import {commissionFinancialFacts} from '../../commissions/infrastructure/commission-financial-facts.sql';
import {COMMISSION_RELEASE} from '../../commissions/domain/commission-release';
import {WORKSPACE_FINANCE as FINANCE, WORKSPACE_COMMISSION_FIELDS, requireWorkspaceProjection, workspaceInteger, workspaceSalesSchema, workspaceCommissionCurrencySchema, workspaceCommissionSchema,
  type WorkspaceFinanceScope, type WorkspaceSales, type WorkspaceCommissionCurrency, type WorkspaceCommission} from '../domain/workspace-finance';

const cancelledRefundOutcomes=[CANCELLATION.outcome.refunded,CANCELLATION.outcome.refundedExternally];
const needsRefund = [RETURN_STATUS.refundPending, RETURN_STATUS.refundFailed];


/** Aggregates each refund and each commission once before joining their owners. */
export class DrizzleWorkspaceFinanceReader {
  constructor(private readonly database: DatabaseSession) {}
  async sales(scope: WorkspaceFinanceScope): Promise<WorkspaceSales> {
    const creator = scope.kind === FINANCE.scope.creator;
    const owner = creator ? sql`exists (select ${FINANCE.single} from ${orderItems} oi where oi.order_id = o.id and oi.source_creator_id = ${scope.profileId})` : sql`o.brand_id = ${scope.profileId}`;
    const attributedOwner = creator ? sql`oi.source_creator_id = ${scope.profileId}` : sql`true`;
    const captured = creator ? sql`a.amount` : sql`c.amount`;
    const returned = creator ? sql`r.merchandise` : sql`r.amount`;
    const returning = creator ? sql`r.pending_merchandise` : sql`r.pending_amount`;
    const result = await this.database.db.execute(sql`
      with captures as (
        select o.id, o.currency, o.total_amount as amount, o.subtotal_amount,
          p.status as payment_status,
          (p.amount <> o.total_amount or p.currency <> o.currency or o.total_amount < ${FINANCE.zero}) as invalid
        from ${orders} o join ${payments} p on p.order_id = o.id
          and p.provider = ${ORDER_PAYMENT.provider} and p.provider_payment_intent_id = o.stripe_payment_intent_id
          and p.status in (${ORDER_PAYMENT.status.succeeded}, ${ORDER_PAYMENT.status.refunded})
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
        select c.currency, ${captured} as captured,
          ${returned} + case when oc.status = ${CANCELLATION.status.succeeded} and oc.payment_outcome in (${sql.join(cancelledRefundOutcomes.map(value=>sql`${value}`),sql`, `)}) then ${captured} else ${FINANCE.zero} end as refunded,
          ${returning} + case when oc.status = ${CANCELLATION.status.requested} then ${captured} else ${FINANCE.zero} end as pending,
          c.invalid or r.invalid or r.amount + r.pending_amount > c.amount or a.amount is null or a.amount < ${FINANCE.zero} or a.invalid_count > ${FINANCE.zero} or a.full_amount <> c.subtotal_amount
            or (oc.payment_outcome = ${CANCELLATION.outcome.refundedExternally} and (es.id is null or es.amount<>c.amount or es.currency<>c.currency or c.payment_status=${ORDER_PAYMENT.status.refunded}))
            or (es.id is not null and (oc.status<>${CANCELLATION.status.succeeded} or oc.payment_outcome<>${CANCELLATION.outcome.refundedExternally}))
            or (c.payment_status = ${ORDER_PAYMENT.status.refunded} and r.amount + case when oc.payment_outcome in (${sql.join(cancelledRefundOutcomes.map(value=>sql`${value}`),sql`, `)}) then c.amount else ${FINANCE.zero} end <> c.amount) as invalid
        from captures c left join attributed a on a.order_id = c.id join returned r on r.id = c.id left join ${orderCancellations} oc on oc.order_id = c.id
        left join ${refundOrganizationCases} ec on ec.cancellation_id=oc.id left join ${externalRefundSettlements} es on es.case_id=ec.id
      )
      select currency, count(*)::text as "capturedOrderCount", sum(captured)::text as "capturedAmount", sum(refunded)::text as "refundedAmount",
        sum(pending)::text as "refundInProgressAmount", (sum(captured) - sum(refunded))::text as "netAmount",
        count(*) filter (where invalid or captured < ${FINANCE.zero} or refunded < ${FINANCE.zero} or pending < ${FINANCE.zero} or refunded + pending > captured)::text as "invalidCount"
      from facts group by currency order by currency
    `);
    const currencies = result.rows.map(row => {
      if (workspaceInteger(row.invalidCount) !== FINANCE.zero) throw new ConflictException(FINANCE.failure.persisted);
      return {currency: row.currency, capturedOrderCount: workspaceInteger(row.capturedOrderCount), capturedAmount: workspaceInteger(row.capturedAmount),
        refundedAmount: workspaceInteger(row.refundedAmount), refundInProgressAmount: workspaceInteger(row.refundInProgressAmount), netAmount: workspaceInteger(row.netAmount)};
    });
    return requireWorkspaceProjection(workspaceSalesSchema, {basis: creator ? FINANCE.basis.attributedMerchandise : FINANCE.basis.orderTotal, currencies});
  }
  async creatorCommissions(creatorId: string): Promise<WorkspaceCommissionCurrency[]> {
    const status = ORDER_COMMISSION.status;
    const result = await this.database.db.execute(sql`
      ${commissionFinancialFacts({kind: COMMISSION_RELEASE.scope.creator, creatorId})}
      select currency, sum(original)::text as "originalAmount", sum(adjusted)::text as "adjustedAmount", sum(original - adjusted)::text as "netAmount",
        coalesce(sum(original - adjusted) filter (where status = ${status.estimated}), ${FINANCE.zero})::text as "estimatedAmount",
        coalesce(sum(original - adjusted) filter (where status = ${status.pending}), ${FINANCE.zero})::text as "pendingAmount",
        coalesce(sum(original - adjusted) filter (where status = ${status.validated}), ${FINANCE.zero})::text as "validatedAmount",
        coalesce(sum(original) filter (where status = ${status.paid}), ${FINANCE.zero})::text as "paidAmount",
        coalesce(sum(returned) filter (where status = ${status.paid}), ${FINANCE.zero})::text as "paidAdjustmentAmount",
        count(*) filter (where status = ${status.estimated})::text as "estimatedCount", count(*) filter (where status = ${status.pending})::text as "pendingCount",
        count(*) filter (where status = ${status.validated})::text as "validatedCount", count(*) filter (where status = ${status.paid})::text as "paidCount",
        count(*) filter (where status = ${status.cancelled})::text as "cancelledCount", count(*) filter (where invalid)::text as "invalidCount"
      from facts group by currency order by currency
    `);
    return result.rows.map(row => {
      if (workspaceInteger(row.invalidCount) !== FINANCE.zero) throw new ConflictException(FINANCE.failure.persisted);
      const amounts = Object.fromEntries(WORKSPACE_COMMISSION_FIELDS.map(key => [key, workspaceInteger(row[key])]));
      return requireWorkspaceProjection(workspaceCommissionCurrencySchema, {currency: row.currency, ...amounts});
    });
  }
  async commissionPage(creatorId: string, page: Required<WorkspacePageInput>): Promise<WorkspacePage<WorkspaceCommission>> {
    const facts = commissionFinancialFacts({kind: COMMISSION_RELEASE.scope.creator, creatorId});
    const totals = await this.database.db.execute(sql`${facts} select count(*)::text as total, count(*) filter (where invalid)::text as invalid from facts`);
    if (workspaceInteger(totals.rows[FINANCE.zero].invalid) !== FINANCE.zero) throw new ConflictException(FINANCE.failure.persisted);
    const total = workspaceInteger(totals.rows[FINANCE.zero].total);
    const result = await this.database.db.execute(sql`${facts}
      select id, order_item_id as "orderItemId", brand_id as "brandId", source_outfit_id as "sourceOutfitId", status, currency, release_state as "releaseState", available_at as "availableAt",
        base_amount::text as "baseAmount", (commission_rate * ${FINANCE.basisPoints})::integer::text as "rateBps",
        original::text as "originalAmount", adjusted::text as "adjustedAmount", (original - adjusted)::text as "netAmount",
        (case when status = ${ORDER_COMMISSION.status.paid} then returned else ${FINANCE.zero} end)::text as "paidAdjustmentAmount", to_char(created_at at time zone ${FINANCE.timestamp.zone}, ${FINANCE.timestamp.format}) as "createdAt"
      from facts order by created_at desc, id desc limit ${page.limit} offset ${page.offset}`);
    const items = result.rows.map(row => requireWorkspaceProjection(workspaceCommissionSchema, {
      id: row.id, orderItemId: row.orderItemId, brandId: row.brandId, sourceOutfitId: row.sourceOutfitId, status: row.status, currency: row.currency,
      baseAmount: workspaceInteger(row.baseAmount), rateBps: workspaceInteger(row.rateBps), originalAmount: workspaceInteger(row.originalAmount),
      adjustedAmount: workspaceInteger(row.adjustedAmount), netAmount: workspaceInteger(row.netAmount), paidAdjustmentAmount: workspaceInteger(row.paidAdjustmentAmount),
      release: {state: row.releaseState, availableAt: row.availableAt}, createdAt: row.createdAt,
    }));
    const next = page.offset + items.length;
    return {items, page: {...page, total, nextOffset: next < total ? next : null}};
  }

}
